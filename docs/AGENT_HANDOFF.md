# Agent Handoff

You are a Claude (or other) agent who just opened the BocaWeather repository with zero prior context. This document exists so you can continue work without losing what was already decided. Read it end-to-end before editing any code.

## 1. What this project is

BocaWeather is a small Node.js + Express website that gives a single community — the Santa Barbara community in Boca Raton, FL — a tennis-focused rain forecast for tomorrow. It pulls hourly precipitation forecasts from two independent weather models via the free Open-Meteo API and compares them. The whole product is that comparison: when the two models agree the user can trust the verdict, and when they disagree the UI says so honestly.

## 2. The explicit user goal

> Accuracy of next-day and hourly rain forecasts for the Santa Barbara community in Boca Raton.

This was stated explicitly by the user. It is the only success metric. Features, polish, scope expansion — all are subordinate to forecast accuracy. If a change you are considering does not improve accuracy or honestly communicate uncertainty, push back on it.

## 3. Where to start reading

In this order:

1. [DESIGN.md](./DESIGN.md) — Why the app is built this way. Verdict thresholds, dual-model rationale, non-goals. This is the most important document in the repo.
2. [API.md](./API.md) — The canonical API contract. Both `server.js` and `public/app.js` are written against this shape.
3. `server.js` — Express bootstrap. Small file. Mounts the routes, serves `/public`, listens on `process.env.PORT || 3000`.
4. `lib/config.js` — Single source of truth for location, timezone, cache TTL, model list.
5. `lib/openMeteo.js` — Open-Meteo client. Builds the URL with both models, normalizes the response.
6. `lib/forecast.js` — Threshold logic. Verdict, windows, disagreement flag. **The `VERDICT` enum at the top of this file is the source of truth for tier names** (`HEAVY_CAUTION`, `LIGHT_CAUTION`, `GO`); every other reference in the codebase and docs must match it.
7. `lib/cache.js` — Trivial TTL cache.
8. `public/index.html` and `public/app.js` — Frontend. Tailwind + Chart.js, no framework, no build step.

Then skim [DEPLOYMENT.md](./DEPLOYMENT.md) so you know how it ships.

## 4. Critical invariants — DO NOT BREAK

These are load-bearing decisions. If you change any of them, do so deliberately and document the change in [DESIGN.md](./DESIGN.md) in the same commit.

1. **Dual-model comparison is the product.** Do not silently drop one model to simplify the UI. If a model fetch fails, the API returns the surviving model's data with `models.<failed>.ok: false`, and the frontend warns the user. Removing this comparison removes the reason the app exists.
2. **The 35% / 60% thresholds are tuned for tennis.** Not for "is it sunny." A tennis court takes 30-60 minutes to dry after a shower and is unplayable during one. Do not retune these numbers without a discussion of why.
3. **Location lives in `lib/config.js` only.** Never hardcode lat/lon, timezone, or the location label anywhere else. If you find it duplicated, that is a bug.
4. **Cache TTL is 10 minutes. Do not drop below 5 minutes.** That is the Open-Meteo etiquette floor; going below it risks rate limits and is rude to a free service.
5. **The "disagreement" visualization is a feature, not noise.** When HRRR and AIFS disagree, the UI shows a chip or shaded band. A future agent may be tempted to "clean it up" or hide it behind an advanced toggle. Do not. That disagreement is the user's accuracy edge over single-model apps.
6. **`/api/health` does not call Open-Meteo.** It only reports process liveness. Routing it through the upstream would let an Open-Meteo outage trigger Railway restarts that flush our cache.
7. **Verdict tier names are `HEAVY_CAUTION` / `LIGHT_CAUTION` / `GO`. Do NOT reintroduce `NO_GO` or "Skip it" wording — the user specifically rejected absolutist phrasing. Heavy caution is strong but not a hard "don't play" call.** Reason strings follow fixed prefixes: "Strong caution: …" for `HEAVY_CAUTION`, "Heads up: …" for `LIGHT_CAUTION`, "Looks good: …" for `GO`.
8. **`LIGHT_CAUTION` must present visibly softer than `HEAVY_CAUTION` and `GO`. If you change the hero typography, preserve that hierarchy.** Both end tiers shout (large weight, full glow); the middle tier murmurs (smaller font, lighter weight, lower-opacity glow). Equalizing the visual weight would push `LIGHT_CAUTION` back toward the absolutist reading the rename in invariant 7 was meant to walk away from.
9. **The tennis-accuracy fields on `tomorrow` are part of the API contract. Removing them silently breaks the frontend.** The fields are `wind_max_mph`, `wind_mean_mph`, `first_rain_time`, `first_rain_hour_local`, `best_window`, `confidence`, and `confidence_note`. If you need to deprecate one, coordinate the change across `lib/forecast.js`, `public/app.js`, `docs/API.md`, `docs/BACKEND.md`, and `docs/FRONTEND.md` in the same commit.
10. **`best_window` may be `null` when all four windows are `HEAVY_CAUTION`. The frontend handles `null` — don't fake a window to avoid `null`.** That `null` is meaningful product information ("there is no clean window tomorrow"); inventing a fake "best" recommends play on a day the model says is bad.

## 5. Common tasks

### Add a new location

1. Edit `lib/config.js` and change the `LOCATION` constant (`name`, `lat`, `lon`, `timezone`).
2. Redeploy.

If you want to support multiple locations simultaneously, that is a larger change: the API needs a `?location=` query param, the cache key needs to include it, and the frontend needs a selector. See "Known limitations" below.

### Add a new tennis window

1. Edit `TENNIS_WINDOWS` in `lib/forecast.js`. Each entry is `{ name, startHour, endHour }` in local-time integers.
2. Update the frontend grid in `public/index.html` (and `public/app.js`) to render the new count of windows. The frontend currently assumes four.
3. Update the table in [DESIGN.md section 4](./DESIGN.md#4-tennis-windows).

### Swap or add a model

1. Edit `MODELS` in `lib/config.js` (or `lib/openMeteo.js` if that is where the list is). Verify the model ID against the [Open-Meteo model docs](https://open-meteo.com/en/docs).
2. Confirm the variable name suffixes in the Open-Meteo response: when you pass `models=A,B`, hourly variables come back as `precipitation_probability_A` and `precipitation_probability_B`. The normalization in `lib/openMeteo.js` must match.
3. If you are going from two models to three, decide what "disagreement" means. Pairwise max? Standard deviation? Do not just compute a mean and call it a day — re-read [DESIGN.md section 2](./DESIGN.md#2-solution-approach).

### Change verdict thresholds

1. Edit `lib/forecast.js`.
2. **Same commit:** update [DESIGN.md section 3](./DESIGN.md#3-verdict-thresholds) so the numbers in code and docs match.
3. Consider whether the user-facing copy needs to change.

Note on tier **names**: the current names (`HEAVY_CAUTION` / `LIGHT_CAUTION` / `GO`) are deliberately non-absolutist — see invariant 7 above. If you rename them again, the rename must propagate, in the same commit, to:

- `lib/forecast.js` (`VERDICT` enum, classification logic, reason-string prefixes)
- `server.js` (no current references expected, but verify with grep)
- `public/app.js` (verdict label map, color map, font-size/weight map)
- All four docs: [DESIGN.md](./DESIGN.md), [API.md](./API.md), [BACKEND.md](./BACKEND.md), [FRONTEND.md](./FRONTEND.md)

A half-renamed app where the API returns one label and the UI expects another will appear to "work" until the verdict happens to be the renamed tier.

## 6. Known limitations and future work

- **Single location.** See "Add a new location" above. Multi-location requires a frontend selector and a routing decision.
- **No push notifications.** No accounts, no email, no SMS. Adding any of these is a substantial architectural shift (state, secrets, abuse handling).
- **No nowcasting.** Deliberate — see [DESIGN.md section 7](./DESIGN.md#7-why-no-nowcasting-in-this-app). If you want a "is it raining right now" view, integrate radar tiles ([RainViewer](https://www.rainviewer.com/) has a free tile API) as a clearly separated component. Do not try to make model forecasts answer the nowcast question.
- **No historical accuracy tracking.** This would be valuable for re-tuning the verdict thresholds against ground truth, but it requires a database. Out of scope for now.
- **No tests.** The app is small enough that this has not bitten us, but a few unit tests around `lib/forecast.js` (verdict logic, window slicing, disagreement flag) would be cheap and worthwhile.
- **No retry on Open-Meteo failure.** A single transient upstream hiccup will show stale-or-error UI for up to one cache cycle. A small retry-with-backoff in `lib/openMeteo.js` would be a nice improvement.

## 7. How to run locally

```bash
npm install
npm start
```

Then open <http://localhost:3000>. The server reads `process.env.PORT || 3000`.

You should see the verdict card, four window tiles, and an hourly probability chart for tomorrow. If you see `models.hrrr.ok: false` or `models.aifs.ok: false` in the network response, Open-Meteo (or your network) blocked one of the model fetches.

## 8. How to deploy

Full walkthrough: [DEPLOYMENT.md](./DEPLOYMENT.md).

Short version: push to GitHub on branch `claude/weather-prediction-website-DhTIq`, create a Railway project from the repo, pick that branch, wait for the build. Nixpacks auto-detects Node 20 from `.node-version`. The healthcheck `/api/health` is configured in `railway.json`. Generate a domain in Railway → Settings → Networking.

No environment variables are required.
