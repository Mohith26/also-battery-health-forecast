// Seeded synthetic rider and experiment settings (no real ALSO data). Used by the page and the tests.
(function (root) {
  var CFG = {
    riderSeed: 7,            // weekday commuter, ~2 rides/day, garage-stored
    observedDays: 128,       // purchase Jul 7 2026 -> today Nov 12 2026
    readingEvery: 4,         // a usable health reading every ~4 days (charge sessions spanning a wide SoC window)
    startDate: '2026-07-07',
    specRangeMi: 60,         // Standard battery, ALSO spec "up to 60 miles"
    conformal: { nCal: 300, nTest: 200, seed: 1000, alpha: 0.2, horizons: [365, 730, 1095] }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CFG; else root.ALSO_CFG = CFG;
})(this);
