/*
 * Battery Health Forecast + Ready-by-Ride charging: core.
 *
 * 1. Semi-empirical Li-ion aging (Schmalstieg et al. 2014, NMC): calendar loss = a(V,T) * t^0.75,
 *    cycle loss = b(Vavg, DoD) * sqrt(Ah); time-varying stress handled with the equivalent-time method.
 * 2. Rider-specific scale k fitted (grid posterior) from noisy state-of-health readings taken at charge sessions.
 * 3. Split-conformal calibration of the forecast band on simulated riders whose true aging deviates from the model.
 * 4. Ready-by-ride planner: hold at 80% overnight, top up so charging ends before the 5th percentile of the
 *    rider's own departure times for that kind of day.
 *
 * Browser: window.AlsoBattery. Node: module.exports.
 */
(function (root) {
  'use strict';
  var DT = 0.25;                 // hours per step
  var STEPS_DAY = 24 / DT;
  var BATT = { wh: 522, cellAh: 3.0, rate80: 80 / 1.8, rateTop: 20 / 0.5 };   // % per hour, Standard battery spec (0-80% 1.8 h, 0-100% 2.3 h)

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) { var u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }
  function quantile(arr, q) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    if (!s.length) return NaN;
    var p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return s[lo] + (s[hi] - s[lo]) * (p - lo);
  }

  // ---------- aging model ----------
  function ocv(soc) { return 3.45 + 0.75 * soc; }                     // simplified NMC open-circuit voltage, soc in 0..1
  function calRate(soc, tempC) {                                         // per day^0.75
    var V = ocv(soc), T = tempC + 273.15;
    return Math.max(0, (7.543 * V - 23.75) * 1e6 * Math.exp(-6976 / T));
  }
  function cycRate(vAvg, dod) { return 7.348e-3 * Math.pow(vAvg - 3.667, 2) + 7.6e-4 + 4.081e-3 * dod; }   // per sqrt(Ah)

  // ---------- rider ----------
  /* A rider = deterministic schedule from a seed: departure times, ride energy, plug-in habits, garage temperature. */
  function makeRider(seed, opts) {
    opts = opts || {};
    var rng = mulberry32(seed);
    var r = {
      seed: seed,
      commuteH: 7.0 + (opts.commuteShift != null ? opts.commuteShift : (rng() - 0.5) * 1.6) + 0.33,
      commuteSd: 0.12 + rng() * 0.15,
      wfh: 0.15 + rng() * 0.15,
      rideWh: 70 + rng() * 60,
      weekendP: 0.4 + rng() * 0.4,
      plugH: 20.5 + rng() * 1.5,
      plugP: 0.8 + rng() * 0.15,
      garageC: 15 + rng() * 8,
      days: opts.days || 365 * 3
    };
    // pre-draw the day-by-day schedule
    var sched = [];
    for (var d = 0; d < r.days; d++) {
      var dow = (d + 2) % 7;                        // day 0 = Tuesday (Jul 7 2026)
      var weekend = dow === 5 || dow === 6;
      var rides = [];
      if (!weekend) {
        if (rng() > r.wfh) {
          var dep = r.commuteH + r.commuteSd * gauss(rng);
          rides.push({ t: dep, wh: r.rideWh * (0.85 + 0.3 * rng()), dur: 0.6 });
          rides.push({ t: 17.6 + 0.4 * gauss(rng), wh: r.rideWh * (0.85 + 0.35 * rng()), dur: 0.65 });
        } else { rng(); rng(); rng(); rng(); }
      } else {
        if (rng() < r.weekendP) rides.push({ t: 10.5 + 1.4 * gauss(rng), wh: 120 + 160 * rng(), dur: 1.4 });
        else { rng(); rng(); }
      }
      var season = Math.cos(2 * Math.PI * (d - 20) / 365);             // day 0 near mid-summer
      sched.push({ dow: dow, weekend: weekend, rides: rides, plug: rng() < r.plugP, plugAt: r.plugH + 0.6 * gauss(rng),
        tAmb: 14 + 6 * season, tGarage: r.garageC + 4 * season });
    }
    r.sched = sched;
    return r;
  }

  /*
   * Planner: given past departures (first ride of the day) for the same kind of day, the top-up must finish by
   * the q-quantile of departure time minus a buffer. Returns hour-of-day or null (no ride expected).
   */
  function planFinish(history, weekend, q, buffer) {
    var same = history.filter(function (h) { return h.weekend === weekend; }).slice(-24);
    if (same.length < 6) return 6.0;                               // cold start: assume an early ride
    var deps = same.filter(function (h) { return h.dep != null; }).map(function (h) { return h.dep; });
    var pRide = deps.length / same.length;
    if (pRide < 0.35) return null;                                  // usually no ride: stay at 80% (user can tap "Charge now")
    return quantile(deps, q) - buffer;
  }

  /*
   * Simulate SoC and aging stress for a rider under a policy ('habit' = charge to 100% on plug-in,
   * 'ready' = hold 80% and top up before the predicted departure).
   * Returns per-day stress accumulators with k=1 (loss is linear in k), plus readiness stats.
   */
  function simulate(rider, policy, opts) {
    opts = opts || {};
    var q = opts.q != null ? opts.q : 0.05, buffer = opts.buffer != null ? opts.buffer : 1 / 6;
    var soc = 0.9, calLoss = 0, cycLoss = 0, tCalEq = 0, ahTot = 0;
    var days = rider.sched.length, out = { cal: new Float64Array(days + 1), cyc: new Float64Array(days + 1), soc: [], deps: [] };
    var hist = [], hiTime = 0, plugged = false;
    var vSum = 0, vN = 0, ahPrev = 0;
    for (var d = 0; d < days; d++) {
      var day = rider.sched[d], rides = day.rides.slice().sort(function (a, b) { return a.t - b.t; });
      var finishToday = policy === 'ready' ? planFinish(hist, day.weekend, q, buffer) : null;
      var topDur = 0.2 * 100 / BATT.rateTop;
      var ri = 0, riding = 0, rideDrain = 0, minSoc = soc;
      for (var s = 0; s < STEPS_DAY; s++) {
        var h = s * DT;
        // ride start
        if (ri < rides.length && h >= rides[ri].t && riding <= 0) {
          var rd = rides[ri];
          if (ri === 0) out.deps.push({ day: d, weekend: day.weekend, socAtDep: soc, planned: policy === 'ready' });
          plugged = false; riding = rd.dur; rideDrain = rd.wh / BATT.wh / (rd.dur / DT); ri++;
        }
        var temp = day.tGarage;
        if (riding > 0) {
          var drop = Math.min(soc - 0.03, rideDrain);
          soc -= drop; ahTot += drop * BATT.cellAh; riding -= DT; temp = day.tAmb + 4;
          if (soc < minSoc) minSoc = soc;
        } else if (!plugged && day.plug && h >= day.plugAt && h < day.plugAt + DT && soc < 0.97) {
          plugged = true;
        }
        if (plugged && riding <= 0) {
          var target = 1.0;
          if (policy === 'ready') {
            target = 0.8;
            if (finishToday != null && h < 12 && h >= finishToday - topDur) target = 1.0;
          }
          if (soc < target) {
            var rate = (soc < 0.8 ? BATT.rate80 : BATT.rateTop) / 100 * DT;
            var add = Math.min(target - soc, rate);
            soc += add; ahTot += add * BATT.cellAh; temp += 5;
          }
        }
        if (soc > 0.9) hiTime += DT;
        // calendar aging with equivalent time
        var a = calRate(soc, temp);
        if (a > 0) {
          tCalEq = Math.pow(calLoss / a, 1 / 0.75);
          calLoss = a * Math.pow(tCalEq + DT / 24, 0.75);
        }
        vSum += ocv(soc); vN++;
      }
      // cycle aging, equivalent-throughput method: today's stress applied to today's Ah
      var dayAh = ahTot - ahPrev, bDay = cycRate(vSum / vN, Math.max(0, 1 - minSoc));
      if (dayAh > 0) { var qEq = Math.pow(cycLoss / bDay, 2); cycLoss = bDay * Math.sqrt(qEq + dayAh); }
      ahPrev = ahTot; vSum = 0; vN = 0;
      out.cal[d + 1] = calLoss; out.cyc[d + 1] = cycLoss;
      var firstDep = rides.length ? rides[0].t : null;
      hist.push({ weekend: day.weekend, dep: firstDep });
    }
    out.hiHoursPerDay = hiTime / days;
    var dd = out.deps;
    out.readyRate = dd.length ? dd.filter(function (x) { return x.socAtDep >= 0.98; }).length / dd.length : 1;
    return out;
  }

  // ---------- fitting ----------
  var KGRID = (function () { var g = []; for (var i = 0; i <= 160; i++) g.push(Math.exp(-1.2 + 2.4 * i / 160)); return g; })();
  /* readings: [{day, soh}] ; path: simulate() output ; returns grid posterior over k (prior lognormal(0, 0.3)) */
  function fitK(readings, path, sigma) {
    sigma = sigma || 0.012;
    var logw = KGRID.map(function (k) {
      var lk = Math.log(k), lp = -lk * lk / (2 * 0.09);
      readings.forEach(function (r) {
        var pred = 1 - k * (path.cal[r.day] + path.cyc[r.day]);
        lp += -Math.pow(r.soh - pred, 2) / (2 * sigma * sigma);
      });
      return lp;
    });
    var m = Math.max.apply(null, logw), w = logw.map(function (x) { return Math.exp(x - m); }), Z = w.reduce(function (s, x) { return s + x; }, 0);
    w = w.map(function (x) { return x / Z; });
    var mean = 0, m2 = 0;
    KGRID.forEach(function (k, i) { mean += w[i] * k; m2 += w[i] * k * k; });
    return { grid: KGRID, w: w, mean: mean, sd: Math.sqrt(Math.max(0, m2 - mean * mean)) };
  }
  function forecast(post, path, day) {
    var L = path.cal[day] + path.cyc[day];
    return { mean: 1 - post.mean * L, sd: post.sd * L };
  }

  /* True aging of a simulated rider deviates from the model: separate random multipliers on calendar and cycle loss. */
  function truthFor(seed) {
    var rng = mulberry32(seed ^ 0x9e3779b9);
    var k = Math.exp(0.3 * gauss(rng)), u = Math.exp(0.2 * gauss(rng)), v = Math.exp(0.2 * gauss(rng));
    return { k: k, u: u, v: v };
  }
  function trueSoh(tr, path, day) { return 1 - tr.k * (tr.u * path.cal[day] + tr.v * path.cyc[day]); }
  function readingsFor(seed, tr, path, nDays, every) {
    var rng = mulberry32(seed + 77), out = [];
    for (var d = every; d <= nDays; d += every) out.push({ day: d, soh: trueSoh(tr, path, d) + 0.012 * gauss(rng) });
    return out;
  }

  /*
   * Split conformal: for each simulated rider, observe nDays of readings, forecast SoH at horizon, score |y - mean| / sd.
   * The band multiplier is the ceil((n+1)(1-alpha))/n empirical quantile of calibration scores.
   */
  function conformal(nCal, nTest, seed, nDays, horizon, alpha) {
    function scoreRider(s) {
      var rider = makeRider(s, { days: horizon });
      var path = simulate(rider, 'habit');
      var tr = truthFor(s), rd = readingsFor(s, tr, path, nDays, 4);
      var post = fitK(rd, path), f = forecast(post, path, horizon);
      var sd = Math.max(f.sd, 0.004);
      return { score: Math.abs(trueSoh(tr, path, horizon) - f.mean) / sd, f: f, sd: sd, y: trueSoh(tr, path, horizon), naiveCover: Math.abs(trueSoh(tr, path, horizon) - f.mean) <= 1.2816 * sd };
    }
    var cal = [], test = [];
    for (var i = 0; i < nCal; i++) cal.push(scoreRider(seed + i));
    for (var j = 0; j < nTest; j++) test.push(scoreRider(seed + 100000 + j));
    var scores = cal.map(function (c) { return c.score; }).sort(function (a, b) { return a - b; });
    var idx = Math.min(scores.length - 1, Math.ceil((nCal + 1) * (1 - alpha)) - 1);
    var qhat = scores[idx];
    var cover = test.filter(function (t) { return t.score <= qhat; }).length / nTest;
    var naive = test.filter(function (t) { return t.naiveCover; }).length / nTest;
    var width = quantile(test.map(function (t) { return 2 * qhat * t.sd; }), 0.5);
    return { qhat: qhat, coverage: cover, naiveCoverage: naive, medianWidth: width, nCal: nCal, nTest: nTest };
  }

  /* Same as conformal() but for several horizons from one 3-year simulation per rider. */
  function conformalMulti(nCal, nTest, seed, nDays, horizons, alpha) {
    var H = Math.max.apply(null, horizons);
    function rider(s) {
      var r = makeRider(s, { days: H }), path = simulate(r, 'habit'), tr = truthFor(s);
      var post = fitK(readingsFor(s, tr, path, nDays, 4), path);
      return horizons.map(function (h) {
        var f = forecast(post, path, h), sd = Math.max(f.sd, 0.004), y = trueSoh(tr, path, h);
        return { score: Math.abs(y - f.mean) / sd, sd: sd, naive: Math.abs(y - f.mean) <= 1.2816 * sd };
      });
    }
    var cal = [], test = [];
    for (var i = 0; i < nCal; i++) cal.push(rider(seed + i));
    for (var j = 0; j < nTest; j++) test.push(rider(seed + 100000 + j));
    return horizons.map(function (h, hi) {
      var sc = cal.map(function (c) { return c[hi].score; }).sort(function (a, b) { return a - b; });
      var qhat = sc[Math.min(sc.length - 1, Math.ceil((nCal + 1) * (1 - alpha)) - 1)];
      return { horizon: h, qhat: qhat,
        coverage: test.filter(function (t) { return t[hi].score <= qhat; }).length / nTest,
        naiveCoverage: test.filter(function (t) { return t[hi].naive; }).length / nTest,
        medianWidth: quantile(test.map(function (t) { return 2 * qhat * t[hi].sd; }), 0.5), nCal: nCal, nTest: nTest };
    });
  }

  var api = { conformalMulti: conformalMulti, mulberry32: mulberry32, quantile: quantile, ocv: ocv, calRate: calRate, cycRate: cycRate, makeRider: makeRider,
    planFinish: planFinish, simulate: simulate, fitK: fitK, forecast: forecast, truthFor: truthFor, trueSoh: trueSoh,
    readingsFor: readingsFor, conformal: conformal, BATT: BATT, DT: DT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AlsoBattery = api;
})(this);
