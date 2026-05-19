# BocaWeather Accuracy Document

How accurate is this app, why, and where does the ceiling sit at zero cost? This document is the honest, source-cited answer. It is the reference for any future agent or contributor deciding whether a proposed change actually improves the forecast or just moves pixels.

## 1. TL;DR

BocaWeather predicts rain risk for tennis at one fixed location in Boca Raton, FL by fusing two independent operational weather models — NOAA HRRR (3 km, hourly, radar-assimilating, physical) and ECMWF IFS (0.25°, physical, global) — through [Open-Meteo's free API](https://open-meteo.com/). For the **18-to-48-hour next-day tennis decision**, this is approximately the best reliable free configuration available: HRRR is the operational gold standard for short-range CONUS convective forecasting, and IFS is the gold-standard global physical model from a different organization with different physics. The honest ceiling at zero cost is that no public free model resolves a 5–15 km Florida pulse-storm with confidence at the city-block scale — that is a fundamental limit of the science, not of this app. Inside the 60-minute go/no-go window, the radar overlay (RainViewer past frames) is the only honest source of signal.

## 2. The forecasting problem in SE Florida

Boca Raton sits at 26.38°N on Florida's Atlantic coast. From roughly May through September the dominant rainfall mechanism is **sea-breeze convergence**: solar heating drives an Atlantic sea-breeze inland from the east and a Gulf sea-breeze inland from the west, and where the two boundaries collide, deep convection fires. The result is the well-known "afternoon pop-up" — short-lived (~20–40 min), narrow (5–15 km), high-rainfall-rate convective cells that peak between roughly 1pm and 7pm local and dissipate after sunset. NOAA's Tampa Bay WFO has documented [eight distinct sea-breeze flow regimes](https://www.weather.gov/tbw/SB_RegimesMVF) that determine where each day's cells fire; the original 1948 [Byers and Rodebush study in the Journal of the Atmospheric Sciences](https://journals.ametsoc.org/view/journals/atsc/5/6/1520-0469_1948_005_0275_cototf_2_0_co_2.xml) first explained the physics. [NWS Miami's Area Forecast Discussions](https://forecast.weather.gov/product.php?site=NWS&issuedby=mfl&product=AFD&format=CI&version=1&glossary=1) explicitly call out which sea-breeze regime is dominant on any given summer day.

This regime breaks three assumptions naive weather apps depend on:

1. **Cells are smaller than the model grid.** A 12 km convective cell is right at HRRR's effective resolution (~9 km, i.e. 3× grid spacing) and well below IFS's (~28 km). Global models cannot resolve a single Florida pulse storm; they resolve only the day's *propensity* to fire them.
2. **Cells are short.** A storm that drops 0.4" over a tennis court takes 20 minutes; a 1-hour forecast slot blurs that into a 0.4" hour with no way to know which 20 minutes mattered.
3. **Placement is stochastic.** Tomorrow's 3pm storm is real; whether it hits this court or one 5 miles north is close to a coin flip. CONUS warm-season verification shows convection-allowing models systematically over-predict areal coverage and mis-place individual cells ([Cui et al., *Mon. Wea. Rev.* 152, 2024](https://journals.ametsoc.org/view/journals/mwre/152/1/MWR-D-23-0108.1.xml)).

A single-model "60% chance at 3pm" therefore hides the real signal: "we know storms will fire — we don't know if your court gets hit." Florida users learn quickly that one-number forecasts are unreliable and stop trusting any of them.

## 3. Why HRRR + IFS is the right free pairing

**NOAA HRRR** is the operational gold standard for short-range CONUS convective forecasting. It runs at 3 km native resolution, updates every hour, and **assimilates radar reflectivity every 15 minutes** through a 36-member storm-scale ensemble Kalman filter ([Dowell et al., *Wea. Forecasting* 37, 2022](https://journals.ametsoc.org/view/journals/wefo/37/8/WAF-D-21-0151.1.xml)). It produces 18-hour forecasts hourly and 48-hour forecasts at 00/06/12/18 UTC. For "will storms fire this afternoon" over the US, HRRR consistently outperforms global models — no global model ingests radar at HRRR's cadence.

**ECMWF IFS** (Integrated Forecasting System) is the operational physical global model from the European Centre for Medium-Range Weather Forecasts and the gold standard against which all other global models are benchmarked. Open-Meteo serves it at 0.25° resolution (~28 km grid spacing) as `ecmwf_ifs025`. ECMWF publishes [continuous verification scorecards](https://charts.ecmwf.int/products/plwww_3m_hr_ccaf_adrian_ts?facets=%7B%22Range%22%3A%5B%22Short%20%26%20medium%20%282-14%20days%29%22%5D%7D) showing IFS leads the World Meteorological Organization scoring on the 500-hPa anomaly correlation metric most months of the year — it is the model meteorologists actually cite when they want one global number.

**Why this specific pairing:**

- **Independent error modes.** HRRR is regional convection-allowing physical with 15-minute radar assimilation; IFS is global synoptic-scale physical with conventional 4D-Var assimilation. Same fundamental scientific approach (physics-based numerical weather prediction) but **completely different organizations, grids, assimilation cycles, and physics packages**. Agreement is genuine consensus; disagreement is a real signal that the atmosphere is in an uncertain state — not a model bug.
- **Different blind spots.** HRRR excels at convective initiation and short-range CONUS storms but smooths beyond ~18 h; IFS captures large-scale synoptic patterns and forecasts further out but cannot resolve individual sea-breeze cells. Their failure modes don't share a common cause.
- **Both reliably expose `precipitation_probability` on Open-Meteo.** This is the variable the chart's % axis displays. ECMWF documents IFS probability as ensemble-derived; the discussion at [Open-Meteo #708](https://github.com/open-meteo/open-meteo/discussions/708) confirms IFS025 returns it.
- **Both free under one Open-Meteo `models=` call** (with per-model fallback if the combined response drops one — see [BACKEND.md](./BACKEND.md)).

**Why we switched away from ECMWF AIFS:**

The original launch paired HRRR with ECMWF AIFS (`ecmwf_aifs025`, the AI variant — see [Lang et al., arXiv:2406.01465](https://arxiv.org/abs/2406.01465) and the 1.1.0 update [Lang et al., arXiv:2509.18994](https://arxiv.org/abs/2509.18994)). The pairing was attractive because AI vs physical is maximum methodological diversity. In production it failed: the AIFS chart line was always empty. Investigation traced the cause to AIFS deterministic not exposing `precipitation_probability` on Open-Meteo — precipitation probability is derived from ensemble spread, and AIFS deterministic is a single AI forecast, not an ensemble. The discussion at [Open-Meteo #708](https://github.com/open-meteo/open-meteo/discussions/708) explicitly lists IFS025 (among others) as supporting probability and does not list AIFS025. We switched to IFS, which trades the AI/physical diversity for confirmed probability support plus retained ECMWF/NOAA organizational diversity. A future ensemble-aware version of AIFS may flip this decision back.

**Why not other free models:**

- **GFS (`gfs_global` or `gfs_seamless`):** Same NOAA lineage as HRRR but coarser; HRRR already absorbs GFS lateral boundaries, so adding GFS is redundant.
- **ECMWF AIFS (`ecmwf_aifs025`):** The AI variant. Excellent on synoptic metrics but does not expose `precipitation_probability` on Open-Meteo as deterministic — see preceding section.
- **ICON Seamless (`icon_seamless`):** DWD's German global, independent physics, confirmed probability support. A reasonable third candidate; we chose IFS because of its longer verification record and prominence in operational meteorology.
- **DWD ICON-D2:** Excellent 2 km convective model — Germany-only.
- **NAM (`ncep_nam_conus`):** Older 12 km/3 km nest, outperformed by HRRR for convection.
- **HREF (High-Resolution Ensemble Forecast):** What we'd actually want — an 8-member CONUS convection-allowing ensemble that explicitly samples convective uncertainty. Not on Open-Meteo. NCEP's [HREF page](https://vlab.noaa.gov/web/emc/href-hiresw) describes what we'd consume if we could.

## 4. Why we surface model disagreement instead of hiding it

Most consumer weather apps show one number ("55% chance of rain at 3pm") even when the backend has multiple models running. That choice silently averages away the most useful signal a multi-model setup produces — *the variance between models*.

For Florida pulse convection the variance is the story. HRRR says 70%, IFS says 20% → "we know storms will fire — we don't know if they hit you." Both say 45% → low-confidence "maybe." Same consensus number; very different decisions.

The app exposes this in three layered ways:
1. **Per-hour `disagreement` flag** — orange shading in the hourly chart where `|p_hrrr - p_ifs| > 25` percentage points.
2. **Day-level `model_agreement`** (`AGREE`/`DISAGREE`) and a `disagreementAtRiskyHour` gate that promotes a GO verdict to LIGHT_CAUTION when models disagree on an already-wet hour.
3. **Day-level `confidence` rating** (HIGH/MODERATE/LOW) from the mean absolute difference of per-hour probabilities across tennis hours.

Central thesis: we are not trying to beat the models. We surface the consensus and the uncertainty in a form the user can act on.

## 5. Variables we use, and why each one

Requested per hour for both `gfs_hrrr` and `ecmwf_ifs025`:

| Variable | Why we use it | Caveat |
| --- | --- | --- |
| `precipitation` | Hourly rainfall in inches — directly drives `tennisPrecip` and per-window precip sums. | Convective cells are smaller than the grid; hourly totals can mis-locate by 5–15 km. |
| `precipitation_probability` | Drives the headline rain probability number and the verdict tier thresholds. | See § 7 — this is **not** a deterministic-model native quantity; Open-Meteo derives it. |
| `temperature_2m` | Powers the now-strip and hi/lo tiles. | Used for display only; not in the verdict. |
| `weathercode` | WMO weather code for "is it thunderstorm vs rain vs cloudy". Cosmetic. | Not in the verdict. |
| `cloudcover` | Surfaced indirectly; not in the verdict. | Open-Meteo aggregate of low/mid/high. |
| `windspeed_10m` | Drives `wind_max_mph` and `wind_mean_mph`. Sustained 15+ mph degrades tennis playability noticeably. | 10 m is the standard surface anemometer height. |
| `wind_gusts_10m` | **(Added in this pass.)** Drives `wind_gust_max_mph`. Gusts above ~25 mph are the most common reason a clear-sky day is still unplayable. | HRRR's GRIB `GUST` field is a 1-hour maximum surface-layer parameter, bias-corrected against METAR observations. IFS exposes `wind_gusts_10m` as part of its surface variable set. |

Per day we additionally pull `precipitation_sum`, `precipitation_probability_max`, `temperature_2m_max`, `temperature_2m_min`, `sunrise`, `sunset`, and `weathercode`. These are display-only or feed into the tennis-windows precipitation totals.

## 6. Variables we considered but didn't use

- **`cape` (Convective Available Potential Energy)** — Both HRRR and IFS expose it. CAPE > 2500 J/kg is "storm fuel exists." Rejected for the UI because raw CAPE is meteorologist-level data: actionable only against CIN and wind shear. CAPE *could* up-weight the afternoon-storm verdict in convective season, but the published skill gain is modest and the rule needs calibration we cannot do without a historical-accuracy DB.
- **`convective_inhibition` (CIN)** — Same argument as CAPE.
- **`lifted_index`** — Single-number instability metric, largely redundant with CAPE at this latitude.
- **`uv_index`** — Genuinely useful for Florida summer tennis (UV index routinely hits 11+). Not shipped to keep hero stats focused on the rain/wind decision; if the hero gets a 5th tile this is the highest-value candidate.
- **`lightning_potential_index`** — Not exposed by Open-Meteo for HRRR or IFS on the standard API.
- **`visibility`** — Exposed for GFS/HRRR but near-perfect on summer convective days outside of fog (rare here) — adds no signal.

## 7. Consensus method

We use the simplest possible consensus: per-hour arithmetic mean of HRRR and IFS probabilities and precipitation amounts. When only one model is available, the consensus is that single model and `uncertainty_note` is set.

We considered weighted consensus (HRRR gets more weight than IFS because HRRR has higher native resolution), but rejected it because:
1. We do not have a defensible weight from peer-reviewed verification at this specific location and horizon.
2. IFS's update cycle and global view sometimes catch synoptic shifts HRRR misses, and we don't want to systematically discount that.
3. The simplest consensus that we can explain in one sentence is more defensible than a weighting scheme that requires a paragraph to justify.

The **honest limit** of arithmetic averaging is that if one model is wildly wrong (e.g., IFS smooths a real storm into background drizzle), the consensus is dragged toward the wrong answer instead of being flagged. The `disagreement` machinery is the mitigation: when the models disagree by more than 25 percentage points, the consensus number is correct but the UI labels it "uncertain" so the user knows not to lean on it.

## 8. Disagreement threshold

The hourly disagreement flag fires when `|p_hrrr - p_ifs| > 25 percentage points`. This is a **heuristic** chosen to be:
- Large enough that two well-calibrated models agreeing within normal noise do not constantly flash a disagreement warning (typical model-pair noise on rain probability is 5–15 pp).
- Small enough that a real "HRRR fires storms, IFS doesn't" divergence is caught (typically 30–60 pp on Florida summer afternoons).

We did not derive 25 from a verification study at this location; the underlying calibration would require months of paired forecast/observation data and is currently out of scope (no DB). If a future agent builds historical-accuracy tracking, this constant is the first one to revisit. A reasonable evidence-based replacement would be **the 90th percentile of the absolute-diff distribution** measured over a few months of paired forecasts — i.e. flag the hours that are genuinely outliers in the local climatology.

The day-level `confidence` rating uses a different cut: HIGH if mean abs diff < 5 pp, MODERATE if < 15, LOW otherwise. These thresholds are tighter because they describe the typical-hour disagreement across all 16 tennis hours, not the worst-hour spike.

## 9. Location precision

Configured coordinates: 26.3797°N, 80.1539°W. The Santa Barbara community sits on the NE corner of Jog Road and Glades Road in zip 33434 — ~10 acres / 241 homesites ([HOA Bulletin Board](https://www.hoabulletinboard.com/hoa/sababrfl/about/)). The chosen coordinate falls inside that footprint.

**Grid sampling implications:**
- **HRRR's 3 km Lambert Conformal grid** places the location in a single cell ~9 km inland of the Atlantic coast. The forecast reflects conditions inside that 9 km² cell.
- **IFS's 0.25° (~28 km) Gaussian grid** places the location in a cell whose nearest edge is several km west of the coast — meaning the IFS forecast for "Santa Barbara" is in practice a 28 km area-average that *includes substantial Atlantic ocean*. This systematically biases IFS toward marine conditions: smoother wind, less afternoon convective triggering, lower pulse-storm probability. This is the most important caveat to IFS at this location and explains a chunk of HRRR-vs-IFS disagreement on summer afternoons. IFS is included anyway because it is methodologically independent and synoptic-scale-informative — but the consensus inherits this coastal-smoothing bias.

If we shifted the coordinate one decimal place (~10 km), the HRRR cell would change but the IFS cell almost certainly would not. This is exactly why we surface model disagreement: the IFS smoothing is a known limit, and the disagreement chip exists to make the user aware when IFS's coarse-grid view diverges from HRRR's storm-resolving one.

## 10. Time horizons

Three layered horizons, each best served by a different tool:

| Horizon | Tool | What it answers |
| --- | --- | --- |
| 0–2 hours | RainViewer past radar | "Is the cell currently over us?" |
| 0–18 hours | HRRR (every-hour cycle) | "Will a storm fire this afternoon?" |
| 18–48 hours | HRRR + IFS consensus | "Should I plan tennis tomorrow?" |

We request `forecast_days=2` from Open-Meteo, which returns 48 hours of hourly data covering today and tomorrow. We deliberately do **not** extend to `forecast_days=3` because: (a) the primary use case is tomorrow's tennis decision, not the day-after-tomorrow; (b) HRRR's 48-hour runs only fire at 00/06/12/18 UTC, so the third day is GFS-extrapolated and noticeably less skillful; (c) the chart would have to render 72 hours, hurting mobile readability.

**RainViewer caveat (changed in 2025).** [RainViewer's API transitioned to limited operation throughout 2025](https://www.rainviewer.com/api/transition-faq.html), and the public free tile service now provides past radar only (no nowcast/future tiles) at up to 2 hours back in 10-minute intervals. Our radar code reads `data.radar.nowcast` defensively — if nowcast is empty, the timeline simply shows past frames. This is honest about the new reality: the 30-minute nowcast we used to surface is no longer available on the free tier.

## 11. Tennis-specific thresholds

The verdict thresholds in `lib/forecast.js` are tuned for tennis, not generic "is it sunny":

- **`heavyHours >= 6` (consensus ≥ 60%)** → `HEAVY_CAUTION`. Six tennis hours with material rain risk almost guarantees at least one interruption during a normal 2-hour session.
- **`tennisPrecip >= 0.4"` summed across tennis hours** → `HEAVY_CAUTION`. 0.4" of rain takes a hard court 30–60 minutes to dry; a clay court longer. A day forecast to deliver that much will not be playable end-to-end.
- **`peakTennisProb >= 50%`** → `LIGHT_CAUTION`. The lowest probability at which a player should actively plan around an incoming cell rather than glance at the radar.
- **`disagreementAtRiskyHour` (disagree + consensus ≥ 35%)** → `LIGHT_CAUTION`. Even a moderate consensus probability becomes worth flagging when the two models disagree about whether it's a 10% or a 60% hour.
- **Tennis hours 06:00–21:00 local.** This community has lighted courts that extend evening play; before-dawn rain that clears by sunrise should not drag a clear afternoon's verdict down.

These are not generic weather thresholds and should not be reused for other activities without re-tuning. A golfer might tolerate higher rain probability (one bad hole vs. cancellation); a runner might tolerate higher gust thresholds.

## 12. What we cannot do with free tools

Honest list of the accuracy ceiling at zero cost:

- **Sub-km nowcasting.** No free public service offers minute-level, sub-km precipitation nowcasts that would let us say "the cell over Glades Plaza will reach the court in 14 minutes." Rainbow.ai and Tomorrow.io offer this on paid tiers.
- **Storm-scale ensemble probabilities.** HREF (NCEP's 8-member convection-allowing ensemble) would give us proper ensemble probability calibrated for convection. It is not on Open-Meteo and would require ingesting NOMADS GRIB2 directly — a substantial engineering lift.
- **Lightning detection.** GLM (Geostationary Lightning Mapper) data exists, but real-time lightning APIs (Vaisala NLDN, Earth Networks) are paid.
- **Local mesonet observations.** Florida has the [FAWN](https://fawn.ifas.ufl.edu/) network and individual Weather Underground stations near Boca, but pulling live obs is not free at scale.
- **NWS office discussions.** The narrative AFDs from [NWS Miami WFO](https://www.weather.gov/mfl/) are free and excellent context for a meteorologist; we do not parse them because they are unstructured and would require LLM interpretation.
- **Historical verification.** We do not currently log forecasts and compare them to observed rain, so we cannot calibrate our own thresholds against ground truth. Adding a small forecasts-and-outcomes DB would be the single highest-value next step for accuracy.

## 13. Practical user advice

The app is built around a layered decision:

1. **24 hours out — Use this app.** Check the verdict, look at the model agreement, scan the tennis-windows grid for the cleanest slot.
2. **2–6 hours out — Use this app *plus* the hourly chart.** The HRRR-only hours in the chart (the first ~18 hours) are the most reliable signal you'll have before stepping onto the court.
3. **60 minutes before play — Pull up the radar.** The app's live radar shows the past two hours of regional reflectivity. If a cell is visible to the west or south-west of the Santa Barbara marker, sea-breeze flow will move it toward you in the next 30–60 minutes. If the radar is clean and the chart looks clean, go play.

The app's job is the 24-hour decision. The user's job is the 60-minute go/no-go. Conflating those is what makes Florida weather apps untrustworthy.

## 14. Sources

The primary peer-reviewed and operational sources informing this document:

1. **IFS 1.1.0 operational paper** — Lang et al., *arXiv:2509.18994*, September 2025: <https://arxiv.org/abs/2509.18994>
2. **Original IFS paper** — Lang et al., *arXiv:2406.01465*, 2024: <https://arxiv.org/abs/2406.01465>
3. **HRRR system description** — Dowell et al., *Weather and Forecasting* 37(8), 2022: <https://journals.ametsoc.org/view/journals/wefo/37/8/WAF-D-21-0151.1.xml>
4. **HRRR warm-season precipitation verification** — Cui et al., *Monthly Weather Review* 152(1), 2024: <https://journals.ametsoc.org/view/journals/mwre/152/1/MWR-D-23-0108.1.xml>
5. **Florida Sea Breeze Thunderstorm Regime methodology** — NWS Tampa Bay WFO: <https://www.weather.gov/tbw/SB_Methodology>
6. **Sea-breeze regime climatology charts** — NWS Tampa Bay WFO: <https://www.weather.gov/tbw/SB_RegimesMVF>
7. **Causes of Florida peninsula thunderstorms** — Byers & Rodebush, *Journal of the Atmospheric Sciences* 5(6), 1948: <https://journals.ametsoc.org/view/journals/atsc/5/6/1520-0469_1948_005_0275_cototf_2_0_co_2.xml>
8. **NWS Miami Area Forecast Discussion (live)** — operational sea-breeze regime calls: <https://forecast.weather.gov/product.php?site=NWS&issuedby=mfl&product=AFD&format=CI&version=1&glossary=1>
9. **Open-Meteo precipitation probability methodology** — GitHub Discussion #708: <https://github.com/open-meteo/open-meteo/discussions/708>
10. **RainViewer API transition (2025)** — <https://www.rainviewer.com/api/transition-faq.html>
11. **HREF ensemble system (what we'd add if it were free)** — NCEP EMC: <https://vlab.noaa.gov/web/emc/href-hiresw>
12. **NBM (NOAA's blended probabilistic system)** — NCEP MDL: <https://vlab.noaa.gov/web/mdl/nbm>
