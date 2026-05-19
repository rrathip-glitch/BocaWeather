# BocaWeather API Reference

BocaWeather exposes two HTTP endpoints. Both return JSON. No authentication, no API keys, no rate limiting beyond the upstream Open-Meteo limits.

Base URL in development: `http://localhost:3000`
Base URL in production: your Railway-generated domain.

For the reasoning behind the response shape, see [DESIGN.md](./DESIGN.md).

## `GET /api/forecast`

Returns sibling `today` and `tomorrow` forecasts for the configured location, with per-window guidance under each day and full hourly arrays from both models. See [Today's partial day semantics](#todays-partial-day-semantics) for how today is sliced relative to the current local hour.

### Query parameters

| Param     | Values          | Description                                                                                                                |
| --------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `refresh` | `1` or `true`   | Bypass the in-memory cache and re-fetch from Open-Meteo. The fresh result is still written back to the cache so subsequent normal calls get the new value. When set, the response also sends `Cache-Control: no-store` so intermediaries don't serve stale data. |

Example:

```bash
curl -s "http://localhost:3000/api/forecast?refresh=1" | jq '{today: .today, tomorrow: .tomorrow}'
```

### Caching

- Server-side: 10-minute in-memory cache. The Open-Meteo call is only made when the cache is cold, expired, or explicitly bypassed via `?refresh=1`.
- HTTP response header: `Cache-Control: public, max-age=300` (5 minutes) on normal requests; `no-store` when `?refresh=1` is used.
- HTTP response header: `X-Cache: HIT` when the response was served from the in-memory cache, `X-Cache: MISS` when it required an upstream fetch (including all `?refresh=1` calls).

### Tennis-hours-scoped daily stats

`rain_probability_max` and `rain_probability_mean` on both `today` and `tomorrow` are computed over tennis hours only (06:00–21:00 local), not all 24 hours of the day. For tomorrow this is always the full 16-hour set; for today it is just the hours still ahead — see [Today's partial day semantics](#todays-partial-day-semantics). See [DESIGN.md section 3](./DESIGN.md#3-verdict-thresholds) for the rationale. `precipitation_sum_in` continues to reflect the full-day Open-Meteo daily total on both days.

### Today's partial day semantics

`today` is sliced relative to the current local hour in `America/New_York`. The filter that decides which hourly entries feed into `today.verdict` and the tennis-hours-scoped stats is:

- **Before 06:00 local:** include every today hour in `[06, 21]` (the full 16-hour tennis day is still ahead). `today.tennis_hours_remaining === 16`.
- **Between 06:00 and 20:59 local:** include today hours in `[currentHour, 21]`. The current hour is included (we floor to the start of the hour, not the next hour). At 14:32, this is hours 14 through 21 — eight tennis hours.
- **At or after 21:00 local:** today is **concluded**. `today.is_concluded === true`, every numeric/string forecast field is `null` (`verdict`, `rain_probability_max`, `wind_max_mph`, `first_rain_time`, `best_window`, `confidence`, …), and every entry in `today.tennis_windows` has `is_past: true`. Daily metadata that does not depend on remaining hours — `precipitation_sum_in`, `temperature_high_f`, `temperature_low_f`, `sunrise`, `sunset` — stays populated. `today.tennis_hours_remaining === 0`.

`today.tennis_windows[*].is_past` is `true` whenever a window's `endHour <= currentHour`, so an earlier-in-the-day window with great conditions is still visible (with its original verdict) but will not be picked as `today.best_window`. `today.best_window` restricts to non-past windows; if every remaining window is `HEAVY_CAUTION` or every window has already passed, it is `null`.

Tomorrow is never affected by this filter: `tomorrow.tennis_windows[*].is_past` is always `false`, `tomorrow.is_concluded` is always `false`, and there is no `tomorrow.tennis_hours_remaining` field.

### Verdict tier semantics

`today.verdict`, `tomorrow.verdict`, and each `tennis_windows[].verdict` use the same three-value enum (with `today.verdict === null` when today is concluded):

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
  "today": {
    "date": "2026-05-19",
    "label": "today",
    "is_concluded": false,
    "tennis_hours_remaining": 8,
    "verdict": "GO",
    "verdict_reason": "Looks good: peak 18% rain chance during tennis hours.",
    "rain_probability_max": 18,
    "rain_probability_mean": 10,
    "precipitation_sum_in": 0.02,
    "temperature_high_f": 83,
    "temperature_low_f": 71,
    "sunrise": "2026-05-19T06:31",
    "sunset": "2026-05-19T19:59",
    "model_agreement": "AGREE",
    "uncertainty_note": null,
    "wind_max_mph": 9,
    "wind_mean_mph": 6,
    "wind_gust_max_mph": 17,
    "first_rain_time": null,
    "first_rain_hour_local": null,
    "best_window": { "label": "Evening", "max_rain_prob": 8, "verdict": "GO" },
    "confidence": "HIGH",
    "confidence_note": "Both models agree within 3 pts on average.",
    "tennis_windows": [
      {
        "label": "Morning",
        "start": "2026-05-19T06:00",
        "end": "2026-05-19T09:00",
        "verdict": "GO",
        "max_rain_prob": 5,
        "reason": "Clear: peak 5% rain chance.",
        "is_past": true
      },
      {
        "label": "Midday",
        "start": "2026-05-19T10:00",
        "end": "2026-05-19T13:00",
        "verdict": "GO",
        "max_rain_prob": 12,
        "reason": "Clear: peak 12% rain chance.",
        "is_past": true
      },
      {
        "label": "Afternoon",
        "start": "2026-05-19T14:00",
        "end": "2026-05-19T17:00",
        "verdict": "GO",
        "max_rain_prob": 18,
        "reason": "Clear: peak 18% rain chance.",
        "is_past": false
      },
      {
        "label": "Evening",
        "start": "2026-05-19T18:00",
        "end": "2026-05-19T20:00",
        "verdict": "GO",
        "max_rain_prob": 8,
        "reason": "Clear: peak 8% rain chance.",
        "is_past": false
      }
    ]
  },
  "tomorrow": {
    "date": "2026-05-20",
    "label": "tomorrow",
    "is_concluded": false,
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
    "wind_gust_max_mph": 27,
    "first_rain_time": "2026-05-20T15:00",
    "first_rain_hour_local": "3:00 PM",
    "best_window": { "label": "Morning", "max_rain_prob": 12, "verdict": "GO" },
    "confidence": "MODERATE",
    "confidence_note": "Models differ by 9 pts on average — moderate uncertainty.",
    "tennis_windows": [
      {
        "label": "Morning",
        "start": "2026-05-20T06:00",
        "end": "2026-05-20T09:00",
        "verdict": "GO",
        "max_rain_prob": 12,
        "reason": "Clear: peak 12% rain chance.",
        "is_past": false
      },
      {
        "label": "Midday",
        "start": "2026-05-20T10:00",
        "end": "2026-05-20T13:00",
        "verdict": "GO",
        "max_rain_prob": 28,
        "reason": "Clear: peak 28% rain chance.",
        "is_past": false
      },
      {
        "label": "Afternoon",
        "start": "2026-05-20T14:00",
        "end": "2026-05-20T17:00",
        "verdict": "HEAVY_CAUTION",
        "max_rain_prob": 68,
        "reason": "Strong caution: peak 68% rain chance in this window.",
        "is_past": false
      },
      {
        "label": "Evening",
        "start": "2026-05-20T18:00",
        "end": "2026-05-20T20:00",
        "verdict": "LIGHT_CAUTION",
        "max_rain_prob": 42,
        "reason": "Heads up: peak 42% rain chance — keep an eye on the radar.",
        "is_past": false
      }
    ]
  },
  "hourly": [
    {
      "time": "2026-05-20T15:00",
      "hour_local": "15:00",
      "is_tomorrow": true,
      "rain_probability_hrrr": 68,
      "rain_probability_ifs": 22,
      "rain_probability_consensus": 45,
      "precipitation_in_hrrr": 0.10,
      "precipitation_in_ifs": 0.02,
      "precipitation_in_consensus": 0.06,
      "disagreement": true,
      "temperature_f": 82.5,
      "weathercode": 95,
      "windspeed_10m_hrrr": 14,
      "windspeed_10m_ifs": 12,
      "windspeed_10m_consensus": 13.0,
      "wind_gusts_10m_hrrr": 27,
      "wind_gusts_10m_ifs": 24,
      "wind_gusts_10m_consensus": 25.5
    }
  ],
  "models": {
    "hrrr": { "available": true, "id": "gfs_hrrr" },
    "ifs": { "available": true, "id": "ecmwf_ifs025" }
  }
}
```

### Field reference

The `today` and `tomorrow` objects share the same field shape. `today` adds two fields (`tennis_hours_remaining`, plus the meaningful `is_concluded: true` code path) and may render `null` for most numeric/string forecast fields when concluded; `tomorrow` is always built fresh from the full 16-hour tennis day. The table below documents `today.*` once; every `today.*` row also applies to the equivalent `tomorrow.*` field unless noted.

| Field                                   | Type                | Description                                                                                                  |
| --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `location.name`                         | string              | Human-readable location label.                                                                               |
| `location.lat`                          | number              | Latitude in decimal degrees.                                                                                 |
| `location.lon`                          | number              | Longitude in decimal degrees.                                                                                |
| `location.timezone`                     | string              | IANA timezone. All hourly timestamps are in this zone.                                                       |
| `generated_at`                          | ISO 8601 string     | Server time the response was assembled. Useful for "last updated" UI.                                        |
| `cached`                                | boolean             | True if this response was served from the 10-minute in-memory cache.                                         |
| `today`                                 | object              | Forecast for today (the local calendar date in `location.timezone`). See [Today's partial day semantics](#todays-partial-day-semantics). |
| `tomorrow`                              | object              | Forecast for tomorrow. Same field shape as `today`, minus `tennis_hours_remaining`. Always full 06:00–21:00. |
| `today.date`                            | `YYYY-MM-DD` string | Local date being forecasted.                                                                                 |
| `today.label`                           | string              | `"today"` on the today object, `"tomorrow"` on the tomorrow object.                                          |
| `today.is_concluded`                    | boolean             | `true` on today when the current local hour is `>= 21` (no tennis hours remain). Always `false` on tomorrow. When `true`, most forecast fields are `null` — see [Today's partial day semantics](#todays-partial-day-semantics). |
| `today.tennis_hours_remaining`          | integer             | Count of tennis hours (06:00–21:00 local) still ahead today. `0` when concluded. **Omitted entirely on tomorrow.** |
| `today.verdict`                         | enum \| null        | `"GO" \| "LIGHT_CAUTION" \| "HEAVY_CAUTION"`. `null` when today is concluded. See [Verdict tier semantics](#verdict-tier-semantics). |
| `today.verdict_reason`                  | string              | Short human-readable explanation of why this verdict was chosen. On a concluded today: `"Tennis day complete — check Tomorrow for the next forecast."` |
| `today.rain_probability_max`            | integer 0-100 \| null | Maximum hourly consensus probability across the remaining tennis hours. `null` when concluded.             |
| `today.rain_probability_mean`           | integer 0-100 \| null | Mean hourly consensus probability across the remaining tennis hours. `null` when concluded.                |
| `today.precipitation_sum_in`            | number              | Total precipitation expected today (full-day Open-Meteo daily total), inches. Populated even when concluded. |
| `today.temperature_high_f`              | number              | Forecast high temperature, Fahrenheit. Populated even when concluded.                                        |
| `today.temperature_low_f`               | number              | Forecast low temperature, Fahrenheit. Populated even when concluded.                                         |
| `today.sunrise`                         | ISO string          | Local sunrise timestamp. Populated even when concluded.                                                      |
| `today.sunset`                          | ISO string          | Local sunset timestamp. Populated even when concluded.                                                       |
| `today.model_agreement`                 | enum                | `"AGREE" \| "DISAGREE"`. DISAGREE if any remaining tennis hour has `disagreement: true`. `"AGREE"` on concluded today. |
| `today.uncertainty_note`                | string \| null      | Set if only one model is available, otherwise `null`.                                                        |
| `today.wind_max_mph`                    | integer \| null     | Max consensus sustained wind across the remaining tennis hours, rounded. `null` when concluded or no wind data. |
| `today.wind_mean_mph`                   | integer \| null     | Mean consensus sustained wind across the remaining tennis hours, rounded. `null` when concluded.                |
| `today.wind_gust_max_mph`               | integer \| null     | Max consensus wind gust (from `wind_gusts_10m`) across the remaining tennis hours, rounded. Gusts above ~25 mph disrupt ball toss and lobs even with no rain risk. `null` when concluded or both models lack gust data. |
| `today.first_rain_time`                 | ISO string \| null  | Timestamp of first remaining tennis hour with `rain_probability_consensus >= 50`. `null` if no such hour or concluded. |
| `today.first_rain_hour_local`           | string \| null      | Same hour formatted `"H:MM AM/PM"` in `location.timezone`. `null` when no first rain or concluded.           |
| `today.best_window`                     | object \| null      | Best non-past tennis window today: `{ label, max_rain_prob, verdict }`. `null` if every remaining window is `HEAVY_CAUTION` or all windows are past (concluded). |
| `today.confidence`                      | enum \| null        | `"HIGH" \| "MODERATE" \| "LOW"`. Binned from mean per-hour absolute difference between HRRR and IFS over remaining tennis hours. `null` when concluded. |
| `today.confidence_note`                 | string              | Human-readable note explaining the confidence rating. On a concluded today: `"Tennis day complete."` |
| `today.tennis_windows[]`                | array of 4 objects  | Morning / Midday / Afternoon / Evening. Always 4 entries in this order, even on concluded today.             |
| `today.tennis_windows[].label`          | string              | `"Morning" \| "Midday" \| "Afternoon" \| "Evening"`.                                                         |
| `today.tennis_windows[].start`          | ISO string          | First hour timestamp included in the window.                                                                 |
| `today.tennis_windows[].end`            | ISO string          | Last hour timestamp included in the window.                                                                  |
| `today.tennis_windows[].verdict`        | enum                | `"GO" \| "LIGHT_CAUTION" \| "HEAVY_CAUTION"`, applied to that window's hours only. Reflects what the model said would happen, even for past windows. |
| `today.tennis_windows[].max_rain_prob`  | integer             | Max consensus probability in that window.                                                                    |
| `today.tennis_windows[].reason`         | string              | Short human-readable verdict reason for that window.                                                         |
| `today.tennis_windows[].is_past`        | boolean             | `true` when the window's `endHour <= currentHour` (today only); always `false` on tomorrow's windows. Frontend can dim past windows in the UI. |
| `hourly[].time`                         | string              | Naive local timestamp `YYYY-MM-DDTHH:mm`.                                                                    |
| `hourly[].hour_local`                   | string              | Local hour formatted `HH:00`.                                                                                |
| `hourly[].is_tomorrow`                  | boolean             | True if the timestamp falls on `tomorrow.date`; false if it falls on `today.date`. The `hourly[]` array contains today's remaining hours plus all of tomorrow. |
| `hourly[].rain_probability_hrrr`        | int \| null         | HRRR precipitation probability for this hour. `null` if HRRR is unavailable.                                 |
| `hourly[].rain_probability_ifs`        | int \| null         | IFS precipitation probability for this hour. `null` if IFS is unavailable.                                 |
| `hourly[].rain_probability_consensus`   | int                 | Mean of the two models (or whichever is available). Integer 0-100.                                           |
| `hourly[].precipitation_in_hrrr`        | number \| null      | HRRR hourly precipitation, inches.                                                                           |
| `hourly[].precipitation_in_ifs`        | number \| null      | IFS hourly precipitation, inches.                                                                           |
| `hourly[].precipitation_in_consensus`   | number              | Mean of the two models, inches.                                                                              |
| `hourly[].disagreement`                 | boolean             | True where `abs(rain_probability_hrrr - rain_probability_ifs) > 25`.                                        |
| `hourly[].temperature_f`                | number \| null      | Consensus temperature, Fahrenheit.                                                                           |
| `hourly[].weathercode`                  | int \| null         | WMO weathercode (whichever model reports first).                                                             |
| `hourly[].windspeed_10m_hrrr`           | number \| null      | HRRR sustained wind speed at 10 m, mph.                                                                      |
| `hourly[].windspeed_10m_ifs`           | number \| null      | IFS sustained wind speed at 10 m, mph.                                                                      |
| `hourly[].windspeed_10m_consensus`      | number \| null      | Mean of the two model sustained wind speeds, mph.                                                            |
| `hourly[].wind_gusts_10m_hrrr`          | number \| null      | HRRR peak 10 m wind gust for the hour, mph. From NOAA GRIB `GUST` field.                                     |
| `hourly[].wind_gusts_10m_ifs`          | number \| null      | IFS peak 10 m wind gust for the hour, mph.                                                                  |
| `hourly[].wind_gusts_10m_consensus`     | number \| null      | Mean of the two model gust speeds, mph. Surfaced when materially higher than sustained.                      |
| `models.hrrr.available` / `ifs.available` | boolean          | True if that model returned data this cycle.                                                                 |
| `models.hrrr.id` / `ifs.id`            | string              | The Open-Meteo model identifier used (e.g. `gfs_hrrr`, `ecmwf_ifs025`).                                     |

### Error responses

#### 502 Bad Gateway — both models failed

```json
{
  "error": "upstream_failed",
  "message": "Both HRRR and IFS requests to Open-Meteo failed.",
  "details": {
    "hrrr": "fetch timeout after 8000ms",
    "ifs": "fetch timeout after 8000ms"
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
