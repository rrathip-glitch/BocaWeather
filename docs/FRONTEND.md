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
- [Leaflet 1.9.4](https://unpkg.com/leaflet@1.9.4) — interactive map for the Live Radar section.
- [Inter](https://fonts.google.com/specimen/Inter) via Google Fonts — typography.

## 1. Component structure

The page is a single scroll. Sections render top-to-bottom into containers in `index.html`. `app.js` calls `renderAll(data)` after a successful fetch, which dispatches to six pure-ish render functions:

| Section            | DOM root                       | Render function in `app.js`     | Purpose                                                                 |
| ------------------ | ------------------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| Header + now strip | `<header>` / `#now-strip`      | `renderNowStrip(data)`          | Branding plus current temp / rain % / model agreement dot.              |
| Refresh button     | `#refresh-btn` (in header)     | `wireRefreshButton()` (boot)    | Manual refresh forcing `?refresh=1`; spinner during fetch, toast on done. |
| Hero verdict       | `#hero` (verdict, date, chip)  | `renderHero(data)` (+ helpers)  | Tiered GO / CAUTION / HEAVY CAUTION with reason, subtitle pills, agreement chip, quick stats. |
| Tennis windows     | `#windows-grid`                | `renderTennisWindows(data)`     | 4 cards: Morning / Midday / Afternoon / Evening with verdict pills + BEST badge on the safest slot. |
| Hourly chart       | `#rain-chart` canvas           | `renderHourlyChart(data)`       | Chart.js combo: consensus bars + HRRR & AIFS lines, night/disagree bands, NOW line, sunrise/sunset markers. |
| Live Radar         | `#radar-map` + controls        | `initRadar()` / `renderRadar()` | Leaflet + CartoDB base, RainViewer animated radar overlay, pulsing pin. |
| Hourly strip       | `#hourly-strip`                | `renderHourlyStrip(data)`       | Horizontally scrollable 24-hour chip strip.                             |
| Footer             | `#generated-info`              | `renderFooter(data)`            | "Forecast generated at HH:MM EDT · cached/fresh" + data attribution.    |
| Error fallback     | `#error-state` (hidden)        | `showError()` / `hideError()`   | Friendly card with retry button on fetch failure.                       |
| "How this works"   | `#how-it-works` (modal)        | `wireHowItWorks()`              | Explains dual-model methodology, verdict thresholds, radar add-on tip.  |

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
4. **Hourly strip chips** — amber border ring (`.is-disagree`) and a tiny "Split" indicator (inline SVG triangle + label, `.chip-split`).

A reviewer who removes one of these breaks the product thesis. See [`docs/AGENT_HANDOFF.md` § 4 invariant 5](./AGENT_HANDOFF.md#4-critical-invariants--do-not-break).

### Refresh button

A circular icon button sits in the header next to the now-strip pill (visible at every breakpoint — the now-strip itself is `sm:` only, the button is always shown). Visual: glass surface (`bg-white/5`, `border border-white/10`, `backdrop-blur-xl`), inline SVG refresh glyph, no emoji.

Behavior, fully owned by `wireRefreshButton()` in `app.js`:

1. On click, disable the button and add `.is-refreshing` — that class drives a CSS `@keyframes spin` rotation on the inner SVG at 600 ms per turn.
2. Call `loadForecast({ refresh: true })`. The contract for `loadForecast`:
   ```js
   loadForecast({ refresh: false })  // default — uses /api/forecast (server cache OK)
   loadForecast({ refresh: true })   // appends ?refresh=1 — backend bypasses its cache
   ```
   The 10-minute auto-refresh and the `visibilitychange` re-fetch both call the default. Only the header button forces `?refresh=1`. This protects upstream models from refresh storms while still giving the user an instant escape hatch.
3. On success, the renderers run as usual and a transient "Updated" toast (`#refresh-toast`) fades in for 2 s. On failure, the toast reads "Refresh failed" with a red accent and the last-good payload stays on screen.
4. The button always re-enables in `finally`. The spin animation stops instantly when the class is removed.
5. Tooltip: `title="Refresh forecast"`; accessible label via `aria-label`.

The toast is rendered as a fixed-position pill (`.refresh-toast`) outside the header flow so it never shifts layout. The same helper (`showToast(msg, kind)`) is reusable for any future status nudge.

### Hero date display

Above the verdict word, two stacked elements:

```
FORECAST FOR              ← uppercase, text-xs, tracking-[0.28em], text-white/50, 600
Wednesday, May 20, 2026   ← text-xl → text-2xl → text-3xl, tracking-wide, text-slate-100, 600
GO                        ← the existing massive verdict, unchanged
```

The exact format `Wednesday, May 20, 2026` comes from `fmtDateFull(parseLocalDate(t.date))` in `app.js`:

- `Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })`.
- **Noon-local parse trick.** Backend sends `tomorrow.date` as `"YYYY-MM-DD"`. `new Date("2026-05-20")` interprets that as **UTC midnight**, so any negative-offset viewer (the entire Americas) drifts one calendar day backward — May 20 renders as May 19. `parseLocalDate(ymd)` builds `new Date("${ymd}T12:00:00")` instead: an unambiguous noon **local** wall-clock that lands inside May 20 in every timezone on Earth. The subsequent `Intl.DateTimeFormat` then re-projects safely into Eastern Time.

The label-above-value pattern is hand-rolled in `index.html`; the dynamic line lives at `#hero-date`.

### Verdict tier visual hierarchy

The backend emits `verdict: "GO" | "LIGHT_CAUTION" | "HEAVY_CAUTION"`. The frontend renders three tiers with a deliberate three-step visual hierarchy — GO and HEAVY CAUTION both shout (in opposite directions), LIGHT CAUTION murmurs. The intent is that the hierarchy reads at a glance, without parsing the word.

| Backend `verdict`  | Displayed word   | Tier class | Color (CSS var) | Font size                | Weight | Letter-spacing | Glow opacity |
| ------------------ | ---------------- | ---------- | --------------- | ------------------------ | ------ | -------------- | ------------ |
| `GO`               | `GO`             | `go`       | `--go`          | mobile 4.5rem / sm 8rem  | 900    | -0.06em        | 0.55         |
| `LIGHT_CAUTION`    | `CAUTION`        | `light`    | `--caution`     | mobile 3.75rem / sm 6rem | 600    | -0.03em        | 0.30         |
| `HEAVY_CAUTION`    | `HEAVY CAUTION`  | `heavy`    | `--nogo`        | mobile 4.5rem / sm 8rem  | 900    | -0.06em        | 0.55         |

LIGHT CAUTION is roughly 75% of the GO/HEAVY visual weight by font size, plus a lighter font weight (semibold vs. black) and a notably softer glow (0.30 vs. 0.55). The label is also intentionally just `"CAUTION"` rather than `"LIGHT CAUTION"` — the calmer presentation does the work of "light", so the word stays short and human.

Mapping lives in two helpers in `app.js`:

```js
verdictClass('GO')             // → 'go'      → .verdict-go,    .glow-go,    .acc-go,    .pill-go
verdictClass('LIGHT_CAUTION')  // → 'light'   → .verdict-light, .glow-light, .acc-light, .pill-light
verdictClass('HEAVY_CAUTION')  // → 'heavy'   → .verdict-heavy, .glow-heavy, .acc-heavy, .pill-heavy
verdictLabel('LIGHT_CAUTION')  // → 'CAUTION' (just one word)
verdictLabel('HEAVY_CAUTION')  // → 'HEAVY CAUTION'
```

Legacy values (`CAUTION`, `NO_GO`, `NO-GO`) are forward-compatibly mapped to `light` and `heavy` so a stale backend payload never breaks the render.

The same tier classes drive the tennis-window card accents (`.window-card.acc-{tier}`) and the small verdict pills inside each card (`.verdict-pill.pill-{tier}`). The LIGHT pill uses a slightly less-saturated fill (`rgba(251, 191, 36, 0.10)`) and a softer border (`0.22`) than the GO/HEAVY pills (`0.15`/`0.30`).

### Hero subtitle pills

Below `#verdict-reason` is `#hero-pills`, a horizontal row of glass micro-pills (`.hero-pill`) that wrap on mobile. Each pill is conditionally rendered by `renderHeroPills(t)` — when the backend field is `null` or missing, the pill is skipped silently so the row never holds empty placeholders post-render. Render order (left → right):

| Pill         | Renders when                       | Example string                       | Tone (CSS `data-tone`)             |
| ------------ | ---------------------------------- | ------------------------------------ | ---------------------------------- |
| First rain   | `tomorrow.first_rain_hour_local` is non-null | `Rain begins ~3:00 PM`               | `amber`                            |
| Best window  | `tomorrow.best_window` is non-null | `Best window: Morning · 12%`         | `green` if best.verdict is GO, `amber` if LIGHT_CAUTION, `coral` if HEAVY_CAUTION |
| Wind         | `tomorrow.wind_max_mph` is non-null | `Wind: 12 mph peak`                  | `slate`                            |
| Confidence   | always                              | `Forecast confidence: High`          | `green` (HIGH), `amber` (MODERATE), `coral` (LOW) |

Each pill exposes the relevant explanatory string via the native `title` attribute so hover/long-press reveals the context (the confidence pill specifically surfaces `tomorrow.confidence_note`).

Skeleton state is rendered statically in `index.html` as four `.hero-pill.skeleton` shimmers — the same pill shape, no content. The first paint of `renderHeroPills` replaces them with real pills, each animated in via `.anim-fade-up` with a 60 ms-per-pill stagger.

### BEST badge

The tennis-window card whose `label` matches `tomorrow.best_window.label` gets a `.best-badge` overlay in its top-right corner — a tiny palm-green pill with an inline check SVG. If `best_window` is `null`, no badge renders. Style is subtle by design: low-opacity fill (`rgba(74, 222, 128, 0.10)`), low-contrast border, small uppercase letter-spacing, soft outer glow. It signals "this is the safer slot" without competing with the verdict pill on the same card.

### Hero stats row

The four-stat grid (`#hero-stats`) renders, in order:

1. **Peak rain** — `Math.round(tomorrow.rain_probability_max)%` with a tiny colored dot (`rainTint`).
2. **Wind (peak)** — `Math.round(tomorrow.wind_max_mph) mph`, or `—` when unavailable. Replaced the prior "Mean rain" stat, because mean is already implied by the consensus bar in the chart, and wind directly affects tennis playability (10+ mph kills the lob).
3. **High** — `Math.round(tomorrow.temperature_high_f)°`.
4. **Low** — `Math.round(tomorrow.temperature_low_f)°`.

### Chart "NOW" line

A vertical dashed white line at the current local time, drawn by the `nowLine` Chart.js plugin in `renderHourlyChart()`. Behavior:

- The plugin runs in `afterDatasetsDraw` so it paints over the consensus bars and model lines.
- X position is interpolated between adjacent hour buckets — same interpolation pattern as the sunrise/sunset markers — so the line lands at the correct fractional offset when "now" sits mid-hour.
- Line: `rgba(240, 246, 252, 0.6)`, 1.5 px wide, dashed (2, 3).
- Label: a tiny `NOW` chip in uppercase 9.5 px Inter at the top of the line.
- If `now` falls outside the visible 36-hour window, the plugin no-ops silently.

To disable, remove `nowPlugin` from the `plugins:` array at the bottom of the Chart constructor in `renderHourlyChart()`. Sunrise/sunset markers (the `sunMarkers` plugin) are independent and use the same interpolation helper.

### Chart legend pills + HRRR/AIFS popovers

Below the chart canvas (`.chart-legend`) is a row of four `.chart-legend-pill` items: HRRR, AIFS, Consensus, Models disagree — each with a colored swatch (`.legend-swatch`) that mirrors the in-chart styling (solid cyan for HRRR, dashed magenta for AIFS, cyan-fade bar for the consensus bar, amber-fade for the disagreement band).

HRRR and AIFS additionally carry a tiny `(?)` icon button (`.legend-help`) with a popover tooltip (`.legend-popover`) explaining the model:

- **HRRR** — *NOAA High-Resolution Rapid Refresh — 3 km US convective model. Best skill for Florida summer storms in the 18–48 h window.*
- **AIFS** — *ECMWF Artificial Intelligence Forecasting System — global AI model with strong skill on synoptic patterns.*

Popover behavior is double-implemented for input parity:

1. **Desktop (hover-capable, fine pointer)** — pure CSS: `.chart-legend-pill:hover .legend-popover` reveals the tooltip. No JS needed.
2. **Tap / keyboard** — `wireLegendPopovers()` toggles `aria-expanded` on the `.legend-help` button; CSS selector `.legend-help[aria-expanded="true"] + .legend-popover` reveals it. Outside-click and Escape both dismiss.

The popover anchors to `bottom: calc(100% + 8px)` so it floats above the pill without colliding with the chart. Max width is 280 px so long copy wraps naturally.

### Live Radar

Architecture: **Leaflet** map + **CartoDB Dark Matter** base tiles (matches the ocean palette) + **RainViewer** animated precipitation overlay + a pulsing palm-green pin at the home location.

```
init: index.html        boots Leaflet (defer) → app.js initRadar() once on init()
data: fetch https://api.rainviewer.com/public/weather-maps.json
      → frames = [...radar.past, ...radar.nowcast]
      → first frame goes on the map at opacity 0.75
      → autoplay loops at ~500ms/frame, pauses 1.5s on the last frame
```

Tile URL template per frame:
```
${host}${path}/256/{z}/{x}/{y}/${RADAR_COLOR}/1_1.png
```

#### Swapping the color palette
`RADAR_COLOR` is a top-level constant in `app.js`. Valid RainViewer color codes:

| code | scheme              | notes                                 |
| ---- | ------------------- | ------------------------------------- |
| 0    | Black & White       | minimal, prints well                  |
| 1    | Original            | RainViewer default                    |
| 2    | Universal Blue      | **current** — clean on dark theme     |
| 3    | TITAN               |                                       |
| 4    | The Weather Channel | familiar to US viewers                |
| 5    | Meteored            |                                       |
| 6    | NEXRAD              | matches NWS color ramp                |
| 7    | Rainbow             | high contrast                         |
| 8    | Dark                | for light themes                      |

The trailing `/1_1` means "smoothed tiles, include snow". Change to `/0_0` for raw + no snow.

#### Changing zoom / center
`RADAR_CENTER` (`[lat, lon]`) and the `zoom`/`minZoom`/`maxZoom` arguments to `L.map(...)` are all in `initRadar()`. Default `zoom: 9` shows South Florida from West Palm down past Miami; `minZoom: 7` prevents users from zooming to the globe; `maxZoom: 12` avoids tile pixelation.

`scrollWheelZoom: false` is deliberate — on a long-scroll page, capturing the wheel inside an embedded map is a UX hostile pattern. Users zoom via the `+`/`−` buttons or pinch.

#### Animation loop
`startRadarAutoplay()` runs a self-rescheduling `setTimeout` chain:
- step delay = `RADAR_FRAME_MS` (500 ms) for normal advance, `RADAR_LOOP_PAUSE_MS` (1500 ms) when sitting on the last frame before wrapping back to 0.
- `showRadarFrame(index)` is the swap primitive: add the next `L.tileLayer` to the map first, then remove the previous one. The order matters — flipping it produces a one-tick gap where the map looks blank.
- All built layers are cached in `radarState.layers[index]` so scrubbing back and forth never re-downloads tiles.
- Dragging the slider stops autoplay and jumps directly to that frame.
- Clicking play/pause is the only way to restart autoplay after a manual scrub.

#### Past vs. nowcast distinction
The timeline slider's track is a CSS linear-gradient split between two accent colors (ocean blue for past frames, caution amber for nowcast) at the boundary computed from `past.length / frames.length`. The thumb color flips amber while a nowcast frame is selected. The time label reads absolute local time for past frames (`3:30 PM`) and a relative offset for nowcast (`+30 min`).

#### Error handling
If `weather-maps.json` fails or returns zero frames, `showRadarFallback()` reveals `#radar-fallback` (a glass overlay inside the card with "Radar temporarily unavailable. Check rainviewer.com") and disables the playback controls. **The base map and the pulsing marker remain visible underneath** — the user still gets a sense of place.

#### Attribution
A small footer inside the card reads `Radar by RainViewer · Map by CARTO/OpenStreetMap` and is paired with a tiny color legend so the past/nowcast slider colors are self-explanatory.

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
    "lat": 26.3797,
    "lon": -80.1539,
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
