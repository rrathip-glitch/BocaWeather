# BocaWeather

Tennis-focused, dual-model rain forecasts for the Santa Barbara community in Boca Raton, FL.

## What it does

BocaWeather answers one question: "Can I play tennis tomorrow, and if so, when?" It pulls hourly precipitation forecasts from two independent weather models (NOAA HRRR and ECMWF AIFS) for the Santa Barbara community in Boca Raton and converts them into a simple GO / CAUTION / NO_GO verdict plus per-window guidance for morning, midday, afternoon, and evening play. By comparing the two models against each other, the app surfaces honest forecast uncertainty instead of pretending a single model is gospel.

## Why dual-model?

Florida summer storms are sub-grid-scale convective cells: a single model can easily misplace tomorrow's 3pm thunderstorm by 20 miles or 2 hours. Most weather apps hide this by showing one number.

BocaWeather fetches two models with very different lineages:

- **NOAA HRRR** — 3 km native resolution, US-only, the gold standard for short-range US convective forecasts.
- **ECMWF AIFS** — ECMWF's new AI-based global model, a strong independent check with different error modes than HRRR.

When the two models agree, confidence is high and we say so. When they disagree by more than 25 percentage points at a given hour, we flag it. That honest disagreement signal is the actual edge over single-model apps.

## Quick start

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

The server listens on `process.env.PORT || 3000`.

## Deploy to Railway

See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for the full Railway deployment walkthrough. Short version: push to GitHub, point Railway at the repo, Nixpacks auto-detects Node 20, healthcheck is wired to `/api/health`.

## Architecture

Single Node.js Express process serving a static frontend from `/public` and a tiny JSON API from `/api`. No database, no build step, no framework on the frontend. A 10-minute in-memory cache sits in front of the Open-Meteo call.

```
BocaWeather/
  server.js          # Express bootstrap, route mounting, static hosting
  lib/
    config.js        # Location, timezone, cache TTL, model list
    openMeteo.js     # Open-Meteo client; fetches HRRR + AIFS
    forecast.js      # Verdict logic, tennis windows, disagreement flags
    cache.js         # 10-min in-memory cache
  public/
    index.html       # Tailwind layout
    app.js           # Renders forecast + Chart.js chart
    favicon.svg
  docs/
    DESIGN.md        # Why the app is built this way
    API.md           # API reference
    DEPLOYMENT.md    # Railway deploy steps
    AGENT_HANDOFF.md # Read this first if you're a new agent on this repo
  railway.json
  .node-version
  package.json
```

## API

Two endpoints. Full schema in [docs/API.md](./docs/API.md).

- `GET /api/forecast` — Returns location, tomorrow verdict (GO / CAUTION / NO_GO), per-window guidance, and full hourly arrays with both models' probabilities and disagreement flags.
- `GET /api/health` — Returns `{ ok: true, uptime: <seconds> }`.

## Configuration

All tunables live in `lib/config.js`:

- `LOCATION` — `{ name, lat, lon, timezone }`. Default is the Santa Barbara community in Boca Raton, FL — NE corner of Jog Rd & Glades Rd, zip 33434 (lat 26.3797, lon -80.1539, `America/New_York`).
- `CACHE_TTL_MS` — In-memory cache lifetime. Default 10 minutes. Do not drop below 5 minutes (Open-Meteo etiquette).
- `MODELS` — The two Open-Meteo model identifiers we compare. Default `['gfs_hrrr', 'ecmwf_aifs025']`.

To move the location, edit `LOCATION` and redeploy. To change verdict thresholds, see [docs/DESIGN.md](./docs/DESIGN.md) and edit `lib/forecast.js`.

## Data source

[Open-Meteo](https://open-meteo.com) — free, no API key, generous rate limits (around 10k requests/day on the free tier). Both HRRR and AIFS are exposed via the same `/v1/forecast` endpoint by passing the `models=` parameter.

## License

MIT.
