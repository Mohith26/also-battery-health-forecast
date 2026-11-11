'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('../core/battery.js');
const C = require('../data/rider.js');

test('calendar aging rate rises with state of charge and temperature', () => {
  assert.ok(B.calRate(1.0, 25) > B.calRate(0.8, 25));
  assert.ok(B.calRate(0.8, 35) > 2 * B.calRate(0.8, 25));
  assert.ok(B.cycRate(3.9, 0.8) > B.cycRate(3.9, 0.3));
});

test('simulation is deterministic and loss accumulates monotonically', () => {
  const r1 = B.makeRider(7, { days: 400 }), r2 = B.makeRider(7, { days: 400 });
  const a = B.simulate(r1, 'habit'), b = B.simulate(r2, 'habit');
  assert.deepStrictEqual(Array.from(a.cal), Array.from(b.cal));
  for (let d = 1; d <= 400; d++) assert.ok(a.cal[d] >= a.cal[d - 1] - 1e-12 && a.cyc[d] >= a.cyc[d - 1] - 1e-12);
});

test('ready-by-ride spends far less time above 90% and never ages faster', () => {
  const r = B.makeRider(7, { days: 730 });
  const h = B.simulate(r, 'habit'), s = B.simulate(r, 'ready');
  assert.ok(s.hiHoursPerDay < 0.7 * h.hiHoursPerDay, h.hiHoursPerDay + ' vs ' + s.hiHoursPerDay);
  assert.ok(s.cal[730] <= h.cal[730]);
});

test('k posterior recovers the scale when the model is exact', () => {
  const r = B.makeRider(11, { days: 200 }), path = B.simulate(r, 'habit');
  const tr = { k: 1.3, u: 1, v: 1 }, rd = B.readingsFor(11, tr, path, 128, 4);
  const post = B.fitK(rd, path);
  assert.ok(Math.abs(post.mean - 1.3) < 3 * post.sd + 0.05, post.mean + ' +- ' + post.sd);
  assert.ok(Math.abs(post.w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('planner finishes before the 5th percentile of past departures', () => {
  const hist = [];
  for (let i = 0; i < 20; i++) hist.push({ weekend: false, dep: 7.5 + 0.1 * Math.sin(i) });
  const f = B.planFinish(hist, false, 0.05, 1 / 6);
  assert.ok(f < B.quantile(hist.map(h => h.dep), 0.05));
  assert.strictEqual(B.planFinish(hist.concat([...Array(10)].map(() => ({ weekend: true, dep: null }))), true, 0.05, 0.1), null);
});

test('split conformal band reaches target coverage on held-out simulated riders', () => {
  const c = B.conformalMulti(120, 120, 2000, C.observedDays, [1095], 0.2)[0];
  assert.ok(c.coverage >= 0.72, 'coverage ' + c.coverage);
  assert.ok(c.qhat > 0);
});
