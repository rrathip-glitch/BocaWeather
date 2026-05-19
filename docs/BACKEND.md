# Backend Implementation Notes

Operational reference for the Node/Express backend. For the user-facing API contract see [API.md](./API.md). For the rationale behind the verdict thresholds see [DESIGN.md](./DESIGN.md).

## Open-Meteo model IDs

The backend queries two model identifiers as the `models=` parameter on `https://api.open-meteo.com/v1/forecast`:

| Constant     | Open-Meteo ID    | Model                                            | Why we use it                                                                                       |
| ------------ | ---------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `MODEL_HRRR` | `gfs_hrrr`       | NOAA High-Resolution Rapid Refresh (3 km, CONUS) | Gold standard for short-range US convective forecasting. Critical for Florida summer thunderstorms. |
| `MODEL_AIFS` | `ecmwf_aifs025`  | ECMWF Artificial Intelligence Forecasting System (0.25°) | Independent ML-based check against HRRR. Different error modes, different lineage.        |

Both identifiers were verified against the Open-Meteo source enum (`MultiDomains` in `Sources/App/Controllers/ForecastapiController.swift`). `gfs_hrrr` is a distinct enum case that internally routes to the HRRR CONUS domain. The canonical alternative ID `ncep_hrrr_conus` also works and may be preferable in the future; either one returns identical data. We use `gfs_hrrr` because it matches Open-Meteo's public docs phrasing.

When two models are requested in a single call (`models=gfs_hrrr,ecmwf_aifs025`), Open-Meteo suffixes every hourly and daily variable with the requested model name: `precipitation_gfs_hrrr`, `precipitation_ecmwf_aifs025`, `precipitation_probability_gfs_hrrr`, etc. The suffix is the literal user-supplied string, not the internal canonical name — so if you switch `MODEL_HRRR` to `ncep_hrrr_conus`, every response-side suffix changes too. `lib/openMeteo.js` and `lib/forecast.js` build all suffixes from the constants in `lib/config.js`, so a one-line config change propagates everywhere.

## Request strategy and graceful degradation

`fetchForecast()` in `lib/openMeteo.js`:

1. Checks the 10-minute in-memory TTL cache. On hit, returns immediately with `cached: true`.
2. Makes one combined request for both models. On success, caches and returns.
3. On failure (Open-Meteo occasionally rejects a multi-model request if one model has no data for the region), falls back to one request per model in parallel via `Promise.allSettled`. Successful responses are normalized so their bare variable names get re-keyed with the model suffix, matching the combined-response shape.
4. If both per-model requests fail, throws — the Express error handler returns a 500 with the upstream error message.
5. `models.<id>.available` and (when present) `models.<id>.error` flow through to the API response so the frontend can show "one model is offline" rather than silently dropping a comparison.

HRRR covers CONUS only, so it always works for Boca Raton. AIFS is global and very rarely unavailable. The fallback path is defensive, not load-bearing.

## Verdict thresholds

Computed in `lib/forecast.js`. The same rules apply both to the overall tomorrow verdict and to each tennis-window verdict.

| Verdict   | Trigger                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_GO`   | Max hourly precipitation probability > 60% **OR** precipitation_sum > 0.2 inch                                                                                                         |
| `CAUTION` | Max hourly probability between 35% and 60% **OR** precipitation_sum between 0.05 and 0.2 inch **OR** models disagree by more than 30 percentage points at any hour in the daytime window |
| `GO`      | Max hourly probability < 35% **AND** precipitation_sum < 0.05 inch **AND** models agree                                                                                                |

**Hourly disagreement flag:** `|prob_hrrr - prob_aifs| > 25` percentage points. Used to render the per-hour `disagreement: true` chip.

**Daily disagreement (for verdict):** Any hour in 8am-8pm with `|prob_hrrr - prob_aifs| > 30` percentage points → bumps a clean GO to CAUTION.

**Daily model agreement label:** `DISAGREE` if any hour in 8am-8pm has `disagreement: true`, else `AGREE`.

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

If the new location is **outside CONUS**, HRRR will fail (it is US-only). The fallback path will return AIFS-only data with `models.hrrr.available: false` and `uncertainty_note` populated. Consider swapping `MODEL_HRRR` for a regional model that covers your area (`dwd_icon_d2` for Europe, `meteofrance_arome_france_hd` for France, etc.) — see the [Open-Meteo source enum](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Helper/DomainRegistry.swift) for the full list.

## Sample curl commands

```bash
# Health check (no upstream call)
curl -s http://localhost:3000/api/health
# {"ok":true,"uptime":12.34}

# Full forecast
curl -s http://localhost:3000/api/forecast | jq .

# Just tomorrow's verdict
curl -s http://localhost:3000/api/forecast | jq '.tomorrow | {date, verdict, verdict_reason, model_agreement}'

# Tennis windows summary
curl -s http://localhost:3000/api/forecast | jq '.tennis_windows[] | {label, verdict, max_rain_prob}'

# Confirm both models came back
curl -s http://localhost:3000/api/forecast | jq '.models'

# First six hours of tomorrow only
curl -s http://localhost:3000/api/forecast \
  | jq '[.hourly[] | select(.is_tomorrow)] | .[:6]'

# Cache check: hit twice in a row, second response should have "cached": true
curl -s http://localhost:3000/api/forecast | jq '.cached'
curl -s http://localhost:3000/api/forecast | jq '.cached'
```
