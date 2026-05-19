# Backend Implementation Notes

Operational reference for the Node/Express backend. For the user-facing API contract see [API.md](./API.md). For the rationale behind the verdict thresholds see [DESIGN.md](./DESIGN.md).

## Today vs Tomorrow

The API returns two sibling day objects, `today` and `tomorrow`. Both are built by the same `buildDay(...)` helper in `lib/forecast.js`, then mounted under those keys. The difference is what hours feed into the verdict math and how `tennis_windows` are flagged.

**`now`-relative computation.** `buildForecast(raw, { now })` accepts an injected `now: Date` (default `new Date()`). Server code never passes it; tests do, so the partial-day filter can be exercised deterministically. `now` is converted to a wall-clock hour 0-23 in `America/New_York` via `Intl.DateTimeFormat`, then used to slice today's tennis hours.

**Tomorrow** is always the full set of `hourly[]` entries with `is_tomorrow === true` and local hour in `[6, 21]`. `tennis_windows[*].is_past` is always `false`. There is no `tennis_hours_remaining` field on tomorrow. `is_concluded` is `false`.

**Today** is filtered relative to the current local hour:

- If `currentHour < 6`: include all today entries with hour in `[6, 21]` (the full 16-hour tennis day is still ahead).
- If `6 <= currentHour < 21`: include today entries with hour in `[currentHour, 21]`. The current hour is included (we floor to the start of the hour, not the next hour).
- If `currentHour >= 21`: today is **concluded** — see below.

`today.tennis_hours_remaining` is the integer count of tennis hours still ahead. The frontend can render "Only 3 tennis hours left today".

**Per-day `tennis_windows`.** Each day object owns its own four-element `tennis_windows` array (no top-level `tennis_windows` anymore). Each window is computed from that day's hourly data — for today this includes already-past hours; the model values for those hours are simply known rather than predicted. Each window in today gets `is_past: true` when its `endHour <= currentHour`; tomorrow's windows are always `is_past: false`.

`best_window` selection restricts to non-past windows on today (so a clear morning that has already happened is not advertised as the "best slot"). The algorithm is otherwise unchanged: lowest-rain `GO`, fall back to lowest-rain `LIGHT_CAUTION`, `null` if nothing playable remains.

### `is_concluded` semantics

When `currentHour >= 21`, today's tennis day is over — the last window (Evening, 18-21) has ended. The today object is built by `buildConcludedDay(...)` and looks like:

```json
{
  "date": "2026-05-19",
  "label": "today",
  "is_concluded": true,
  "tennis_hours_remaining": 0,
  "verdict": null,
  "verdict_reason": "Tennis day complete — check Tomorrow for the next forecast.",
  "rain_probability_max": null,
  "rain_probability_mean": null,
  "wind_max_mph": null,
  "wind_mean_mph": null,
  "first_rain_time": null,
  "first_rain_hour_local": null,
  "best_window": null,
  "confidence": null,
  "confidence_note": "Tennis day complete.",
  "tennis_windows": [ /* all 4 with is_past: true */ ]
}
```

Daily metadata that does not depend on remaining hours — `precipitation_sum_in`, `temperature_high_f`, `temperature_low_f`, `sunrise`, `sunset` — is still populated from Open-Meteo's daily array. The frontend can show "yesterday's" totals for the rest of the calendar day if it wants.

Tomorrow always carries `is_concluded: false` for shape symmetry but never has the conclusion code path.

## Open-Meteo model IDs

The backend queries two model identifiers as the `models=` parameter on `https://api.open-meteo.com/v1/forecast`:

| Constant     | Open-Meteo ID    | Model                                            | Why we use it                                                                                       |
| ------------ | ---------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `MODEL_HRRR` | `gfs_hrrr`       | NOAA High-Resolution Rapid Refresh (3 km, CONUS) | Gold standard for short-range US convective forecasting. Critical for Florida summer thunderstorms. |
| `MODEL_IFS` | `ecmwf_ifs025`  | ECMWF Integrated Forecasting System (0.25°)      | Independent physical check against HRRR. Different organization, different physics, different lineage. Confirmed support for `precipitation_probability`. |

Both identifiers were verified against the Open-Meteo source enum (`MultiDomains` in `Sources/App/Controllers/ForecastapiController.swift`). `gfs_hrrr` is a distinct enum case that internally routes to the HRRR CONUS domain. The canonical alternative ID `ncep_hrrr_conus` also works and may be preferable in the future; either one returns identical data. We use `gfs_hrrr` because it matches Open-Meteo's public docs phrasing.

When two models are requested in a single call (`models=gfs_hrrr,ecmwf_ifs025`), Open-Meteo suffixes every hourly and daily variable with the requested model name: `precipitation_gfs_hrrr`, `precipitation_ecmwf_ifs025`, `precipitation_probability_gfs_hrrr`, etc. The suffix is the literal user-supplied string, not the internal canonical name — so if you switch `MODEL_HRRR` to `ncep_hrrr_conus`, every response-side suffix changes too. `lib/openMeteo.js` and `lib/forecast.js` build all suffixes from the constants in `lib/config.js`, so a one-line config change propagates everywhere.

## Request strategy and graceful degradation

`fetchForecast()` in `lib/openMeteo.js`:

1. Checks the 10-minute in-memory TTL cache. On hit, returns immediately with `cached: true`.
2. Makes one combined request for both models. On success, caches and returns.
3. On failure (Open-Meteo occasionally rejects a multi-model request if one model has no data for the region), falls back to one request per model in parallel via `Promise.allSettled`. Successful responses are normalized so their bare variable names get re-keyed with the model suffix, matching the combined-response shape.
4. If both per-model requests fail, throws — the Express error handler returns a 500 with the upstream error message.
5. `models.<id>.available` and (when present) `models.<id>.error` flow through to the API response so the frontend can show "one model is offline" rather than silently dropping a comparison.

HRRR covers CONUS only, so it always works for Boca Raton. IFS is global and very rarely unavailable. The fallback path is defensive, not load-bearing.

## Verdict tier naming

The three verdict tiers are exported from `lib/forecast.js` as the `VERDICT` enum and used in `today.verdict`, `tomorrow.verdict`, and every `tennis_windows[].verdict` (with `today.verdict === null` on a concluded today):

| Tier             | Previous name | Meaning                                                                          |
| ---------------- | ------------- | -------------------------------------------------------------------------------- |
| `GO`             | `GO`          | Conditions favor play. Verdict reason uses an affirmative tone ("Looks good"). |
| `LIGHT_CAUTION`  | `CAUTION`     | Some risk; check the radar before heading out. Reason starts "Heads up".         |
| `HEAVY_CAUTION`  | `NO_GO`       | Significant risk of rain interruptions. Reason starts "Strong caution".          |

The thresholds that drive verdict selection are unchanged from the previous `GO` / `CAUTION` / `NO_GO` regime — only the string labels and the wording of `verdict_reason` were updated. The user explicitly asked to drop the absolutist "Skip it" / `NO_GO` wording in favor of strong-but-non-absolutist guidance, so backend logic that depended on the old names should be updated to use the new `VERDICT` constants (don't compare against string literals directly).

## Verdict thresholds

Computed in `lib/forecast.js`. The **daily** verdict and the per-**window** verdicts use different rules.

### Daily verdict (tennis-hours-scoped)

The daily verdict is computed over the tennis hours of the day: local hours `06:00` through `21:00` inclusive (`TENNIS_DAY_START_HOUR..TENNIS_DAY_END_HOUR` in `lib/forecast.js`). Pre-dawn rain that has cleared by sunrise does not drag a clear afternoon down — that was the explicit motivation for moving from a 24h-wide check to this window. Tomorrow always uses the full 16-hour set; today uses only the hours still ahead (see [Today vs Tomorrow](#today-vs-tomorrow)).

Tennis-hours stats:

- `heavyHours` — count of tennis hours where `rain_probability_consensus >= 60`.
- `tennisPrecip` — sum of `precipitation_in_consensus` across tennis hours.
- `peakTennisProb` — max `rain_probability_consensus` across tennis hours.
- `meanTennisProb` — mean `rain_probability_consensus` across tennis hours.
- `disagreementAtRiskyHour` — any tennis hour with `disagreement === true` AND `rain_probability_consensus >= 35`.

| Verdict           | Trigger                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `HEAVY_CAUTION`   | `heavyHours >= 6` **OR** `tennisPrecip >= 0.4` in                                                    |
| `LIGHT_CAUTION`   | `peakTennisProb >= 50` **OR** `tennisPrecip >= 0.1` in **OR** `disagreementAtRiskyHour`              |
| `GO`              | none of the above                                                                                    |

Priority order if multiple thresholds apply: `heavyHours` > `tennisPrecip` for the HEAVY tier; `peakTennisProb` > `tennisPrecip` > `disagreementAtRiskyHour` for the LIGHT tier. The `verdict_reason` string reflects whichever trigger fired.

`rain_probability_max` and `rain_probability_mean` on both `today` and `tomorrow` are `peakTennisProb` and `meanTennisProb` over that day's tennis hours — not the full-day stats. `precipitation_sum_in` is still the Open-Meteo daily total.

The named constants live at the top of `lib/forecast.js` (`TENNIS_DAY_START_HOUR`, `TENNIS_DAY_END_HOUR`, `NOGO_HEAVY_HOURS`, `NOGO_HEAVY_PROB`, `NOGO_PRECIP_IN`, `CAUTION_PEAK_PROB`, `CAUTION_PRECIP_IN`, `CAUTION_DISAGREEMENT_PROB`).

### Window verdict (per Morning / Midday / Afternoon / Evening)

Each tennis window keeps the older threshold rules, applied only to the hours inside that window:

| Verdict           | Trigger                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEAVY_CAUTION`   | Max hourly precipitation probability > 60% **OR** precipitation_sum > 0.2 inch                                                                                                         |
| `LIGHT_CAUTION`   | Max hourly probability between 35% and 60% **OR** precipitation_sum between 0.05 and 0.2 inch **OR** any hour in the window has model disagreement                                     |
| `GO`              | Max hourly probability < 35% **AND** precipitation_sum < 0.05 inch **AND** models agree                                                                                                |

**Hourly disagreement flag:** `|prob_hrrr - prob_ifs| > 25` percentage points. Used to render the per-hour `disagreement: true` chip.

**Daily disagreement (informational only):** Tracked over the tennis hours; a peak diff > 30 percentage points sets the daily disagreement flag but no longer auto-promotes verdicts — `disagreementAtRiskyHour` is the gate that actually moves a daily GO to CAUTION.

**Daily model agreement label:** `DISAGREE` if any tennis hour has `disagreement: true`, else `AGREE`.

**Consensus probability:** Simple mean of the two models at each hour. If only one model is available, the consensus equals that single model and `uncertainty_note` is set.

## Tennis windows

Defined in `TENNIS_WINDOWS` in `lib/config.js`. All times are local (`America/New_York`). Each window is a half-open interval `[startHour, endHour)`:

| Label     | Hours          |
| --------- | -------------- |
| Morning   | 06:00 – 10:00  |
| Midday    | 10:00 – 14:00  |
| Afternoon | 14:00 – 18:00  |
| Evening   | 18:00 – 21:00  |

For each window the backend computes the max consensus probability across its hours, the sum of consensus precipitation, and an "any hour disagrees" flag, then runs those through the same verdict rules above.

## Tennis accuracy enhancements

Both the `today` and `tomorrow` day objects include six computed fields aimed at giving a tennis-specific read on conditions: `wind_max_mph`, `wind_mean_mph`, `wind_gust_max_mph`, `first_rain_time` (+ `first_rain_hour_local`), `best_window`, and `confidence` (+ `confidence_note`). All are scoped to that day's tennis hours — full 06:00–21:00 for tomorrow, the remaining hours for today. On a concluded today they are all `null`. The named constants live at the top of `lib/forecast.js`.

### Wind: `wind_max_mph`, `wind_mean_mph`, `wind_gust_max_mph`

Open-Meteo's `windspeed_10m` and `wind_gusts_10m` variables are requested for both HRRR and IFS in the `hourly=` list (see `HOURLY_VARS` in `lib/openMeteo.js`). For each tennis hour, `lib/forecast.js` averages the two model values into `windspeed_10m_consensus` and `wind_gusts_10m_consensus`. When only one model has a value at an hour, the consensus is that single value.

- `wind_max_mph` is the maximum consensus **sustained** value across tennis hours, rounded to integer mph.
- `wind_mean_mph` is the arithmetic mean of consensus sustained wind across tennis hours, rounded.
- `wind_gust_max_mph` is the maximum consensus **gust** value across tennis hours, rounded.
- If neither model reports wind at any tennis hour, the relevant field is `null`.

The units are `mph` because the upstream request sets `windspeed_unit=mph`.

**Why gust matters separately from sustained.** On a Florida day with sustained 12 mph but gusts to 28 mph, the verdict math sees a calm afternoon; the player serving feels a coin-flip ball-toss. HRRR's GRIB `GUST` field is a 1-hour maximum, derived in WRF's surface-layer scheme and bias-corrected against METAR observations during HRRR's hourly data assimilation cycle. IFS exposes a `wind_gusts_10m` variable in its surface set. We surface gust as a third wind number rather than rolling it into the verdict because gust thresholds are highly player-specific (a doubles game tolerates higher gusts than a singles serve), but a 25+ mph gust column is genuinely tennis-disrupting and the UI highlights it. See [ACCURACY.md](./ACCURACY.md#5-variables-we-use-and-why-each-one) for the meteorology citation.

### First rain: `first_rain_time`, `first_rain_hour_local`

Scan tennis hours in chronological order. The first hour whose `rain_probability_consensus >= 50` (the `FIRST_RAIN_THRESHOLD` constant) populates both fields:

- `first_rain_time` is the raw Open-Meteo timestamp (naive local, e.g. `"2026-05-20T15:00"`).
- `first_rain_hour_local` is the same hour formatted via `Intl.DateTimeFormat` for `America/New_York` as `"3:00 PM"`.

If no tennis hour crosses 50%, both fields are `null`. Threshold rationale: 50% is the lowest probability at which a player should actively plan around an incoming cell rather than just glance at the radar.

### `best_window`

Walk the day's `tennis_windows` and choose:

1. The `GO` window with the lowest `max_rain_prob`. Ties are broken by array order (Morning first).
2. If no window is `GO`, the `LIGHT_CAUTION` window with the lowest `max_rain_prob`.
3. If all remaining windows are `HEAVY_CAUTION`, `best_window` is `null` — there is no recommended slot.

For **today**, the candidate pool is restricted to windows where `is_past === false`. If today's morning was sunny but it is now 2pm, the picker will not suggest the morning slot. If every remaining window is `HEAVY_CAUTION` or every window has already passed, `best_window` is `null`.

Shape: `{ label, max_rain_prob, verdict }` — a minimal pointer into `tennis_windows`. The frontend can use this to highlight the "play now" slot without re-implementing the selection logic.

### Confidence: `confidence`, `confidence_note`

Compute `meanAbsDiff` = mean of `|prob_hrrr - prob_ifs|` over tennis hours where *both* models have a value. Bin it:

| Bin       | Threshold                                  | Note format                                                                       |
| --------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| HIGH      | `meanAbsDiff < 5`                          | `"Both models agree within N pts on average."`                                    |
| MODERATE  | `5 <= meanAbsDiff < 15`                    | `"Models differ by N pts on average — moderate uncertainty."`                     |
| LOW       | `meanAbsDiff >= 15`                        | `"Models differ by N pts on average — forecast uncertain."`                       |
| LOW (1-model fallback) | Only one model has any tennis hour | `"Only one model available — forecast uncertainty is higher."`             |

`N` in each template is `Math.round(meanAbsDiff)`. `meanAbsDiff` thresholds live in the `CONFIDENCE_HIGH_MAX_DIFF` and `CONFIDENCE_MODERATE_MAX_DIFF` constants. This is a distinct signal from `model_agreement` / `uncertainty_note`: those flag whether models are misaligned, while `confidence` quantifies the typical-hour disagreement and is meant to be surfaced to users directly.

## Caching

`lib/cache.js` is a trivial `Map`-backed TTL cache. One key (`"forecast"`), 10-minute TTL set by `CACHE_TTL_MS` in `lib/config.js`. The cache wraps the raw Open-Meteo payload plus the per-model `available` metadata, not the built response — so the verdict logic re-runs on every request and timestamps stay fresh, but Open-Meteo is hit at most once per 10 minutes.

Do not drop the TTL below 5 minutes. That is the Open-Meteo etiquette floor; the service is free and we should not hammer it.

The HTTP `Cache-Control: public, max-age=300` header allows CDNs and browsers to serve a slightly stale response for up to 5 minutes, halving the load that even reaches our process.

## Adding a new location

Edit `lib/config.js` and change four constants:

```js
export const LATITUDE = <new lat>;
export const LONGITUDE = <new lon>;
export const LOCATION_NAME = "<display name>";
export const TIMEZONE = "<IANA tz, e.g. America/Chicago>";
```

Redeploy. The cache is in-memory so it flushes automatically on process restart.

If you want to support **multiple locations simultaneously**, that is a larger change: the cache key needs to include the location, `GET /api/forecast` needs a `?location=` query parameter, and the frontend needs a selector. Out of scope for the current single-community deployment.

If the new location is **outside CONUS**, HRRR will fail (it is US-only). The fallback path will return IFS-only data with `models.hrrr.available: false` and `uncertainty_note` populated. Consider swapping `MODEL_HRRR` for a regional model that covers your area (`dwd_icon_d2` for Europe, `meteofrance_arome_france_hd` for France, etc.) — see the [Open-Meteo source enum](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Helper/DomainRegistry.swift) for the full list.

## Sample curl commands

```bash
# Health check (no upstream call)
curl -s http://localhost:3000/api/health
# {"ok":true,"uptime":12.34}

# Full forecast
curl -s http://localhost:3000/api/forecast | jq .

# Just today's verdict + remaining-hours subtext
curl -s http://localhost:3000/api/forecast \
  | jq '.today | {date, label, is_concluded, tennis_hours_remaining, verdict, verdict_reason, best_window}'

# Tomorrow's verdict and the tennis-accuracy fields
curl -s http://localhost:3000/api/forecast \
  | jq '.tomorrow | {date, verdict, verdict_reason, model_agreement, confidence, confidence_note}'

# Today's tennis windows (note the per-window is_past flag)
curl -s http://localhost:3000/api/forecast \
  | jq '.today.tennis_windows[] | {label, verdict, max_rain_prob, is_past, reason}'

# Tomorrow's tennis windows
curl -s http://localhost:3000/api/forecast \
  | jq '.tomorrow.tennis_windows[] | {label, verdict, max_rain_prob, reason}'

# Wind + first rain + best window snapshot for tomorrow
curl -s http://localhost:3000/api/forecast \
  | jq '.tomorrow | {wind_max_mph, wind_mean_mph, first_rain_hour_local, first_rain_time, best_window}'

# Confirm both models came back
curl -s http://localhost:3000/api/forecast | jq '.models'

# First six hours of tomorrow only
curl -s http://localhost:3000/api/forecast \
  | jq '[.hourly[] | select(.is_tomorrow)] | .[:6]'

# Cache check: hit twice in a row, second response should have "cached": true
curl -s http://localhost:3000/api/forecast | jq '.cached'
curl -s http://localhost:3000/api/forecast | jq '.cached'
```
