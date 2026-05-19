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

### Response: 200 OK

```json
{
  "location": {
    "name": "Santa Barbara, Boca Raton, FL",
    "lat": 26.3797,
    "lon": -80.1539,
    "timezone": "America/New_York"
  },
  "generatedAt": "2026-05-19T13:42:11.000Z",
  "tomorrow": {
    "date": "2026-05-20",
    "verdict": "CAUTION",
    "reason": "Models disagree at peak hour (HRRR 68%, AIFS 22%).",
    "maxProb": 68,
    "precipSumIn": 0.12,
    "peakHourLocal": "15:00"
  },
  "windows": [
    {
      "name": "Morning",
      "startLocal": "06:00",
      "endLocal": "10:00",
      "verdict": "GO",
      "maxProb": 12,
      "precipSumIn": 0.0,
      "disagree": false
    },
    {
      "name": "Midday",
      "startLocal": "10:00",
      "endLocal": "14:00",
      "verdict": "GO",
      "maxProb": 28,
      "precipSumIn": 0.01,
      "disagree": false
    },
    {
      "name": "Afternoon",
      "startLocal": "14:00",
      "endLocal": "18:00",
      "verdict": "NO_GO",
      "maxProb": 68,
      "precipSumIn": 0.11,
      "disagree": true
    },
    {
      "name": "Evening",
      "startLocal": "18:00",
      "endLocal": "21:00",
      "verdict": "CAUTION",
      "maxProb": 42,
      "precipSumIn": 0.02,
      "disagree": false
    }
  ],
  "hourly": {
    "timeLocal": [
      "2026-05-20T00:00",
      "2026-05-20T01:00",
      "2026-05-20T02:00",
      "..."
    ],
    "precipProbHrrr":  [5, 5, 7, 10, 10, 15, 20, 25, 30, 35, 40, 50, 55, 60, 65, 68, 60, 45, 35, 25, 18, 12, 10, 8],
    "precipProbAifs":  [8, 8, 8, 10, 12, 14, 18, 20, 22, 22, 22, 22, 20, 20, 22, 22, 25, 30, 35, 38, 30, 20, 15, 10],
    "precipProbMean":  [7, 7, 8, 10, 11, 15, 19, 23, 26, 29, 31, 36, 38, 40, 44, 45, 43, 38, 35, 32, 24, 16, 13, 9],
    "precipInHrrr":    [0, 0, 0, 0, 0, 0, 0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.10, 0.11, 0.10, 0.08, 0.05, 0.02, 0.01, 0, 0, 0, 0, 0],
    "precipInAifs":    [0, 0, 0, 0, 0, 0, 0, 0,    0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.03, 0.04, 0.05, 0.04, 0.02, 0.01, 0, 0],
    "disagree":        [false, false, false, false, false, false, false, false, false, false, false, true, true, true, true, true, true, false, false, false, false, false, false, false]
  },
  "models": {
    "hrrr": { "id": "gfs_hrrr", "ok": true },
    "aifs": { "id": "ecmwf_aifs025", "ok": true }
  },
  "cache": {
    "hit": true,
    "ageSeconds": 142
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
