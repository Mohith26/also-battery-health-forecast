# Battery Health Forecast for the ALSO app (concept)

**Live demo:** https://mohith26.github.io/also-battery-health-forecast/

An unofficial concept feature for the ALSO app and TM-B: a Battery screen that tells a rider how healthy their battery is today, where it will be in 1-3 years under their own habits (with an honest, calibrated range), what is aging it, and which habit changes help.

Built by Mohith Gajjela (Duke CS). Not affiliated with ALSO. **All data is synthetic.**

## Why

The ALSO app shows charge level and charging status, and the TM-B already collects battery health metrics (per ALSO's privacy policy), but riders don't see health or a forecast. Competitor apps show a single state-of-health number at best. A forecast is only useful if its range is trustworthy, and physics aging models are routinely off for an individual pack.

## How it works

1. **Aging model.** Schmalstieg et al. (2014) semi-empirical NMC model: calendar loss a(V,T)·t^0.75 and cycle loss b(V̄,DoD)·√Ah. The bike's state of charge and temperature are integrated every 15 minutes with the equivalent-time / equivalent-throughput method, so hours parked full, heat and riding each add their share.
2. **Personal fit.** A rider-specific scale k is fitted from noisy health readings taken at charge sessions (grid posterior, lognormal prior). Aging is linear in k, so one simulation per policy serves every what-if.
3. **Calibrated band.** Split conformal prediction on 300 simulated riders whose true calendar and cycle aging deviate from the model by ±20% (lognormal), scored on 200 held-out riders.
4. **What-ifs.** Ready-by-ride charging (hold at 80%, finish to 100% before the 5th percentile of the rider's own departure times) and charging/parking indoors (5°C cooler), each re-simulated over 3 years.

Everything on the page is computed in the browser by `core/battery.js` from the seeded rider in `data/rider.js`.

## Result (synthetic)

- Rider: weekday commuter, 128 days of history, 32 health readings. Health today 93%; 3-year forecast 77-80% (80% band).
- On 200 held-out simulated riders the calibrated 3-year 80% band covered 80% of true outcomes (1-year: 81%, 2-year: 81%); the model-only Bayesian band covered 73.5% at 3 years. Median band width about ±1.5 points.
- What-ifs for this rider: ready-by-ride charging ≈ +1 point of capacity at 3 years and cuts time above 90% charge from 13.5 to 8.2 h/day; parking 5°C cooler ≈ +1.7 points.

## Run it

```
node --test          # 6 unit tests
open index.html      # or serve the folder statically
```

## Honest limitations

- Synthetic riders, and the "true" batteries are the same model family with perturbed parameters. Real packs have knees, cell imbalance and temperature effects this model doesn't capture.
- Schmalstieg's coefficients come from one NMC 18650 cell; ALSO's cells differ. A production version would fit the model to ALSO's cell test data and fleet readings.
- Health readings are assumed to come from charge sessions with ±1.2 pt noise; how ALSO's BMS actually estimates capacity would set that.
- Range is a simple spec-based scaling (60 mi × health), not a route-aware estimate.
- Coverage is marginal over riders, not per rider.

## Novelty note

ALSO's app (App Store listing, Oct 2026 app blog, help center, ramp-up guide) offers navigation, routing, GPS locator, lock/unlock, firmware updates and charge-level monitoring; its range estimate learns from riding, but there is no battery-health or health-forecast screen. Competitors: Specialized Mission Control and Bosch (dealer diagnostic / Flow) show a current state-of-health figure, and Bosch Flow plans range per route. I found none that forecasts a rider's own battery health with a calibrated band or simulates habit changes.

## UI

Built from the ALSO app's App Store screenshots and ridealso.com: purple #ac74fb stage with mono captions, peach grid paper #fce9d6, lime #b1ff8e LCD panel in a cream frame with dark outline, round outlined buttons with offset shadows, lavender sheet #eef0ff, blue #5e75ff selection, purple lock pill #a181d4. Fonts: ALSO's are not public; Inter Tight and Space Mono are open stand-ins.
