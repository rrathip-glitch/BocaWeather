# BocaWeather Design Document

This document explains why BocaWeather is built the way it is. If you are a new agent or contributor extending this app, read this before touching code. The accompanying [API.md](./API.md), [DEPLOYMENT.md](./DEPLOYMENT.md), and [AGENT_HANDOFF.md](./AGENT_HANDOFF.md) cover the surface; this document covers the substance.

## 1. Problem statement

The users are members of the Santa Barbara community in Boca Raton, Florida — a gated community on the NE corner of Jog Road and Glades Road, zip 33434 (lat 26.3797, lon -80.1539). They want to know one thing: **should I plan to play tennis tomorrow, and at what time of day?**

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

The day-level verdict for "should I play tomorrow" is one of three values: `HEAVY_CAUTION` (displayed as "HEAVY CAUTION"), `LIGHT_CAUTION` (displayed as "CAUTION"), and `GO`. **The two cautionary tier names were renamed in this pass** — the worst tier used to be a hard-no label and the middle tier used to be unqualified caution. The thresholds, computation, and classification logic are **unchanged** — only the labels and the human-readable reason strings changed. The rename exists because the user rejected absolutist "do not play" framing: even the worst-looking day is rarely a hard call, and the new names reflect that judgement.

All daily stats are scoped to **tennis hours**: the contiguous block 06:00 through 21:00 local time tomorrow (16 hourly slots, 06..21 inclusive). Daily verdicts use the 6am-9pm window because that's the tennis day. A 3am thunderstorm shouldn't change tomorrow's tennis verdict if afternoon is clear.

From those 16 tennis hours we compute:

- `heavyHours` — count of tennis hours with consensus rain probability ≥ 60%.
- `tennisPrecip` — sum of consensus precipitation across the tennis hours, in inches.
- `peakTennisProb` — max consensus rain probability across the tennis hours.
- `disagreementAtRiskyHour` — true if any tennis hour has model disagreement AND consensus probability ≥ 35%.

### HEAVY_CAUTION

Any of:

- `heavyHours >= 6` (six or more tennis hours at ≥ 60% rain chance)
- `tennisPrecip >= 0.4` in (heavy total rainfall expected during play hours)

Reasons in this tier are phrased as "Strong caution: …" (for example, "Strong caution: 7 tennis hours show rain probability at or above 60%").

### LIGHT_CAUTION

Any of (and not already HEAVY_CAUTION):

- `peakTennisProb >= 50` (a single hour with material rain risk)
- `tennisPrecip >= 0.1` in
- `disagreementAtRiskyHour` (models disagree at a meaningfully-wet hour)

Reasons in this tier are phrased as "Heads up: …" (for example, "Heads up: peak hourly rain probability is 55% during tennis hours").

### GO

None of the above. Reasons stay phrased as "Looks good: …" (for example, "Looks good: low rain probability and no model disagreement during tennis hours").

If multiple reasons apply, the response surfaces the most relevant one: HEAVY_CAUTION heavy-hours wins over HEAVY_CAUTION precip; LIGHT_CAUTION peak wins over LIGHT_CAUTION disagreement.

These thresholds are tuned for tennis specifically: a tennis court takes 30-60 minutes to dry after a brief shower and is unplayable during one. They are not generic "is it sunny" thresholds and should not be reused for other activities without re-tuning.

Window verdicts (Morning / Midday / Afternoon / Evening) remain scoped to their own hours with the original thresholds — see section 4. Only the daily verdict changed to the tennis-hours-scoped rules above.

When changing these numbers, update this section of this document **in the same commit** as the code change. The thresholds are part of the product, not implementation details. If you also rename the tiers again, propagate the new names through `lib/forecast.js`, `public/app.js`, and all four `docs/*.md` files in the same commit.

## 4. Tennis windows

The day is split into four windows that match the community's actual play patterns:

| Window    | Local hours |
| --------- | ----------- |
| Morning   | 06:00-10:00 |
| Midday    | 10:00-14:00 |
| Afternoon | 14:00-18:00 |
| Evening   | 18:00-21:00 |

Each window gets its own verdict (GO / LIGHT_CAUTION / HEAVY_CAUTION) computed by applying the same thresholds to **that window's hours only**. This is what lets a user see "morning is fine, afternoon is a wash, evening might clear up" — which is the practical Florida summer pattern.

The window boundaries live in `lib/forecast.js` as `TENNIS_WINDOWS`. The frontend layout assumes four windows; changing the count requires a frontend change too.

## 5. Tennis accuracy enhancements

The day-level verdict and per-window grid answer "can I play and roughly when," but several practical tennis questions need more specific data. This pass added six fields to the `tomorrow` API object that exist purely to make the day-before tennis decision sharper. None of them change the verdict logic in section 3 — they sit alongside it as additional context surfaced in the UI.

### Wind: `wind_max_mph` and `wind_mean_mph`

Both are computed over the tennis hours (06:00–21:00 local) and rounded to the nearest integer. Wind matters for tennis in a way that does not show up anywhere else in a generic forecast:

- **Below 10 mph** — not noticeable.
- **10–15 mph** — affects ball flight on lobs and serve tosses; competitive but fine.
- **15–20 mph** — noticeably changes the game; lob-heavy and topspin-heavy players feel it.
- **Above 20 mph** — the game stops being fun even with a clear sky. The ball does not go where you hit it; serve tosses are a coin flip.

A 30% rain chance day with 22 mph sustained wind is, in tennis terms, a worse day than a 50% rain chance day with calm air. Surfacing peak and mean lets the user see both the worst hour and the overall character of the day.

### `first_rain_time` and `first_rain_hour_local`

`first_rain_time` is the ISO timestamp of the first tennis hour where consensus rain probability is ≥ 50%, or `null` if no tennis hour crosses that bar. `first_rain_hour_local` is the same value rendered as `"H:MM AM/PM"` for direct UI use.

This answers the very practical question: **"can I get a set in before it hits?"** A day with first-rain-time of 2pm is a very different planning problem than a day with first-rain-time of 8am, even if both end up classified as LIGHT_CAUTION. The verdict tells you the day's character; this field tells you when to actually show up.

### `best_window`

An object — `{ label, max_rain_prob, verdict }` — naming the recommended tennis window for tomorrow, or `null` if every window is HEAVY_CAUTION. Selection rule:

1. If any window is GO, pick the GO window with the lowest peak rain probability.
2. Otherwise, if any window is LIGHT_CAUTION, pick the LIGHT_CAUTION window with the lowest peak rain probability.
3. Otherwise return `null`.

This is a deliberate product choice: the user should not have to scan four window cards and do the comparison themselves. The frontend renders a "BEST" badge on the matching window card. When `best_window` is `null` the UI does not invent one — that null is itself information ("there is no clean window tomorrow").

### `confidence` and `confidence_note`

`confidence` is one of `"HIGH"`, `"MODERATE"`, or `"LOW"`, derived from the mean absolute difference between the two models' rain probability across tennis hours:

- Mean abs diff **< 5 pp** → `HIGH`.
- Mean abs diff **5–15 pp** → `MODERATE`.
- Mean abs diff **≥ 15 pp** → `LOW`.
- Only one model available (the other fetch failed) → `LOW`, always.

`confidence_note` is a short human-readable explanation rendered as a subtitle pill ("Models agree closely" / "Models disagree on afternoon timing" / "Single-model forecast — treat as low confidence" etc.).

The existing `disagree` flag on individual hours is a binary alarm ("these two hours specifically diverge"). `confidence` is the day-shaped summary: how much weight to put on the verdict at all. They complement each other and the UI shows both. A `GO` verdict with `confidence: "LOW"` is a meaningfully different recommendation than a `GO` verdict with `confidence: "HIGH"`, and the user should be able to see that at a glance.

## 6. Visual hierarchy of verdict tiers

The three verdict tiers are not presented with equal weight in the UI, and that is deliberate. `HEAVY_CAUTION` and `GO` both shout — large weight, bright color, full glow — because both are clear recommendations (strongly avoid, or strongly go). `LIGHT_CAUTION` murmurs: smaller font, lighter weight, lower-opacity glow. The middle tier should read as "watch closely," not as a hard call in either direction.

If you redesign the hero typography, preserve that hierarchy. A `LIGHT_CAUTION` day rendered with the same visual weight as `HEAVY_CAUTION` will read to users as a hard "do not play" call, which is exactly the absolutist tone the rename in section 3 was meant to walk back. The visual softness is part of the same product judgement as the renamed labels.

## 7. Why no nowcasting in this app

We deliberately do not try to answer "is it about to rain in the next hour" — and we do not pretend to. Model forecasts run hourly, and even HRRR's 1-hour outputs are not the right tool for the 15-minutes-before-match decision.

For the very-short-range decision ("we are walking to the court now, is the cell over us"), use radar:

- [RainViewer](https://www.rainviewer.com/) — free, web and mobile, animated radar.
- RadarScope — paid, what serious storm spotters use.

This is an explicit non-goal so that a future agent does not bolt on a half-working nowcaster and dilute the day-before product. Radar and forecast models answer different questions on different time horizons. Keep them separate.

## 8. Stack rationale

- **Node.js 20 + Express 4 (ESM, single process)** — One process is enough for the load and the cache lives in process memory. No external dependencies (no Redis, no DB) means Railway deploys are trivial and there is nothing to misconfigure. Node 20 is current LTS.
- **No frontend framework** — Plain HTML, Tailwind via CDN, Chart.js via CDN, one `app.js` file. There is no build step. The page loads instantly on mobile and there is nothing to break in CI. The app's value is in the data, not the UI plumbing.
- **Open-Meteo** — Free, no API key, no signup, both HRRR and AIFS available via the same endpoint with a `models=` parameter. Generous rate limits (~10k req/day free). The alternative is paying NOAA/ECMWF directly, which is overkill for this app.
- **10-minute in-memory cache** — Open-Meteo updates HRRR hourly and AIFS less often. A 10-minute cache cuts our outbound requests to roughly six per hour even under load, well inside the free-tier budget. Cache is intentionally process-local: a Railway restart flushes it, which is the simplest possible cache invalidation story.
- **No database** — There is no user state, no history (yet), and no need to persist anything across restarts. Adding a DB would be the largest possible architectural change for zero current product value.

## 9. Project structure

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

## 10. Non-goals

The following are explicitly out of scope for this version. Anyone adding them needs a real reason and should update this section.

- **General-purpose weather app.** No temperature dashboards, no wind roses, no 10-day outlook. Rain probability for tennis, that is it.
- **Multiple locations.** One location, hardcoded in `lib/config.js`. Adding more requires a frontend selector and a routing decision; not worth it until requested.
- **Push notifications / alerts.** No accounts, no subscriptions, no email. Stateless app.
- **Nowcasting.** See section 7.
- **Historical accuracy tracking.** Worth doing eventually (it would let us validate the thresholds in section 3) but requires a database and is not in scope now.
- **User accounts.** None.
