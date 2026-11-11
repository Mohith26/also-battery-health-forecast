(function () {
  'use strict';
  var B = window.AlsoBattery, C = window.ALSO_CFG;
  function $(id) { return document.getElementById(id); }
  var DAY = 86400000;
  function dateOf(d) { return new Date(Date.parse(C.startDate) + d * DAY); }
  function fmtDate(d) { return dateOf(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  function p1(x) { return (100 * x).toFixed(1); }
  function p0(x) { return Math.round(100 * x); }

  // ----- the rider and the fit -----
  var seed = C.riderSeed, now = C.observedDays;
  var rider = B.makeRider(seed);
  var path = B.simulate(rider, 'habit');
  var truth = B.truthFor(seed);
  var readings = B.readingsFor(seed, truth, path, now, C.readingEvery);
  var post = B.fitK(readings, path);
  // what-if paths (same fitted k; aging is linear in k)
  var cool = B.makeRider(seed); cool.sched.forEach(function (d) { d.tGarage -= 5; });
  var paths = {
    base: path,
    ready: B.simulate(rider, 'ready'),
    cool: B.simulate(cool, 'habit'),
    both: B.simulate(cool, 'ready')
  };
  var state = { h: 1095, ready: false, cool: false, conf: null };

  $('riderMeta').textContent = 'WEEKDAY COMMUTER · DAY ' + now + ' · ' + fmtDate(now).toUpperCase();
  var fNow = B.forecast(post, path, now);
  $('sohNow').textContent = p0(fNow.mean);
  $('sohNowBand').textContent = '± ' + Math.max(0.5, 1.2816 * fNow.sd * 100).toFixed(1) + ' · FROM ' + readings.length + ' CHARGE SESSIONS';

  function qhatFor(h) {
    if (!state.conf) return null;
    var hs = state.conf, i = 0;
    if (h <= hs[0].horizon) return hs[0].qhat;
    for (i = 0; i < hs.length - 1; i++) if (h <= hs[i + 1].horizon) {
      var w = (h - hs[i].horizon) / (hs[i + 1].horizon - hs[i].horizon);
      return hs[i].qhat * (1 - w) + hs[i + 1].qhat * w;
    }
    return hs[hs.length - 1].qhat;
  }
  function band(pth, h) {
    var f = B.forecast(post, pth, h), q = qhatFor(h), sd = Math.max(f.sd, 0.004 * Math.min(1, h / 365));
    var m = q == null ? 1.2816 : q;
    return { mean: f.mean, lo: f.mean - m * sd, hi: f.mean + m * sd, calibrated: q != null };
  }

  function renderPhone1() {
    var b = band(path, state.h), yrs = state.h / 365;
    $('fcK').textContent = 'HEALTH IN ' + yrs + ' YEAR' + (yrs > 1 ? 'S' : '') + (b.calibrated ? ' · 80% BAND' : ' · CALIBRATING…');
    $('fcV').textContent = p0(b.lo) + '–' + p0(b.hi) + '%';
    $('rngNow').textContent = Math.round(C.specRangeMi * fNow.mean) + ' mi today';
    $('rngH').textContent = Math.round(C.specRangeMi * b.lo) + '–' + Math.round(C.specRangeMi * b.hi) + ' mi';
    $('rngNow').title = 'today';
    // chart
    var W = 300, H = 130, L = 2, R = 2, T = 6, Bm = 6, ymin = 0.72, ymax = 1.0;
    var x = function (d) { return L + (W - L - R) * d / 1095; }, y = function (v) { return T + (H - T - Bm) * (1 - (v - ymin) / (ymax - ymin)); };
    var s = '';
    [0.8, 0.9].forEach(function (v) { s += '<line x1="0" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#e7e7e7"/><text x="' + (W - 2) + '" y="' + (y(v) - 3) + '" font-size="9" text-anchor="end" fill="#8a8a8a" font-family="Space Mono">' + Math.round(v * 100) + '%</text>'; });
    var up = [], dn = [], mid = [];
    for (var d = now; d <= 1095; d += 15) { var bb = band(path, d); up.push(x(d) + ',' + y(bb.hi)); dn.unshift(x(d) + ',' + y(bb.lo)); mid.push(x(d) + ',' + y(bb.mean)); }
    var hist = []; for (var d2 = 0; d2 <= now; d2 += 4) hist.push(x(d2) + ',' + y(B.forecast(post, path, d2).mean));
    s += '<polygon points="' + up.concat(dn).join(' ') + '" fill="#b1ff8e" stroke="#111" stroke-width="1"/>';
    s += '<polyline points="' + hist.join(' ') + '" fill="none" stroke="#111" stroke-width="2.2"/>';
    s += '<polyline points="' + mid.join(' ') + '" fill="none" stroke="#111" stroke-width="1.4" stroke-dasharray="4 3"/>';
    var bh = band(path, state.h);
    s += '<line x1="' + x(state.h) + '" x2="' + x(state.h) + '" y1="' + y(bh.hi) + '" y2="' + y(bh.lo) + '" stroke="#5e75ff" stroke-width="3"/>';
    s += '<circle cx="' + x(now) + '" cy="' + y(fNow.mean) + '" r="4.5" fill="#5e75ff" stroke="#111" stroke-width="1.5"/>';
    $('fcChart').innerHTML = s;
  }

  function renderPhone2() {
    var k = post.mean, cyc = k * path.cyc[1095], cal = k * path.cal[1095], tot = cyc + cal;
    $('stack').innerHTML = '<div style="width:' + (100 * cyc / tot) + '%;background:#b1ff8e;border-right:1.8px solid #111"></div><div style="width:' + (100 * cal / tot) + '%;background:#ac74fb"></div>';
    $('stackLeg').innerHTML = '<span><span><i style="background:#b1ff8e"></i>Riding and charging</span><b class="mono">' + p1(cyc) + ' pts</b></span>' +
      '<span><span><i style="background:#ac74fb"></i>Time parked (charge level, heat)</span><b class="mono">' + p1(cal) + ' pts</b></span>';
    var base = B.forecast(post, path, 1095).mean;
    var gR = B.forecast(post, paths.ready, 1095).mean - base, gC = B.forecast(post, paths.cool, 1095).mean - base;
    var items = [
      { key: 'ready', t: 'Ready-by-ride charging', s: 'Hold at 80% overnight, finish to 100% before your usual departure (' + rideTime() + ')', g: gR },
      { key: 'cool', t: 'Charge and park indoors', s: 'About 5°C cooler than your garage', g: gC }
    ];
    $('whatif').innerHTML = items.map(function (it) {
      return '<div class="wi' + (state[it.key] ? ' on' : '') + '" data-k="' + it.key + '"><span class="tx">' + it.t + '<small>' + it.s + '</small></span><span class="gain">+' + p1(it.g) + '</span><span class="tg"></span></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.wi'), function (el) {
      el.onclick = function () { state[el.getAttribute('data-k')] = !state[el.getAttribute('data-k')]; renderPhone2(); };
    });
    var pk = state.ready && state.cool ? 'both' : state.ready ? 'ready' : state.cool ? 'cool' : 'base';
    var b = band(paths[pk], 1095);
    $('resV').textContent = p0(b.lo) + '–' + p0(b.hi) + '%';
    var ready = paths[pk].readyRate;
    $('resS').textContent = (pk === 'base' ? 'YOUR CURRENT HABITS' : '+' + p1(b.mean - base) + ' PTS VS TODAY') + ' · FULL AT ' + Math.round(ready * 100) + '% OF DEPARTURES';
  }
  function rideTime() {
    var deps = path.deps.filter(function (d) { return !d.weekend && d.day < now; }).map(function (d) { return rider.sched[d.day].rides[0].t; });
    var q = B.quantile(deps, 0.05) - 1 / 6, h = Math.floor(q), m = Math.round((q - h) * 60);
    return 'done by ' + h + ':' + (m < 10 ? '0' : '') + m + ' AM';
  }

  function renderPhone3() {
    $('basis').textContent = now + ' DAYS · ' + readings.length + ' HEALTH READINGS';
    $('howBody').textContent = 'Your forecast blends a battery aging model with the health readings your TM-B takes while charging. We tested the 80% band on simulated riders whose batteries age differently from the model, and widened it until it held.';
    if (!state.conf) return;
    var c = state.conf.filter(function (x) { return x.horizon === state.h; })[0] || state.conf[state.conf.length - 1];
    function bar(label, v, color) {
      return '<div class="cbar"><span>' + label + '</span><b>' + Math.round(v * 100) + '%</b><span class="tr"><i style="width:' + (v * 100) + '%;background:' + color + '"></i><em style="left:80%"></em></span></div>';
    }
    $('calib').innerHTML = '<div class="mono sk">' + (c.horizon / 365) + '-YEAR BAND HELD FOR · ' + c.nTest + ' TEST RIDERS · TARGET 80%</div>' +
      bar('Calibrated band (this app)', c.coverage, '#b1ff8e') + bar('Model-only band', c.naiveCoverage, '#e7e7e7') +
      '<div class="mono sk">BAND WIDTH ±' + (50 * c.medianWidth).toFixed(1) + ' PTS (MEDIAN)</div>';
  }

  function renderFit() {
    var W = 560, H = 190, L = 34, R = 8, T = 8, Bm = 22, D = 365, ymin = 0.86, ymax = 1.005;
    var x = function (d) { return L + (W - L - R) * d / D; }, y = function (v) { return T + (H - T - Bm) * (1 - (v - ymin) / (ymax - ymin)); };
    var s = '';
    for (var v = 0.88; v <= 1.0001; v += 0.04) s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#e8cdb3"/><text x="' + (L - 5) + '" y="' + (y(v) + 3) + '" font-size="10" text-anchor="end" font-family="Space Mono">' + Math.round(v * 100) + '%</text>';
    [0, 90, 180, 270, 365].forEach(function (d) { s += '<text x="' + x(d) + '" y="' + (H - 6) + '" font-size="10" text-anchor="middle" font-family="Space Mono">' + (d === 0 ? 'JUL 7' : 'DAY ' + d) + '</text>'; });
    s += '<line x1="' + x(now) + '" x2="' + x(now) + '" y1="' + T + '" y2="' + (H - Bm) + '" stroke="#111" stroke-dasharray="3 3"/><text x="' + (x(now) + 4) + '" y="' + (T + 10) + '" font-size="10" font-family="Space Mono">TODAY</text>';
    var up = [], dn = [];
    for (var d = now; d <= D; d += 5) { var b = band(path, d); up.push(x(d) + ',' + y(b.hi)); dn.unshift(x(d) + ',' + y(b.lo)); }
    s += '<polygon points="' + up.concat(dn).join(' ') + '" fill="#b1ff8e" stroke="none"/>';
    var fit = []; for (var d3 = 0; d3 <= D; d3 += 3) fit.push(x(d3) + ',' + y(B.forecast(post, path, d3).mean));
    s += '<polyline points="' + fit.join(' ') + '" fill="none" stroke="#111" stroke-width="1.8"/>';
    readings.forEach(function (r) { s += '<circle cx="' + x(r.day) + '" cy="' + y(r.soh) + '" r="3" fill="#ac74fb" stroke="#111" stroke-width="1"/>'; });
    var tr = []; for (var d4 = 0; d4 <= D; d4 += 5) tr.push(x(d4) + ',' + y(B.trueSoh(truth, path, d4)));
    s += '<polyline points="' + tr.join(' ') + '" fill="none" stroke="#5e75ff" stroke-width="1.4" stroke-dasharray="5 3"/>';
    $('fitChart').innerHTML = s;
    $('fitNote').innerHTML = 'Purple dots: health readings (±1.2 pt noise). Black: fitted model, k = ' + post.mean.toFixed(2) + ' ± ' + post.sd.toFixed(2) +
      '. Blue dashed: the simulated battery\'s true health (k = ' + truth.k.toFixed(2) + ', calendar ×' + truth.u.toFixed(2) + ', cycle ×' + truth.v.toFixed(2) + '), which the app never sees. Green: calibrated 80% band.';
  }

  function renderAll() { renderPhone1(); renderPhone2(); renderPhone3(); renderFit(); }
  $('hzSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    Array.prototype.forEach.call($('hzSeg').children, function (x) { x.classList.toggle('on', x === b); });
    state.h = Number(b.getAttribute('data-h')); renderPhone1(); renderPhone3();
  });
  renderAll();
  setTimeout(function () {
    var c = C.conformal;
    state.conf = B.conformalMulti(c.nCal, c.nTest, c.seed, now, c.horizons, c.alpha);
    renderAll();
  }, 30);
})();
