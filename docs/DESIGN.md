# BocaWeather Design Document

This document explains why BocaWeather is built the way it is. If you are a new agent or contributor extending this app, read this before touching code. The accompanying [API.md](./API.md), [DEPLOYMENT.md](./DEPLOYMENT.md), and [AGENT_HANDOFF.md](./AGENT_HANDOFF.md) cover the surface; this document covers the substance.

## 1. Problem statement

The users are members of the Santa Barbara community in Boca Raton, Florida (lat 26.3683, lon -80.1289). They want to know one thing: **should I plan to play tennis tomorrow, and at what time of day?**

Boca Raton's weather is dominated for half the year by afternoon convective storms. These storms have three properties that break naive weather apps:

1. **They are small.** A typical Florida summer cell is 5-15 km wide. That is below the effective resolution of every global weather model.
2. **They are short.** A cell that dumps half an inch can pass over a tennis court in 20 minutes.
3. **They are stochastic in placement.** Tomorrow's 3pm storm is genuinely likely. Whether it hits this court or the one 5 miles north is, from the model's point of view, close to a coin flip.

A single-model forecast that says "60% chance of rain at 3pm" therefore hides the real signal: "we know storms will fire; we do not know if your court will get hit." Users learn quickly that one-number forecasts are unreliable in Florida summer, and they stop trusting any forecast at all.

The user has been explicit: **the priority of this app is the accuracy of next-day and hourly rain forecasts.** Not features. Not styling. Accuracy.

## 2. Solution approach

We do not try to beat the models. We surface the disagreement between two good, independent models and let the user act on it.

For every hour of tomorrow's local day we fetch precipitation probability and precipitation amount from two models:

- **NOAA HRRR** (`gfs_hrrr` in Open-Meteo) — 3 km native horizontal resolution, run hourly by NOAA, US-only. HRRR is widely regarded as the best operational model for short-range (0-48h) convective forecasts over the continental US. It is the model most TV meteorologists are looking at for "will there be a storm this afternoon" questions.
- **ECMWF AIFS** (`ecmwf_aifs025` in Open-Meteo) — ECMWF's AI-based global forecast model (0.25 degree). It is trained on decades of ERA5 reanalysis and has shown skill comparable to or exceeding the IFS physical model on many headline metrics. Critically for our purposes, its error modes are different from HRRR's: AIFS is global and learned, HRRR is regional and physical.

For each hour we compute:

- `p_hrrr` — HRRR precipitation probability (0-100).
- `p_aifs` — AIFS precipitation probability (0-100).
- `p_mean = (p_hrrr + p_aifs) / 2` — simple-average consensus.
- `disagreement = abs(p_hrrr - p_aifs)`.
- `disagree = disagreement > 25` — boolean flag rendered prominently in the UI.

We also pull precipitation amount (inches) from both models and compute the same consensus.

The UI is built so a disagreement does not look like an error. It looks like information. "HRRR says 70%, AIFS says 20% — models disagree, treat tomorrow afternoon as uncertain" is a more useful sentence than "55% chance of rain."

## 3. Verdict thresholds

The day-level verdict for "should I play tomorrow" is one of three values. The exact rules:

### GO

All of:

- Max hourly precipitation probability across the day < 35%
- Total precipitation sum for the day < 0.05 in
- No hour with model disagreement > 25 percentage points at the peak hour

### CAUTION

Any of:

- Max hourly precipitation probability between 35% and 60%
- Models disagree by > 30 percentage points at the peak hour
- Daily precipitation sum between 0.05 and 0.20 in

### NO_GO

Any of:

- Max hourly precipitation probability > 60%
- Daily precipitation sum > 0.20 in

These thresholds are tuned for tennis specifically: a tennis court takes 30-60 minutes to dry after a brief shower and is unplayable during one. They are not generic "is it sunny" thresholds and should not be reused for other activities without re-tuning.

When changing these numbers, update this section of this document **in the same commit** as the code change. The thresholds are part of the product, not implementation details.

## 4. Tennis windows

The day is split into four windows that match the community's actual play patterns:

| Window    | Local hours |
| --------- | ----------- |
| Morning   | 06:00-10:00 |
| Midday    | 10:00-14:00 |
| Afternoon | 14:00-18:00 |
| Evening   | 18:00-21:00 |

Each window gets its own verdict (GO / CAUTION / NO_GO) computed by applying the same thresholds to **that window's hours only**. This is what lets a user see "morning is fine, afternoon is a wash, evening might clear up" — which is the practical Florida summer pattern.

The window boundaries live in `lib/forecast.js` as `TENNIS_WINDOWS`. The frontend layout assumes four windows; changing the count requires a frontend change too.

## 5. Why no nowcasting in this app

We deliberately do not try to answer "is it about to rain in the next hour" — and we do not pretend to. Model forecasts run hourly, and even HRRR's 1-hour outputs are not the right tool for the 15-minutes-before-match decision.

For the very-short-range decision ("we are walking to the court now, is the cell over us"), use radar:

- [RainViewer](https://www.rainviewer.com/) — free, web and mobile, animated radar.
- RadarScope — paid, what serious storm spotters use.

This is an explicit non-goal so that a future agent does not bolt on a half-working nowcaster and dilute the day-before product. Radar and forecast models answer different questions on different time horizons. Keep them separate.

## 6. Stack rationale

- **Node.js 20 + Express 4 (ESM, single process)** — One process is enough for the load and the cache lives in process memory. No external dependencies (no Redis, no DB) means Railway deploys are trivial and there is nothing to misconfigure. Node 20 is current LTS.
- **No frontend framework** — Plain HTML, Tailwind via CDN, Chart.js via CDN, one `app.js` file. There is no build step. The page loads instantly on mobile and there is nothing to break in CI. The app's value is in the data, not the UI plumbing.
- **Open-Meteo** — Free, no API key, no signup, both HRRR and AIFS available via the same endpoint with a `models=` parameter. Generous rate limits (~10k req/day free). The alternative is paying NOAA/ECMWF directly, which is overkill for this app.
- **10-minute in-memory cache** — Open-Meteo updates HRRR hourly and AIFS less often. A 10-minute cache cuts our outbound requests to roughly six per hour even under load, well inside the free-tier budget. Cache is intentionally process-local: a Railway restart flushes it, which is the simplest possible cache invalidation story.
- **No database** — There is no user state, no history (yet), and no need to persist anything across restarts. Adding a DB would be the largest possible architectural change for zero current product value.

## 7. Project structure

```
BocaWeather/
  server.js                # Express app, mounts /api routes, serves /public, listens on PORT
  package.json             # Deps: express, node-fetch (or undici); type: module
  railway.json             # Railway build + healthcheck config
  .node-version            # Pins Node 20 for Railway / nvm / fnm
  .gitignore
  README.md
  lib/
    config.js              # LOCATION, CACHE_TTL_MS, MODELS list — single source of truth
    openMeteo.js           # fetchForecast(); calls Open-Meteo with both models, returns normalized arrays
    forecast.js            # buildForecast(); applies thresholds, computes windows, flags disagreement
    cache.js               # tiny TTL cache wrapping fetchForecast
  public/
    index.html             # Tailwind layout, mounts Chart.js canvas, loads app.js
    app.js                 # Fetches /api/forecast, renders verdict card, windows grid, hourly chart
    favicon.svg
  docs/
    DESIGN.md              # This file
    API.md                 # API schema and examples
    DEPLOYMENT.md          # Railway deploy steps + troubleshooting
    AGENT_HANDOFF.md       # Onboarding doc for new agents
```

## 8. Non-goals

The following are explicitly out of scope for this version. Anyone adding them needs a real reason and should update this section.

- **General-purpose weather app.** No temperature dashboards, no wind roses, no 10-day outlook. Rain probability for tennis, that is it.
- **Multiple locations.** One location, hardcoded in `lib/config.js`. Adding more requires a frontend selector and a routing decision; not worth it until requested.
- **Push notifications / alerts.** No accounts, no subscriptions, no email. Stateless app.
- **Nowcasting.** See section 5.
- **Historical accuracy tracking.** Worth doing eventually (it would let us validate the thresholds in section 3) but requires a database and is not in scope now.
- **User accounts.** None.
