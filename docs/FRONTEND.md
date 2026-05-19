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
| Header + now strip | `<header>` / `#now-strip`      | `renderNowStrip(data)`          | Branding plus current temp / rain % / model agreement dot. Always real-time (never tied to the toggle). |
| Refresh button     | `#refresh-btn` (in header)     | `wireRefreshButton()` (boot)    | Manual refresh forcing `?refresh=1`; spinner during fetch, toast on done. |
| Day toggle         | `#day-toggle` (above hero)     | `renderDayToggle(data)` / `wireDayToggle()` | Segmented Today / Tomorrow pill with sliding indicator; drives every day-aware render via `appState.selectedDay`. |
| Hero verdict       | `#hero` (verdict, date, chip)  | `renderHero(data)` (+ helpers)  | Tiered GO / CAUTION / HEAVY CAUTION with reason, subtitle pills, agreement chip, quick stats. Day-aware via `currentDay(data)`. |
| Tennis windows     | `#windows-grid`                | `renderTennisWindows(data)`     | 4 cards: Morning / Midday / Afternoon / Evening with verdict pills + BEST badge on the safest slot. Day-aware. |
| Hourly chart       | `#rain-chart` canvas           | `renderHourlyChart(data)`       | Chart.js combo: consensus bars + HRRR & AIFS lines, night/disagree bands, NOW line, sunrise/sunset markers, selected-day highlight wash. |
| Live Radar         | `#radar-map` + controls        | `initRadar()` / `renderRadar()` | Leaflet + CartoDB base, RainViewer animated radar overlay, pulsing pin. |
| Hourly strip       | `#hourly-strip`                | `renderHourlyStrip(data)`       | Horizontally scrollable 24-hour chip strip. Chips matching the selected day get `.is-active-day`. |
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

### App state

The frontend keeps a tiny top-level state object so the Today / Tomorrow toggle can re-render the page without a network round-trip and without losing the user's selection on auto-refresh:

```js
const appState = {
  selectedDay: 'tomorrow', // 'today' | 'tomorrow'
  lastData: null,          // most recent /api/forecast payload
};

function currentDay(data) {
  return data?.[appState.selectedDay];
}
```

- `selectedDay` defaults to `'tomorrow'` — the original product focus, kept for first-load familiarity.
- `lastData` is set inside `loadForecast()` immediately after a successful fetch. Every toggle click re-runs `renderAll(appState.lastData)`, so the switch is instant and never refetches.
- `currentDay(data)` is the day-aware accessor every render function consumes. Renderers that should follow the toggle (`renderHero`, `renderTennisWindows`, the chart's highlight wash, the hourly strip's `.is-active-day` ring) read `currentDay(data)`. Renderers that should always show real-time conditions (`renderNowStrip`) deliberately do **not** — they read `data.today || data.tomorrow` for the live model_agreement.
- The toggle persists across auto-refresh and `visibilitychange` re-fetches. `setSelectedDay(day)` is the only mutator, and it only writes when the value actually changes.

### Day toggle (Today | Tomorrow)

Segmented-control "pill" sitting between the header and the hero, centered, with `mb-8 sm:mb-10` to give the hero room to breathe.

#### Anatomy

```
.day-toggle-wrap          ← flex centering container, full width
  .day-toggle             ← glass pill: rgba(255,255,255,0.05), border, backdrop-blur, p-1
                            role="tablist", aria-label="Forecast day"
                            min-width 280px mobile / 360px desktop
    .day-toggle-indicator ← absolutely positioned, 50%-1-padding wide, sliding pill
                            data-day attribute drives transform + gradient
    .day-toggle-btn       ← role="tab", flex-1, transparent background
      .day-toggle-label   ← "TODAY" / "TOMORROW", uppercase, tracking-widest
      .day-toggle-sub     ← "Mon, May 19" — Intl.DateTimeFormat abbreviated, text-white/45
    .day-toggle-btn       ← second tab, same structure
```

#### Sliding indicator

A single absolutely-positioned `<span>` paints the active background; the buttons themselves stay transparent. Position is driven by `data-day`:

| `data-day` value | Transform        | Gradient                                                                 | Outer shadow |
| ---------------- | ---------------- | ------------------------------------------------------------------------ | ------------ |
| `today`          | `translateX(0)`  | `linear-gradient(135deg, rgba(251,191,36,0.18), rgba(248,113,113,0.18))` | mint amber `0 6px 22px rgba(251,191,36,0.18)` |
| `tomorrow`       | `translateX(100%)` | `linear-gradient(135deg, rgba(74,222,128,0.18), rgba(20,160,210,0.22))` | mint green `0 6px 22px rgba(74,222,128,0.18)` |

Animation: `transform 220ms cubic-bezier(0.22, 1, 0.36, 1)` — a premium ease-out curve, no bounce. The gradient and shadow crossfade alongside on `320ms ease` so the color shift never feels stepped.

#### `is-done` state

When `today.is_concluded === true`, the today button gets `.is-done`:

- Label text gets a subtle horizontal line-through (`text-decoration-color: rgba(255,255,255,0.35)`).
- Opacity drops to 0.6 (0.8 on hover).
- Subtitle replaces the abbreviated date with the literal string `"Day complete"`.
- `title` attribute reads `"Tennis day is over"`.
- **Clicking is still allowed.** Switching to a concluded day renders the special "COMPLETE" hero (see § Concluded today UI).

#### Behavior

1. Click → `setSelectedDay(day)`:
   - Bails if the value is unchanged (no churn on accidental re-clicks).
   - Adds `.hero-fade` to `#hero` and forces a reflow so the 200 ms opacity crossfade restarts cleanly.
   - Re-runs `renderAll(appState.lastData)` — no network call.
   - On `requestAnimationFrame`, calls `scrollStripToSelectedDay()` to bring the hourly strip's first matching chip into view (only if the strip is roughly in viewport; offscreen-skip prevents surprise jumps).
2. The sliding indicator's transform animates between positions; the body never reflows because the indicator is `position: absolute` inside the toggle.
3. `renderDayToggle()` runs after every fetch to refresh the subtitle dates and sync ARIA — it does **not** reset `selectedDay`, so the user's choice survives auto-refresh.

#### Accessibility

- Container: `role="tablist"` with `aria-label="Forecast day"`.
- Each button: `role="tab"`, `aria-controls="hero"`, `aria-selected="true|false"`, `tabindex` flipped (0 / -1) so only the active tab is in the tab order — standard tablist roving-focus pattern.
- **Keyboard.** Left arrow / Home → Today. Right arrow / End → Tomorrow. Both call `setSelectedDay()` and move focus to the destination button.
- **Focus ring.** `focus-visible` shows `box-shadow: 0 0 0 2px rgba(255,255,255,0.40)` on the button, matching the page's premium ring style.
- **Reduced motion.** `prefers-reduced-motion: reduce` disables the indicator's transform transition (gradient/shadow crossfade keeps a brief 320 ms ease so the active color is still legible).

### Day-aware renders

Every renderer that consumes a single day's forecast reads from `currentDay(data)` so the toggle drives the entire page in lockstep. Concretely:

| Render                  | Source                              | Notes                                                                  |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `renderHero(data)`      | `currentDay(data) \|\| data.tomorrow` | Verdict word, glow, date, reason, pills, agreement chip, stats — all day-scoped. Falls back to tomorrow if the selected day is absent (defensive against older payloads). |
| `renderTennisWindows`   | `currentDay(data).tennis_windows`   | **Breaking change:** `tennis_windows` is now per-day, not top-level. The section subheading flips between "Today · Eastern Time" and "Tomorrow · Eastern Time". |
| `renderHourlyChart`     | `currentDay(data).date`             | Drives the `dayHighlight` plugin's selected-day wash; chart still shows the full 36-hour range. |
| `renderHourlyStrip`     | `currentDay(data).date`             | Chips whose local YYYY-MM-DD matches get `.is-active-day`; `scrollStripToSelectedDay()` brings the first matching chip into view on toggle. |
| `renderNowStrip(data)`  | `data.today \|\| data.tomorrow`     | **Always real-time** — does not consume the toggle. Live model_agreement comes from the in-flight day (`today`) with `tomorrow` as fallback if the backend hasn't shipped today yet. |
| `renderFooter`          | `data.generated_at`, `data.cached`  | Day-agnostic — same regardless of toggle. |

The renderers always call `renderDayToggle(data)` first inside `renderAll(data)` so the toggle's subtitles and ARIA reflect the freshest payload before the other sections paint.

### Concluded today UI

When `appState.selectedDay === 'today'` and `currentDay(data).is_concluded === true`, the hero re-skins itself to communicate that the tennis day is over without leaving the page blank:

- **Verdict word** swaps from the loud GO / CAUTION / HEAVY CAUTION to a calm `"COMPLETE"`:
  - Class: `.verdict-complete` (slate `rgba(240,246,252,0.70)`, font-semibold, no text-shadow).
  - Size: ~3.25 rem mobile / ~4.5 rem desktop — roughly text-6xl/text-7xl, intentionally smaller than the normal verdict's text-9xl.
  - Hero glow is hidden (`.hero-glow` opacity forced to 0, no tier class).
- **Reason** still renders from `today.verdict_reason` (typically `"Tennis day complete — check Tomorrow for the next forecast."`).
- **Subtitle pills** are skipped entirely — every pill field (`first_rain_hour_local`, `best_window`, `wind_max_mph`, `confidence`) is null on a concluded day, and a row of empty placeholders would feel broken.
- **Agreement chip slot** is repurposed for a "See Tomorrow's forecast" CTA (`.day-cta`) — a small palm-green chip with a right-arrow glyph. Clicking calls `setSelectedDay('tomorrow')` so the user has an obvious next action.
- **Stats row** drops the Peak rain tile (null on concluded days) and keeps Wind / High / Low whichever survive on the day object — `renderHeroStats(t, { isConcludedToday: true })` handles the filtering.
- **Tennis windows** still render all four cards, but every card gets `.is-past` (opacity 0.6, desaturated, no hover lift) and the BEST badge is suppressed (no "best" on a day that's over).
- **Day-toggle button** for Today simultaneously carries `.is-done` (line-through label, "Day complete" subtitle, dimmed but still clickable — see § Day toggle).

The same `is-past` class is applied to individual windows whose `is_past: true` flag is set within an in-progress today, so the visual treatment is consistent: a finished window looks finished regardless of why.

### Chart day-highlight band

The hourly chart shows the full 36-hour horizon regardless of toggle state, but adds a subtle vertical wash behind the hours that belong to the selected day. Implementation: the `dayHighlight` Chart.js plugin, declared inside `renderHourlyChart()`:

```js
const dayHighlightPlugin = {
  id: 'dayHighlight',
  beforeDatasetsDraw(chart) {
    // ...paints rgba(255,255,255,0.04) across every hour whose local
    // YYYY-MM-DD === currentDay(data).date
  }
};
```

- Runs in `beforeDatasetsDraw` so the wash sits **under** the bars, lines, night shading, and disagreement bands — it's a background hint, never a foreground element.
- The selected day is captured in a `selectedDate` closure variable at the top of `renderHourlyChart` (`currentDay(data)?.date || null`). When the user toggles, `renderAll` re-runs `renderHourlyChart`, which rebuilds the plugin closure against the new selected date, and the chart re-paints — no separate animation, just a fresh render.
- Fill color is intentionally near-transparent (`rgba(255,255,255,0.04)`) so it reads as "this is your day" without competing with the data layers. On the active day's hours you'll see a slight brightening of the background between the night-shade bands.
- Listed first in the chart's `plugins:` array (`[dayHighlightPlugin, nightPlugin, disagreePlugin, sunMarkersPlugin, nowPlugin]`) so subsequent plugins paint on top of it.

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

The exact format `Wednesday, May 20, 2026` comes from `fmtDateFull(parseLocalDate(t.date))` in `app.js` where `t = currentDay(data)`, so the date is **day-aware** — it tracks the Today / Tomorrow toggle and re-renders to whichever day the user picked.

- `Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })`.
- **Noon-local parse trick.** Backend sends `today.date` / `tomorrow.date` as `"YYYY-MM-DD"`. `new Date("2026-05-20")` interprets that as **UTC midnight**, so any negative-offset viewer (the entire Americas) drifts one calendar day backward — May 20 renders as May 19. `parseLocalDate(ymd)` builds `new Date("${ymd}T12:00:00")` instead: an unambiguous noon **local** wall-clock that lands inside the intended calendar day in every timezone on Earth. The subsequent `Intl.DateTimeFormat` then re-projects safely into Eastern Time.

The label-above-value pattern is hand-rolled in `index.html`; the dynamic line lives at `#hero-date`. The same abbreviated format (`fmtDateAbbr`, e.g. `Mon, May 19`) drives the day-toggle's subtitles.

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

Below `#verdict-reason` is `#hero-pills`, a horizontal row of glass micro-pills (`.hero-pill`) that wrap on mobile. Each pill is conditionally rendered by `renderHeroPills(t)` where `t = currentDay(data)` — when the backend field is `null` or missing, the pill is skipped silently so the row never holds empty placeholders post-render. Render order (left → right):

| Pill         | Renders when                       | Example string                       | Tone (CSS `data-tone`)             |
| ------------ | ---------------------------------- | ------------------------------------ | ---------------------------------- |
| First rain   | `t.first_rain_hour_local` is non-null | `Rain begins ~3:00 PM`               | `amber`                            |
| Best window  | `t.best_window` is non-null        | `Best window: Morning · 12%`         | `green` if best.verdict is GO, `amber` if LIGHT_CAUTION, `coral` if HEAVY_CAUTION |
| Wind         | `t.wind_max_mph` is non-null       | `Wind: 12 mph peak`                  | `slate`                            |
| Confidence   | always                              | `Forecast confidence: High`          | `green` (HIGH), `amber` (MODERATE), `coral` (LOW) |

Each pill exposes the relevant explanatory string via the native `title` attribute so hover/long-press reveals the context (the confidence pill specifically surfaces `t.confidence_note`).

Skeleton state is rendered statically in `index.html` as four `.hero-pill.skeleton` shimmers — the same pill shape, no content. The first paint of `renderHeroPills` replaces them with real pills, each animated in via `.anim-fade-up` with a 60 ms-per-pill stagger.

When `today.is_concluded === true` and the user is viewing today, the entire row is wiped (`host.innerHTML = ''`) — every backend pill field is null on a concluded day and a row of empty placeholders would feel broken. See § Concluded today UI for the full re-skin.

### BEST badge

The tennis-window card whose `label` matches `currentDay(data).best_window.label` gets a `.best-badge` overlay in its top-right corner — a tiny palm-green pill with an inline check SVG. If `best_window` is `null`, no badge renders. Style is subtle by design: low-opacity fill (`rgba(74, 222, 128, 0.10)`), low-contrast border, small uppercase letter-spacing, soft outer glow. It signals "this is the safer slot" without competing with the verdict pill on the same card. The badge is **also** suppressed on every card when viewing a concluded today — see § Concluded today UI.

### Hero stats row

The four-stat grid (`#hero-stats`) is day-aware via `currentDay(data)` — it pulls from whichever day the toggle has selected. In normal mode it renders, in order:

1. **Peak rain** — `Math.round(t.rain_probability_max)%` with a tiny colored dot (`rainTint`).
2. **Wind (peak)** — `Math.round(t.wind_max_mph) mph`, or `—` when unavailable. Replaced the prior "Mean rain" stat, because mean is already implied by the consensus bar in the chart, and wind directly affects tennis playability (10+ mph kills the lob).
3. **High** — `Math.round(t.temperature_high_f)°`.
4. **Low** — `Math.round(t.temperature_low_f)°`.

When `appState.selectedDay === 'today'` and `today.is_concluded === true`, `renderHeroStats(t, { isConcludedToday: true })` drops the Peak rain tile (the backend nulls it out on a concluded day) and renders only Wind / High / Low — the row collapses to three tiles rather than rendering an awkward `0%` placeholder.

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

The `.verdict-{go,light,heavy}` classes (in `styles.css`) handle the per-tier font size / weight / glow and reference the CSS vars — no edit needed there beyond the `:root` block, provided you keep variable names identical.

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
     renderDayToggle(data);
     renderHero(data);
     renderNowStrip(data);
     renderTennisWindows(data);
     renderHourlyChart(data);
     renderRadar(data);
     renderHourlyStrip(data);
     renderOutlook(data);   // ← new
     renderFooter(data);
   }
   ```
   If the new section is day-aware (should follow the Today / Tomorrow toggle), read from `currentDay(data)` rather than `data.tomorrow` directly so the toggle drives it automatically.
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
  "today": {
    "date": "2026-05-19",
    "label": "today",
    "is_concluded": false,
    "tennis_hours_remaining": 6,
    "verdict": "GO",
    "verdict_reason": "Clear afternoon, light breeze. Play through evening.",
    "rain_probability_max": 18,
    "rain_probability_mean": 6,
    "precipitation_sum_in": 0.00,
    "temperature_high_f": 82,
    "temperature_low_f": 70,
    "sunrise": "2026-05-19T10:32:00Z",
    "sunset": "2026-05-20T00:07:00Z",
    "model_agreement": "AGREE",
    "uncertainty_note": null,
    "wind_max_mph": 9,
    "wind_mean_mph": 6,
    "first_rain_time": null,
    "first_rain_hour_local": null,
    "best_window": {
      "label": "Afternoon",
      "max_rain_prob": 12,
      "verdict": "GO"
    },
    "confidence": "HIGH",
    "confidence_note": "Both models agree; nothing in the radar.",
    "tennis_windows": [
      {
        "label": "Morning", "start": "2026-05-19T10:00:00Z", "end": "2026-05-19T14:00:00Z",
        "verdict": "GO", "max_rain_prob": 8, "reason": "Clear sky, light wind.", "is_past": true
      },
      {
        "label": "Midday", "start": "2026-05-19T14:00:00Z", "end": "2026-05-19T18:00:00Z",
        "verdict": "GO", "max_rain_prob": 12, "reason": "Calm conditions hold.", "is_past": false
      },
      {
        "label": "Afternoon", "start": "2026-05-19T18:00:00Z", "end": "2026-05-19T22:00:00Z",
        "verdict": "GO", "max_rain_prob": 18, "reason": "Cumulus building but staying dry.", "is_past": false
      },
      {
        "label": "Evening", "start": "2026-05-19T22:00:00Z", "end": "2026-05-20T01:00:00Z",
        "verdict": "GO", "max_rain_prob": 10, "reason": "Clear evening.", "is_past": false
      }
    ]
  },
  "tomorrow": {
    "date": "2026-05-20",
    "label": "tomorrow",
    "is_concluded": false,
    "verdict": "LIGHT_CAUTION",
    "verdict_reason": "Models disagree on afternoon convection (HRRR peaks at 68%, AIFS stays under 25%).",
    "rain_probability_max": 68,
    "rain_probability_mean": 27,
    "precipitation_sum_in": 0.12,
    "temperature_high_f": 84,
    "temperature_low_f": 71,
    "sunrise": "2026-05-20T10:31:00Z",
    "sunset": "2026-05-21T00:08:00Z",
    "model_agreement": "DISAGREE",
    "uncertainty_note": "HRRR is firing scattered storms; AIFS is keeping it dry.",
    "wind_max_mph": 14,
    "wind_mean_mph": 9,
    "first_rain_time": "2026-05-20T19:00:00Z",
    "first_rain_hour_local": "3:00 PM",
    "best_window": {
      "label": "Morning",
      "max_rain_prob": 12,
      "verdict": "GO"
    },
    "confidence": "MODERATE",
    "confidence_note": "Disagreement on the afternoon line lowers confidence to moderate; morning is firm.",
    "tennis_windows": [
      {
        "label": "Morning", "start": "2026-05-20T10:00:00Z", "end": "2026-05-20T14:00:00Z",
        "verdict": "GO", "max_rain_prob": 12, "reason": "Clear sky, light onshore breeze.", "is_past": false
      },
      {
        "label": "Midday", "start": "2026-05-20T14:00:00Z", "end": "2026-05-20T18:00:00Z",
        "verdict": "GO", "max_rain_prob": 28, "reason": "Cumulus building, no rain expected yet.", "is_past": false
      },
      {
        "label": "Afternoon", "start": "2026-05-20T18:00:00Z", "end": "2026-05-20T22:00:00Z",
        "verdict": "HEAVY_CAUTION", "max_rain_prob": 68, "reason": "HRRR fires a line of storms 3–6 PM; AIFS disagrees.", "is_past": false
      },
      {
        "label": "Evening", "start": "2026-05-20T22:00:00Z", "end": "2026-05-21T01:00:00Z",
        "verdict": "LIGHT_CAUTION", "max_rain_prob": 42, "reason": "Storms decaying but residual showers possible.", "is_past": false
      }
    ]
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
  }
}
```

> **Breaking change (today/tomorrow split):** `tennis_windows` used to live at the top level of the payload and reflect tomorrow only. It now lives **inside each day object** (`today.tennis_windows`, `tomorrow.tennis_windows`) so the toggle can show either day's slots. Any code that reads `data.tennis_windows` must migrate to `currentDay(data).tennis_windows`. Each window additionally exposes `is_past: boolean` for muting elapsed slots within an in-progress today.

### Edge cases the frontend handles

- `model_agreement === "DISAGREE"` → amber chip in hero + now strip; amber bands on chart hours flagged `disagreement: true`; amber ring on hourly chips.
- `cached: true` → footer reads "cached" (else "fresh").
- `rain_probability_hrrr` or `rain_probability_aifs` `null` → Chart.js `spanGaps: true` connects across the gap; the consensus bar still renders from `rain_probability_consensus`.
- `tennis_windows` length `!== 4` → grid stretches; no crash, but copy assumes 4. If the backend changes the count, update the grid breakpoints in `index.html` and the explanatory copy.
- `first_rain_hour_local` `null` → "Rain begins…" pill is omitted entirely; the subtitle row simply has one fewer pill.
- `best_window` `null` → "Best window" pill is omitted **and** no BEST badge renders on any window card.
- `wind_max_mph` `null` → both the Wind subtitle pill and the Wind stat tile fall back gracefully (pill skipped, stat shows `—`).
- `confidence` always renders; if the value is missing or unrecognized, it falls back to "Unknown" with the neutral amber tone.
- `verdict` legacy values (`CAUTION`, `NO_GO`, `NO-GO`) are mapped forward to `light` / `heavy` so a stale backend never breaks the render.
- `tennis_windows[].verdict` legacy values are mapped the same way — both the pill color and the BEST-badge match key go through `verdictClass()`.
- `today.is_concluded: true` → hero swaps to the calm "COMPLETE" view (slate `.verdict-complete`, no glow, no pills, no agreement chip); the agreement-chip slot fills with a "See Tomorrow's forecast" CTA; the stats row drops the (null) rain tile; every tennis-window card gets `.is-past` (opacity 0.6, no hover lift) and the BEST badge is suppressed; the day-toggle's Today button gets `.is-done` (line-through label, "Day complete" subtitle, dimmed but still clickable).
- `today` missing (e.g. payload from an older backend) → `currentDay(data)` returns `undefined`; `renderHero` falls back to `data.tomorrow` so the page never goes blank, and the day-toggle's Today subtitle renders `"—"`.
- `tennis_windows[].is_past: true` → that single window card gets `.is-past` styling within an otherwise-active day (e.g. midday today after lunch).
- `selectedDay` is preserved across auto-refresh and `visibilitychange` re-fetches — the user's manual choice is never overwritten by a network round-trip.
- Fetch failure on first load → `#error-state` shows with a retry button. Fetch failure after a successful load → silent, last-good data retained.
- `prefers-reduced-motion: reduce` → background gradient animation, shimmer, and entrance animations all disabled (handled in `styles.css`). The day-toggle's sliding indicator drops its `transform` transition but keeps a brief gradient/shadow crossfade so the active-day color is still legible.

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
