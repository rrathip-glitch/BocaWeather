# BocaWeather API Reference

BocaWeather exposes two HTTP endpoints. Both return JSON. No authentication, no API keys, no rate limiting beyond the upstream Open-Meteo limits.

Base URL in development: `http://localhost:3000`
Base URL in production: your Railway-generated domain.

For the reasoning behind the response shape, see [DESIGN.md](./DESIGN.md).

## `GET /api/forecast`

Returns the full tomorrow forecast for the configured location, with per-window guidance and full hourly arrays from both models.

### Query parameters

| Param     | Values          | Description                                                                                                                |
| --------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `refresh` | `1` or `true`   | Bypass the in-memory cache and re-fetch from Open-Meteo. The fresh result is still written back to the cache so subsequent normal calls get the new value. When set, the response also sends `Cache-Control: no-store` so intermediaries don't serve stale data. |

Example:

```bash
curl -s "http://localhost:3000/api/forecast?refresh=1" | jq '.tomorrow'
```

### Caching

- Server-side: 10-minute in-memory cache. The Open-Meteo call is only made when the cache is cold, expired, or explicitly bypassed via `?refresh=1`.
- HTTP response header: `Cache-Control: public, max-age=300` (5 minutes) on normal requests; `no-store` when `?refresh=1` is used.
- HTTP response header: `X-Cache: HIT` when the response was served from the in-memory cache, `X-Cache: MISS` when it required an upstream fetch (including all `?refresh=1` calls).

### Tennis-hours-scoped daily stats

`tomorrow.rain_probability_max` and `tomorrow.rain_probability_mean` are computed over the tennis hours only (06:00–21:00 local), not all 24 hours of tomorrow. See [DESIGN.md section 3](./DESIGN.md#3-verdict-thresholds) for the rationale. `tomorrow.precipitation_sum_in` continues to reflect the full-day Open-Meteo daily total.

### Verdict tier semantics

Both `tomorrow.verdict` and each `tennis_windows[].verdict` use the same three-value enum:

| Tier             | Plain-language meaning                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GO`             | Conditions look good for tennis. Reasons start with "Looks good" (daily) or "Clear" (window).                                          |
| `LIGHT_CAUTION`  | Some rain risk; check the radar before heading out. Reasons start with "Heads up". The forecast is still playable in most cases.       |
| `HEAVY_CAUTION`  | High likelihood of rain interrupting play. Reasons start with "Strong caution". Plan a backup or shift to a different time of day.     |

This is a rename of the previous `GO` / `CAUTION` / `NO_GO` tiers. The selection thresholds are unchanged; only the labels and the wording of `verdict_reason` were updated to drop the absolutist "Skip it" framing.

### Response: 200 OK

```json
{
  "location": {
    "name": "Santa Barbara, Boca Raton",
    "lat": 26.3797,
    "lon": -80.1539,
    "timezone": "America/New_York"
  },
  "generated_at": "2026-05-19T13:42:11.000Z",
  "cached": true,
  "tomorrow": {
    "date": "2026-05-20",
    "verdict": "LIGHT_CAUTION",
    "verdict_reason": "Heads up: peak 55% rain chance during tennis hours — watch the radar.",
    "rain_probability_max": 55,
    "rain_probability_mean": 22,
    "precipitation_sum_in": 0.12,
    "temperature_high_f": 84,
    "temperature_low_f": 72,
    "sunrise": "2026-05-20T06:30",
    "sunset": "2026-05-20T20:00",
    "model_agreement": "DISAGREE",
    "uncertainty_note": null,
    "wind_max_mph": 14,
    "wind_mean_mph": 8,
    "first_rain_time": "2026-05-20T15:00",
    "first_rain_hour_local": "3:00 PM",
    "best_window": { "label": "Morning", "max_rain_prob": 12, "verdict": "GO" },
    "confidence": "MODERATE",
    "confidence_note": "Models differ by 9 pts on average — moderate uncertainty."
  },
  "tennis_windows": [
    {
      "label": "Morning",
      "start": "2026-05-20T06:00",
      "end": "2026-05-20T09:00",
      "verdict": "GO",
      "max_rain_prob": 12,
      "reason": "Clear: peak 12% rain chance."
    },
    {
      "label": "Midday",
      "start": "2026-05-20T10:00",
      "end": "2026-05-20T13:00",
      "verdict": "GO",
      "max_rain_prob": 28,
      "reason": "Clear: peak 28% rain chance."
    },
    {
      "label": "Afternoon",
      "start": "2026-05-20T14:00",
      "end": "2026-05-20T17:00",
      "verdict": "HEAVY_CAUTION",
      "max_rain_prob": 68,
      "reason": "Strong caution: peak 68% rain chance in this window."
    },
    {
      "label": "Evening",
      "start": "2026-05-20T18:00",
      "end": "2026-05-20T20:00",
      "verdict": "LIGHT_CAUTION",
      "max_rain_prob": 42,
      "reason": "Heads up: peak 42% rain chance — keep an eye on the radar."
    }
  ],
  "hourly": [
    {
      "time": "2026-05-20T15:00",
      "hour_local": "15:00",
      "is_tomorrow": true,
      "rain_probability_hrrr": 68,
      "rain_probability_aifs": 22,
      "rain_probability_consensus": 45,
      "precipitation_in_hrrr": 0.10,
      "precipitation_in_aifs": 0.02,
      "precipitation_in_consensus": 0.06,
      "disagreement": true,
      "temperature_f": 82.5,
      "weathercode": 95,
      "windspeed_10m_hrrr": 14,
      "windspeed_10m_aifs": 12,
      "windspeed_10m_consensus": 13.0
    }
  ],
  "models": {
    "hrrr": { "available": true, "id": "gfs_hrrr" },
    "aifs": { "available": true, "id": "ecmwf_aifs025" }
  }
}
```

### Field reference

| Field                          | Type                | Description                                                                                                  |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `location.name`                | string              | Human-readable location label.                                                                               |
| `location.lat`                 | number              | Latitude in decimal degrees.                                                                                 |
| `location.lon`                 | number              | Longitude in decimal degrees.                                                                                |
| `location.timezone`            | string              | IANA timezone. All hourly timestamps are in this zone.                                                       |
| `generatedAt`                  | ISO 8601 string     | Server time the response was assembled. Useful for "last updated" UI.                                        |
| `tomorrow.date`                | `YYYY-MM-DD` string | Local date being forecasted (always tomorrow in `location.timezone`).                                        |
| `tomorrow.verdict`             | enum                | `GO` / `CAUTION` / `NO_GO`. See [DESIGN.md section 3](./DESIGN.md#3-verdict-thresholds).                     |
| `tomorrow.reason`              | string              | Short human-readable explanation of why this verdict was chosen.                                             |
| `tomorrow.maxProb`             | integer 0-100       | Maximum hourly consensus probability across tomorrow.                                                        |
| `tomorrow.precipSumIn`         | number              | Total precipitation expected tomorrow, inches, consensus mean.                                               |
| `tomorrow.peakHourLocal`       | `HH:mm` string      | Local hour with the highest consensus probability.                                                           |
| `windows[]`                    | array of 4 objects  | Morning / Midday / Afternoon / Evening. Always in this order.                                                |
| `windows[].verdict`            | enum                | Same enum, applied to that window's hours only.                                                              |
| `windows[].maxProb`            | integer             | Max consensus probability in that window.                                                                    |
| `windows[].precipSumIn`        | number              | Total precipitation expected in that window, inches.                                                         |
| `windows[].disagree`           | boolean             | True if any hour in the window has model disagreement > 25 pp.                                               |
| `hourly.timeLocal`             | string[]            | 24 entries, `YYYY-MM-DDTHH:mm` local time, midnight to 23:00 of `tomorrow.date`.                             |
| `hourly.precipProbHrrr`        | (int\|null)[]       | HRRR precipitation probability per hour. `null` if HRRR fetch failed (see `models.hrrr.ok`).                 |
| `hourly.precipProbAifs`        | (int\|null)[]       | AIFS precipitation probability per hour. `null` if AIFS fetch failed.                                        |
| `hourly.precipProbMean`        | (int\|null)[]       | Simple average of the two. `null` if either model is missing for that hour.                                  |
| `hourly.precipInHrrr`          | (number\|null)[]    | HRRR hourly precipitation, inches.                                                                           |
| `hourly.precipInAifs`          | (number\|null)[]    | AIFS hourly precipitation, inches.                                                                           |
| `hourly.disagree`              | boolean[]           | True where `abs(precipProbHrrr - precipProbAifs) > 25`.                                                      |
| `models.hrrr.ok` / `aifs.ok`   | boolean             | True if that model returned data. If false, the corresponding hourly arrays are all `null` and the UI should warn. |
| `cache.hit`                    | boolean             | True if this response was served from the in-memory cache.                                                   |
| `cache.ageSeconds`             | integer             | Age of the cached upstream data in seconds. 0 if just fetched.                                               |

### Error responses

#### 502 Bad Gateway — both models failed

```json
{
  "error": "upstream_failed",
  "message": "Both HRRR and AIFS requests to Open-Meteo failed.",
  "details": {
    "hrrr": "fetch timeout after 8000ms",
    "aifs": "fetch timeout after 8000ms"
  }
}
```

If exactly one model fails, the endpoint still returns 200 with the surviving model's data and `models.<failed>.ok: false`. The verdict in that case falls back to the surviving model and `tomorrow.reason` notes the reduced confidence.

#### 503 Service Unavailable — rate-limited upstream

```json
{
  "error": "upstream_rate_limited",
  "message": "Open-Meteo returned 429. Try again shortly.",
  "retryAfterSeconds": 60
}
```

Should be rare given the 10-minute cache. If it happens repeatedly, increase `CACHE_TTL_MS` in `lib/config.js`.

#### 500 Internal Server Error — unexpected

```json
{
  "error": "internal",
  "message": "Unexpected error building forecast."
}
```

## `GET /api/health`

Trivial liveness probe used by the Railway healthcheck.

### Response: 200 OK

```json
{
  "ok": true,
  "uptime": 4271.3
}
```

| Field    | Type    | Description                                          |
| -------- | ------- | ---------------------------------------------------- |
| `ok`     | boolean | Always true if the process is responding.           |
| `uptime` | number  | Seconds since process start (from `process.uptime()`). |

The healthcheck does **not** call Open-Meteo. We do not want a transient upstream outage to cause Railway to restart the process and flush our cache.

## Canonical contract

This document is the canonical API contract. The backend (`server.js`, `lib/forecast.js`) and the frontend (`public/app.js`) both depend on this exact shape. If you change any field name, type, or required-ness, update this file in the same commit.
