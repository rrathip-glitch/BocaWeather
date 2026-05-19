# Frontend Reference

This document describes the BocaWeather frontend: how it's structured, how to extend it, and the API payload shape it expects. The frontend is intentionally framework-free — three static files served from `/public` by Express. No build step, no bundler, no toolchain.

Files:

- `public/index.html` — markup, CDN script tags, semantic containers, skeletons.
- `public/app.js` — vanilla JS, fetches `/api/forecast`, renders all sections.
- `public/styles.css` — keyframes, glass surfaces, glow, skeleton shimmer.
- `public/favicon.svg` — palm + cloud + raindrops, inline SVG.

External CDN dependencies:

- [Tailwind CSS](https://cdn.tailwindcss.com) — utility classes for layout/typography.
- [Chart.js 4.4.1](https://cdn.jsdelivr.net/npm/chart.js) — hourly rain timeline chart.
- [Inter](https://fonts.google.com/specimen/Inter) via Google Fonts — typography.

## 1. Component structure

The page is a single scroll. Sections render top-to-bottom into containers in `index.html`. `app.js` calls `renderAll(data)` after a successful fetch, which dispatches to six pure-ish render functions:

| Section            | DOM root                       | Render function in `app.js`     | Purpose                                                                 |
| ------------------ | ------------------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| Header + now strip | `<header>` / `#now-strip`      | `renderNowStrip(data)`          | Branding plus current temp / rain % / model agreement dot.              |
| Hero verdict       | `#hero` (verdict, date, chip)  | `renderHero(data)` (+ helpers)  | Massive GO / CAUTION / NO-GO with reason, agreement chip, quick stats. |
| Tennis windows     | `#windows-grid`                | `renderTennisWindows(data)`     | 4 cards: Morning / Midday / Afternoon / Evening with verdict pills.    |
| Hourly chart       | `#rain-chart` canvas           | `renderHourlyChart(data)`       | Chart.js combo: consensus bars + HRRR & AIFS lines, night/disagree bands. |
| Hourly strip       | `#hourly-strip`                | `renderHourlyStrip(data)`       | Horizontally scrollable 24-hour chip strip.                            |
| Footer             | `#generated-info`              | `renderFooter(data)`            | "Forecast generated at HH:MM EDT · cached/fresh" + data attribution.   |
| Error fallback     | `#error-state` (hidden)        | `showError()` / `hideError()`   | Friendly card with retry button on fetch failure.                       |
| "How this works"   | `#how-it-works` (modal)        | `wireHowItWorks()`              | Explains dual-model methodology, verdict thresholds, radar add-on tip. |

Other concerns:

- **Lifecycle.** `init()` wires the modal & retry button, calls `loadForecast()`, schedules a 10-minute refresh, and listens to `visibilitychange` to pause when hidden and refresh on return.
- **Loading state.** Skeleton placeholders (`.skeleton`) are rendered server-side in `index.html` so the page never flashes empty. They are replaced inline by the render functions.
- **Error state.** If the first fetch fails, `#error-state` shows. If a refresh fails after we already have data, we silently keep the last-good payload.
- **Timezone.** All formatting uses `Intl.DateTimeFormat` with `timeZone: 'America/New_York'`. The constant `TZ` at the top of `app.js` is the single switch.

### Disagreement visualization (the product's differentiator)

Model disagreement appears in **four** places, intentionally redundant:

1. **Hero agreement chip** — green "Both models agree" or amber "Models disagree".
2. **Now strip dot** — colored pulse + text label in the page header.
3. **Hourly chart** — vertical amber gradient bands behind any hour where `disagreement: true`, plus a 6 px tick at the top.
4. **Hourly strip chips** — amber border ring (`.is-disagree`) and a tiny "⚠ split" label.

A reviewer who removes one of these breaks the product thesis. See [`docs/AGENT_HANDOFF.md` § 4 invariant 5](./AGENT_HANDOFF.md#4-critical-invariants--do-not-break).

## 2. How to swap the color palette

The palette lives in **two** places that must be kept in sync:

1. **CSS custom properties** in `public/styles.css` (`:root` block at top):
   ```css
   :root {
     --ocean-900: #0b1d3a;
     --ocean-700: #0e3a5c;
     --ocean-500: #15577a;
     --go: #4ade80;
     --caution: #fbbf24;
     --nogo: #f87171;
     /* ... */
   }
   ```
2. **Tailwind config** in the `<script>` block of `public/index.html`:
   ```js
   tailwind.config = {
     theme: {
       extend: {
         colors: {
           ocean: { 900: '#0b1d3a', 700: '#0e3a5c', 500: '#15577a' },
           go: '#4ade80', caution: '#fbbf24', nogo: '#f87171',
           ink: { 100: '#f0f6fc', 70: '...', 50: '...', 30: '...' },
         }
       }
     }
   };
   ```

To swap:

1. Pick three accent colors (go / caution / nogo) and a three-stop background gradient.
2. Update the CSS vars and the Tailwind config block above with the same hex values.
3. Update the SVG gradients inside `public/favicon.svg` so the icon stays consistent.
4. Update the `<meta name="theme-color">` value in the `<head>` of `index.html` (the browser chrome color on mobile) to your new darkest hex.
5. The animated background lives in `.bg-stage` (CSS file). Adjust the `radial-gradient` and `linear-gradient` colors there.
6. The Chart.js line colors are hard-coded as `#7dd3fc` (HRRR) and `#c084fc` (AIFS) inside `renderHourlyChart()`. If they no longer harmonize, update them in `app.js`. The disagreement-band amber (`rgba(251, 191, 36, ...)`) and night-shade navy (`rgba(11, 29, 58, 0.35)`) are also in the chart plugins and should be matched to your new amber/dark.

The `.verdict-{go,caution,nogo}` classes (in `styles.css`) handle the glow text-shadows and reference the CSS vars — no edit needed there beyond the `:root` block, provided you keep variable names identical.

## 3. How to add a new section

The page is a stack of `<section>` elements inside `<main>`. To add one, e.g. "7-day outlook":

1. **Markup.** In `public/index.html`, drop a `<section>` between the hourly strip and the error state (or wherever it fits the narrative):
   ```html
   <section class="mb-10 sm:mb-14" aria-labelledby="outlook-heading">
     <div class="flex items-end justify-between mb-4 sm:mb-5">
       <h2 id="outlook-heading" class="text-lg sm:text-xl font-semibold">7-day outlook</h2>
     </div>
     <div class="rounded-2xl bg-white/[0.04] border border-white/10 backdrop-blur-2xl shadow-glass p-4 sm:p-6">
       <div id="outlook-grid" class="grid grid-cols-2 sm:grid-cols-7 gap-3"></div>
     </div>
   </section>
   ```
   Reuse the glass surface pattern (`rounded-2xl bg-white/[0.04] border border-white/10 backdrop-blur-2xl shadow-glass`) so the section matches the existing visual language.

2. **Render function.** In `public/app.js`, add a `renderOutlook(data)` function near the other renderers, then call it from `renderAll()`:
   ```js
   function renderAll(data) {
     renderHero(data);
     renderNowStrip(data);
     renderTennisWindows(data);
     renderHourlyChart(data);
     renderHourlyStrip(data);
     renderOutlook(data);   // ← new
     renderFooter(data);
   }
   ```
   Follow the existing pattern: pull values off `data`, build innerHTML via template literals, no external libraries.

3. **Skeletons.** If the new section is above the fold, render a skeleton placeholder in the HTML so it doesn't pop in. Use the `.skeleton` class on a fixed-height div.

4. **Animations.** Add `.anim-fade-up` (and a `--i` stagger index inline style) to children for the same entrance feel as the existing sections. Avoid bouncy easings — keep `cubic-bezier(0.2, 0.7, 0.2, 1)`.

5. **API contract.** If the new section needs data the API doesn't expose, coordinate with the backend (`lib/forecast.js`, then `docs/API.md`). Do not add `fetch` calls to other endpoints from the frontend — one round-trip, one cached payload, one re-render.

## 4. The mock API response tested against

The frontend was developed against this representative payload. It matches the canonical contract described in [`docs/API.md`](./API.md) plus the fields documented in the task spec for `GET /api/forecast`. If your backend response shape diverges, the frontend will silently render `—` or skip sections.

```jsonc
{
  "location": {
    "name": "Santa Barbara, Boca Raton",
    "lat": 26.3683,
    "lon": -80.1289,
    "timezone": "America/New_York"
  },
  "generated_at": "2026-05-19T13:42:11.000Z",
  "cached": true,
  "tomorrow": {
    "date": "2026-05-20",
    "verdict": "CAUTION",
    "verdict_reason": "Models disagree on afternoon convection (HRRR peaks at 68%, AIFS stays under 25%).",
    "rain_probability_max": 68,
    "rain_probability_mean": 27,
    "precipitation_sum_in": 0.12,
    "temperature_high_f": 84,
    "temperature_low_f": 71,
    "sunrise": "2026-05-20T10:31:00Z",
    "sunset": "2026-05-21T00:08:00Z",
    "model_agreement": "DISAGREE",
    "uncertainty_note": "HRRR is firing scattered storms; AIFS is keeping it dry."
  },
  "hourly": [
    {
      "time": "2026-05-19T18:00:00Z",
      "hour_local": "14:00",
      "is_tomorrow": false,
      "rain_probability_hrrr": 12,
      "rain_probability_aifs": 8,
      "rain_probability_consensus": 10,
      "precipitation_in_hrrr": 0.0,
      "precipitation_in_aifs": 0.0,
      "precipitation_in_consensus": 0.0,
      "disagreement": false,
      "temperature_f": 82,
      "weathercode": 1
    },
    {
      "time": "2026-05-20T19:00:00Z",
      "hour_local": "15:00",
      "is_tomorrow": true,
      "rain_probability_hrrr": 68,
      "rain_probability_aifs": 22,
      "rain_probability_consensus": 45,
      "precipitation_in_hrrr": 0.11,
      "precipitation_in_aifs": 0.02,
      "precipitation_in_consensus": 0.065,
      "disagreement": true,
      "temperature_f": 84,
      "weathercode": 95
    }
    // ... 34 more hourly entries (36 total for the chart, 24 used by the strip)
  ],
  "models": {
    "hrrr": { "available": true, "id": "gfs_hrrr" },
    "aifs": { "available": true, "id": "ecmwf_aifs025" }
  },
  "tennis_windows": [
    {
      "label": "Morning",
      "start": "2026-05-20T10:00:00Z",
      "end": "2026-05-20T14:00:00Z",
      "verdict": "GO",
      "max_rain_prob": 12,
      "reason": "Clear sky, light onshore breeze."
    },
    {
      "label": "Midday",
      "start": "2026-05-20T14:00:00Z",
      "end": "2026-05-20T18:00:00Z",
      "verdict": "GO",
      "max_rain_prob": 28,
      "reason": "Cumulus building, no rain expected yet."
    },
    {
      "label": "Afternoon",
      "start": "2026-05-20T18:00:00Z",
      "end": "2026-05-20T22:00:00Z",
      "verdict": "NO_GO",
      "max_rain_prob": 68,
      "reason": "HRRR fires a line of storms 3–6 PM; AIFS disagrees."
    },
    {
      "label": "Evening",
      "start": "2026-05-20T22:00:00Z",
      "end": "2026-05-21T01:00:00Z",
      "verdict": "CAUTION",
      "max_rain_prob": 42,
      "reason": "Storms decaying but residual showers possible."
    }
  ]
}
```

### Edge cases the frontend handles

- `model_agreement === "DISAGREE"` → amber chip in hero + now strip; amber bands on chart hours flagged `disagreement: true`; amber ring on hourly chips.
- `cached: true` → footer reads "cached" (else "fresh").
- `rain_probability_hrrr` or `rain_probability_aifs` `null` → Chart.js `spanGaps: true` connects across the gap; the consensus bar still renders from `rain_probability_consensus`.
- `tennis_windows` length `!== 4` → grid stretches; no crash, but copy assumes 4. If the backend changes the count, update the grid breakpoints in `index.html` and the explanatory copy.
- Fetch failure on first load → `#error-state` shows with a retry button. Fetch failure after a successful load → silent, last-good data retained.
- `prefers-reduced-motion: reduce` → background gradient animation, shimmer, and entrance animations all disabled (handled in `styles.css`).

## 5. Verifying without the backend

You can preview the layout without the live API by stubbing the fetch in the browser console:

```js
window.fetch = async () => ({
  ok: true,
  json: async () => /* paste the mock payload above */
});
location.reload(); // or call the internal loader if exposed
```

For real iteration, run the full stack with `npm start` (see [`docs/AGENT_HANDOFF.md` § 7](./AGENT_HANDOFF.md#7-how-to-run-locally)) — the backend serves `/public` and `/api/forecast` from the same origin, so no CORS dance.
