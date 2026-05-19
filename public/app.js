/* ============================================================
   Boca Tennis Weather — frontend logic
   Vanilla JS. Fetches /api/forecast, renders all sections.
   Auto-refresh every 10 minutes. All render fns are pure-ish:
   they take the API payload and write into known DOM nodes.
   ============================================================ */

(() => {
  'use strict';

  // -------- Config --------
  const API_URL = '/api/forecast';
  const REFRESH_MS = 10 * 60 * 1000; // 10 minutes
  const TZ = 'America/New_York';

  // -------- State --------
  let chartInstance = null;
  let refreshTimer = null;
  let lastPayload = null;

  // ============================================================
  // Utilities
  // ============================================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const fmtDateLong = (d) => new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: TZ
  }).format(d);

  // Full standard format including the year — e.g. "Wednesday, May 20, 2026".
  const fmtDateFull = (d) => new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: TZ
  }).format(d);

  // Parse a "YYYY-MM-DD" string as noon LOCAL — keeps it on the intended calendar day
  // regardless of viewer timezone (avoids "2026-05-20" → previous-day drift in -HHMM zones).
  const parseLocalDate = (ymd) => new Date(`${ymd}T12:00:00`);

  const fmtTimeShort = (d) => new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', timeZone: TZ
  }).format(d);

  const fmtTimeRange = (startIso, endIso) => {
    const s = fmtTimeShort(new Date(startIso));
    const e = fmtTimeShort(new Date(endIso));
    return `${s}–${e}`;
  };

  const fmtTimestamp = (iso) => new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: TZ, timeZoneName: 'short'
  }).format(new Date(iso));

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // Minimal HTML escape — used wherever backend strings flow into innerHTML
  // (best_window.label, first_rain_hour_local, etc.). Belt-and-suspenders;
  // these fields are server-generated, but never trust strings going into HTML.
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const escapeAttr = (s) => escapeHtml(s);

  // Verdict tiers (backend): GO | LIGHT_CAUTION | HEAVY_CAUTION
  // Tier class drives CSS hierarchy: verdict-{go|light|heavy}, glow-{go|light|heavy},
  // window-card.acc-{go|light|heavy}, pill-{go|light|heavy}.
  // Legacy values (CAUTION, NO_GO) are mapped for forward-safety during the
  // backend rollout, but the canonical tiers above are what render in production.
  const verdictClass = (v) => {
    if (v === 'GO') return 'go';
    if (v === 'HEAVY_CAUTION' || v === 'NO_GO' || v === 'NO-GO') return 'heavy';
    return 'light'; // LIGHT_CAUTION + legacy CAUTION
  };

  const verdictLabel = (v) => {
    if (v === 'GO') return 'GO';
    if (v === 'HEAVY_CAUTION' || v === 'NO_GO' || v === 'NO-GO') return 'HEAVY CAUTION';
    return 'CAUTION'; // LIGHT_CAUTION renders as just "CAUTION"
  };

  // WMO weathercode → emoji
  const weatherIcon = (code) => {
    if (code == null) return '·';
    if (code === 0) return '☀️';
    if (code >= 1 && code <= 3) return '🌤️';
    if (code === 45 || code === 48) return '🌫️';
    if (code >= 51 && code <= 57) return '🌦️';
    if (code >= 61 && code <= 67) return '🌧️';
    if (code >= 71 && code <= 77) return '🌨️';
    if (code >= 80 && code <= 82) return '🌧️';
    if (code >= 95 && code <= 99) return '⛈️';
    return '🌥️';
  };

  const rainTint = (p) => {
    if (p == null) return 'rgba(255,255,255,0.15)';
    if (p < 35) return '#4ade80';
    if (p < 60) return '#fbbf24';
    return '#f87171';
  };

  // Is the given ISO time during night (between sunset and the *next* sunrise)?
  // For a 36-hour chart we need a sensible recurring night band.
  // We treat any hour where local hour < sunriseHour or >= sunsetHour as night.
  const buildNightTester = (sunriseIso, sunsetIso) => {
    const sr = new Date(sunriseIso);
    const ss = new Date(sunsetIso);
    const localHour = (d) => Number(new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: TZ
    }).format(d));
    const sunriseHour = localHour(sr);
    const sunsetHour = localHour(ss);
    return (d) => {
      const h = localHour(d);
      return h < sunriseHour || h >= sunsetHour;
    };
  };

  // ============================================================
  // Fetch + lifecycle
  // ============================================================
  // `refresh: true` appends ?refresh=1 to force the backend to bypass its cache.
  // The 10-min auto-refresh and the visibilitychange handler use the default
  // (cached); only the manual header button forces a refresh.
  async function loadForecast(opts = {}) {
    const { refresh = false } = opts;
    const url = refresh ? `${API_URL}?refresh=1` : API_URL;
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      hideError();
      lastPayload = data;
      renderAll(data);
      return data;
    } catch (err) {
      console.error('[forecast] load failed', err);
      // If we already have data, keep showing it. Only show error if first load.
      if (!lastPayload) showError(err.message || 'Network error');
      throw err;
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => loadForecast(), REFRESH_MS);
  }

  function showError(msg) {
    const el = $('#error-state');
    if (!el) return;
    el.classList.remove('hidden');
    $('#error-message').textContent = msg;
  }

  function hideError() {
    const el = $('#error-state');
    if (el) el.classList.add('hidden');
  }

  // ============================================================
  // Renderers
  // ============================================================
  function renderAll(data) {
    renderHero(data);
    renderNowStrip(data);
    renderTennisWindows(data);
    renderHourlyChart(data);
    renderRadar(data);
    renderHourlyStrip(data);
    renderFooter(data);
  }

  // ---- Hero ----
  function renderHero(data) {
    const t = data.tomorrow;
    const vClass = verdictClass(t.verdict);
    const vLabel = verdictLabel(t.verdict);

    // Verdict word — tier-specific size/weight/glow handled in styles.css via
    // .verdict-{go|light|heavy}. We keep the class list minimal here so the
    // CSS owns the visual hierarchy.
    const verdictEl = $('#verdict');
    verdictEl.textContent = vLabel;
    verdictEl.className = `verdict-word verdict-${vClass} anim-scale-in`;

    // Glow
    const glow = $('#hero-glow');
    glow.className = `hero-glow glow-${vClass}`;

    // Date — parse "YYYY-MM-DD" as noon LOCAL so the calendar day never drifts
    // backward in negative-offset zones. Format with the full standard pattern,
    // e.g. "Wednesday, May 20, 2026".
    const dateLong = fmtDateFull(parseLocalDate(t.date));
    const dateEl = $('#hero-date');
    dateEl.innerHTML = '';
    dateEl.textContent = dateLong;
    dateEl.classList.add('anim-fade-up');

    // Reason
    const reasonEl = $('#verdict-reason');
    reasonEl.innerHTML = '';
    reasonEl.textContent = t.verdict_reason || '';
    reasonEl.classList.add('anim-fade-up');
    reasonEl.style.setProperty('animation-delay', '60ms');

    // Subtitle pills (first rain · best window · wind · confidence)
    renderHeroPills(t);

    // Agreement chip
    renderAgreementChip(t);

    // Quick stats
    renderHeroStats(t);
  }

  function renderAgreementChip(t) {
    const chip = $('#agreement-chip');
    chip.classList.add('anim-fade-up');
    chip.style.setProperty('animation-delay', '120ms');

    if (t.model_agreement === 'AGREE') {
      chip.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-go/10 border border-go/30 text-go anim-fade-up';
      chip.innerHTML = `
        <span class="h-1.5 w-1.5 rounded-full bg-go"></span>
        <span>Both models agree · forecast confident</span>
      `;
    } else {
      const note = t.uncertainty_note ? ` — ${t.uncertainty_note}` : '';
      chip.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-caution/10 border border-caution/30 text-caution anim-fade-up';
      chip.innerHTML = `
        <span class="h-1.5 w-1.5 rounded-full bg-caution"></span>
        <span>Models disagree · forecast uncertain${note}</span>
      `;
    }
  }

  // ---- Hero subtitle pills ----
  // Renders up to 4 glass micro-pills below verdict_reason:
  //   1. First rain (when first_rain_hour_local is set)
  //   2. Best window (when best_window is non-null) — green if best is GO, amber otherwise
  //   3. Wind peak (always when wind_max_mph is non-null)
  //   4. Forecast confidence (always — color tracks HIGH/MODERATE/LOW)
  // Pills are skipped silently when their data is missing so the row never
  // shows empty placeholders post-render.
  function renderHeroPills(t) {
    const host = $('#hero-pills');
    if (!host) return;

    const confLevel = (t.confidence || '').toUpperCase();
    const confTone  = confLevel === 'HIGH' ? 'green'
                    : confLevel === 'LOW'  ? 'coral'
                    : 'amber';
    const confLabel = confLevel ? confLevel.charAt(0) + confLevel.slice(1).toLowerCase() : 'Unknown';

    const bestVerdictClass = t.best_window ? verdictClass(t.best_window.verdict) : null;
    const bestTone = bestVerdictClass === 'go' ? 'green'
                   : bestVerdictClass === 'heavy' ? 'coral'
                   : 'amber';

    const pills = [];

    if (t.first_rain_hour_local) {
      pills.push({
        tone: 'amber',
        title: 'Earliest hour when meaningful rain becomes likely.',
        html: `<span class="pill-dot"></span><span>Rain begins ~<strong>${escapeHtml(t.first_rain_hour_local)}</strong></span>`,
      });
    }

    if (t.best_window && t.best_window.label) {
      const lbl = escapeHtml(t.best_window.label);
      const peak = (t.best_window.max_rain_prob != null)
        ? ` · ${Math.round(t.best_window.max_rain_prob)}%`
        : '';
      pills.push({
        tone: bestTone,
        title: 'Lowest-risk slot to play tomorrow.',
        html: `<span class="pill-dot"></span><span>Best window: <strong>${lbl}</strong>${peak}</span>`,
      });
    }

    if (t.wind_max_mph != null) {
      pills.push({
        tone: 'slate',
        title: 'Peak forecast wind during tennis hours.',
        html: `<span class="pill-dot"></span><span>Wind: <strong>${Math.round(t.wind_max_mph)} mph</strong> peak</span>`,
      });
    }

    pills.push({
      tone: confTone,
      title: t.confidence_note || 'How confident the models are in this verdict.',
      html: `<span class="pill-dot"></span><span>Forecast confidence: <strong>${confLabel}</strong></span>`,
    });

    host.innerHTML = pills.map((p, i) => `
      <span class="hero-pill anim-fade-up" data-tone="${p.tone}" title="${escapeAttr(p.title)}" style="animation-delay:${80 + i * 60}ms;">
        ${p.html}
      </span>
    `).join('');
  }

  // Stats row — peak rain, wind peak, high, low. Wind replaced "mean rain"
  // because mean is buried in the chart already and wind directly affects
  // tennis playability.
  function renderHeroStats(t) {
    const grid = $('#hero-stats');
    const stats = [
      { label: 'Peak rain', value: `${Math.round(t.rain_probability_max ?? 0)}%`, tint: rainTint(t.rain_probability_max) },
      { label: 'Wind (peak)', value: t.wind_max_mph != null ? `${Math.round(t.wind_max_mph)} mph` : '—', tint: null },
      { label: 'High', value: `${Math.round(t.temperature_high_f)}°`, tint: null },
      { label: 'Low',  value: `${Math.round(t.temperature_low_f)}°`,  tint: null },
    ];
    grid.innerHTML = stats.map((s, i) => `
      <div class="stat anim-fade-up" style="--i:${i + 3}; animation-delay: ${(i + 3) * 60}ms;">
        <div class="text-[10px] uppercase tracking-[0.18em] text-ink-50 font-semibold mb-1">${s.label}</div>
        <div class="flex items-baseline gap-2">
          <div class="text-xl sm:text-2xl font-semibold text-ink-100 tabular-nums">${s.value}</div>
          ${s.tint ? `<span class="h-1.5 w-1.5 rounded-full" style="background:${s.tint}"></span>` : ''}
        </div>
      </div>
    `).join('');
    grid.classList.add('stagger');
  }

  // ---- Now strip ----
  function renderNowStrip(data) {
    if (!data.hourly || !data.hourly.length) return;
    const now = Date.now();
    // Find hour closest to "now"
    let current = data.hourly[0];
    let bestDiff = Infinity;
    for (const h of data.hourly) {
      const diff = Math.abs(new Date(h.time).getTime() - now);
      if (diff < bestDiff) { bestDiff = diff; current = h; }
    }

    $('#now-temp').textContent = `${Math.round(current.temperature_f)}°`;
    $('#now-rain').textContent = `${Math.round(current.rain_probability_consensus)}%`;

    const dot = $('#now-agree-dot');
    const text = $('#now-agree-text');
    if (data.tomorrow.model_agreement === 'AGREE') {
      dot.className = 'h-1.5 w-1.5 rounded-full bg-go';
      text.className = 'text-go';
      text.textContent = 'Models agree';
    } else {
      dot.className = 'h-1.5 w-1.5 rounded-full bg-caution';
      text.className = 'text-caution';
      text.textContent = 'Models disagree';
    }
  }

  // ---- Tennis windows ----
  function renderTennisWindows(data) {
    const grid = $('#windows-grid');
    const windows = data.tennis_windows || [];
    if (!windows.length) {
      grid.innerHTML = '<div class="col-span-full text-sm text-ink-50">No tennis windows available.</div>';
      return;
    }
    const bestLabel = data.tomorrow && data.tomorrow.best_window
      ? data.tomorrow.best_window.label
      : null;

    grid.classList.add('stagger');
    grid.innerHTML = windows.map((w, i) => {
      const vc = verdictClass(w.verdict);
      const vl = verdictLabel(w.verdict);
      const isBest = bestLabel && w.label === bestLabel;
      const bestBadge = isBest
        ? `<span class="best-badge" title="Lowest-risk window tomorrow"><svg viewBox="0 0 16 16" aria-hidden="true"><polyline points="3 8.5 6.5 12 13 5"/></svg>Best</span>`
        : '';
      return `
        <article class="window-card acc-${vc} anim-fade-up" style="--i:${i}; animation-delay:${i * 60}ms;">
          ${bestBadge}
          <div class="flex items-start justify-between gap-2 mb-3">
            <div>
              <div class="text-xs uppercase tracking-[0.18em] text-ink-50 font-semibold mb-1">${escapeHtml(w.label)}</div>
              <div class="text-sm text-ink-70">${fmtTimeRange(w.start, w.end)}</div>
            </div>
            <span class="verdict-pill pill-${vc}">${vl}</span>
          </div>
          <div class="flex items-baseline gap-2 mb-2">
            <div class="text-4xl font-bold text-ink-100 tabular-nums">${Math.round(w.max_rain_prob)}<span class="text-lg text-ink-50 font-medium">%</span></div>
            <div class="text-[11px] text-ink-50 uppercase tracking-wider">peak rain</div>
          </div>
          <p class="text-xs sm:text-sm text-ink-70 leading-snug">${escapeHtml(w.reason || '')}</p>
        </article>
      `;
    }).join('');
  }

  // ---- Hourly chart ----
  function renderHourlyChart(data) {
    const canvas = $('#rain-chart');
    if (!canvas || !data.hourly) return;

    const hours = data.hourly.slice(0, 36);
    const labels = hours.map(h => fmtTimeShort(new Date(h.time)));
    const hrrr = hours.map(h => h.rain_probability_hrrr);
    const aifs = hours.map(h => h.rain_probability_aifs);
    const cons = hours.map(h => h.rain_probability_consensus);

    // Night bands & disagreement bands (annotations as background)
    const isNight = data.tomorrow ? buildNightTester(data.tomorrow.sunrise, data.tomorrow.sunset) : () => false;

    // Robust half-step width via consecutive pixel positions on the category scale.
    const halfStep = (xScale) => {
      if (hours.length < 2) return 12;
      const a = xScale.getPixelForValue(0);
      const b = xScale.getPixelForValue(1);
      return Math.abs(b - a) / 2;
    };

    // Build the night-shade background plugin
    const nightPlugin = {
      id: 'nightShade',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea) return;
        const xScale = scales.x;
        const half = halfStep(xScale);
        ctx.save();
        hours.forEach((h, i) => {
          if (isNight(new Date(h.time))) {
            const cx = xScale.getPixelForValue(i);
            const x0 = cx - half;
            const x1 = cx + half;
            ctx.fillStyle = 'rgba(11, 29, 58, 0.35)';
            ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
          }
        });
        ctx.restore();
      }
    };

    // Disagreement vertical band plugin (drawn over night, under datasets)
    const disagreePlugin = {
      id: 'disagreeBand',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea) return;
        const xScale = scales.x;
        const half = halfStep(xScale);
        ctx.save();
        hours.forEach((h, i) => {
          if (h.disagreement) {
            const cx = xScale.getPixelForValue(i);
            const x0 = cx - half;
            const x1 = cx + half;
            const grad = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            grad.addColorStop(0, 'rgba(251, 191, 36, 0.22)');
            grad.addColorStop(1, 'rgba(251, 191, 36, 0.04)');
            ctx.fillStyle = grad;
            ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);

            // Top tick marker
            ctx.fillStyle = 'rgba(251, 191, 36, 0.85)';
            ctx.fillRect(cx - 1, chartArea.top, 2, 6);
          }
        });
        ctx.restore();
      }
    };

    // -------- Sunrise / sunset vertical markers --------
    // Subtle dotted verticals at the sunrise & sunset boundaries that fall
    // inside the visible 36-hour window. Amber for sunrise, indigo for sunset.
    // X position is interpolated between the two surrounding hour buckets so
    // the line lands at the correct fractional offset (sunrise rarely sits on
    // an exact wall-clock hour).
    const sunMarkers = [];
    if (data.tomorrow) {
      const first = new Date(hours[0].time).getTime();
      const last  = new Date(hours[hours.length - 1].time).getTime();
      const within = (ms) => ms >= first && ms <= last;
      const interpIndex = (ms) => {
        // Linear interpolation between the two surrounding hour timestamps.
        for (let i = 0; i < hours.length - 1; i++) {
          const t0 = new Date(hours[i].time).getTime();
          const t1 = new Date(hours[i + 1].time).getTime();
          if (ms >= t0 && ms <= t1) {
            return i + (ms - t0) / Math.max(1, t1 - t0);
          }
        }
        return null;
      };
      const sr = new Date(data.tomorrow.sunrise).getTime();
      const ss = new Date(data.tomorrow.sunset).getTime();
      if (within(sr)) {
        const fi = interpIndex(sr);
        if (fi != null) sunMarkers.push({ fIndex: fi, color: 'rgba(251, 191, 36, 0.30)', label: 'SUNRISE' });
      }
      if (within(ss)) {
        const fi = interpIndex(ss);
        if (fi != null) sunMarkers.push({ fIndex: fi, color: 'rgba(129, 140, 248, 0.30)', label: 'SUNSET' });
      }
    }

    const sunMarkersPlugin = {
      id: 'sunMarkers',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !sunMarkers.length) return;
        const xScale = scales.x;
        ctx.save();
        for (const m of sunMarkers) {
          // Interpolate pixel x between bucket centers.
          const lo = Math.floor(m.fIndex);
          const hi = Math.min(lo + 1, hours.length - 1);
          const frac = m.fIndex - lo;
          const x = xScale.getPixelForValue(lo) + (xScale.getPixelForValue(hi) - xScale.getPixelForValue(lo)) * frac;
          ctx.strokeStyle = m.color;
          ctx.lineWidth = 1;
          ctx.setLineDash([1, 3]);
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top + 14);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          // Tiny label
          ctx.fillStyle = m.color.replace(/[\d.]+\)$/, '0.7)');
          ctx.font = '600 9px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(m.label, x, chartArea.top);
        }
        ctx.restore();
      }
    };

    // -------- "NOW" vertical line --------
    // Dashed white line at the current local time, with a tiny "NOW" label at
    // the top of the plot area. The line uses the same interpolation pattern
    // as the sunrise/sunset markers so it lands precisely between buckets
    // when "now" sits mid-hour.
    const nowPlugin = {
      id: 'nowLine',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !hours.length) return;
        const nowMs = Date.now();
        const first = new Date(hours[0].time).getTime();
        const last  = new Date(hours[hours.length - 1].time).getTime();
        if (nowMs < first || nowMs > last) return;
        let fIndex = null;
        for (let i = 0; i < hours.length - 1; i++) {
          const t0 = new Date(hours[i].time).getTime();
          const t1 = new Date(hours[i + 1].time).getTime();
          if (nowMs >= t0 && nowMs <= t1) {
            fIndex = i + (nowMs - t0) / Math.max(1, t1 - t0);
            break;
          }
        }
        if (fIndex == null) return;
        const xScale = scales.x;
        const lo = Math.floor(fIndex);
        const hi = Math.min(lo + 1, hours.length - 1);
        const frac = fIndex - lo;
        const x = xScale.getPixelForValue(lo) + (xScale.getPixelForValue(hi) - xScale.getPixelForValue(lo)) * frac;

        ctx.save();
        ctx.strokeStyle = 'rgba(240, 246, 252, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top + 14);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);

        // "NOW" label — small uppercase chip at the top of the line
        ctx.fillStyle = 'rgba(240, 246, 252, 0.85)';
        ctx.font = '700 9.5px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('NOW', x, chartArea.top);
        ctx.restore();
      }
    };

    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }

    const ctx = canvas.getContext('2d');

    // Build the consensus bar gradient (subtle)
    const barGrad = ctx.createLinearGradient(0, 0, 0, 380);
    barGrad.addColorStop(0, 'rgba(125, 211, 252, 0.55)');
    barGrad.addColorStop(1, 'rgba(125, 211, 252, 0.05)');

    chartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Consensus',
            data: cons,
            backgroundColor: barGrad,
            borderColor: 'rgba(125, 211, 252, 0.5)',
            borderWidth: 0,
            borderRadius: 4,
            barPercentage: 0.85,
            categoryPercentage: 0.95,
            order: 3,
          },
          {
            type: 'line',
            label: 'HRRR',
            data: hrrr,
            borderColor: '#7dd3fc',
            backgroundColor: 'rgba(125, 211, 252, 0.0)',
            borderWidth: 2.5,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: '#7dd3fc',
            spanGaps: true,
            order: 1,
          },
          {
            type: 'line',
            label: 'AIFS',
            data: aifs,
            borderColor: '#c084fc',
            backgroundColor: 'rgba(192, 132, 252, 0.0)',
            borderWidth: 2.5,
            borderDash: [4, 4],
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: '#c084fc',
            spanGaps: true,
            order: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 600, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(11, 29, 58, 0.92)',
            borderColor: 'rgba(255,255,255,0.15)',
            borderWidth: 1,
            titleColor: '#f0f6fc',
            bodyColor: 'rgba(240,246,252,0.85)',
            padding: 12,
            cornerRadius: 10,
            titleFont: { family: 'Inter', weight: '600', size: 12 },
            bodyFont: { family: 'Inter', size: 12 },
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const i = items[0].dataIndex;
                const h = hours[i];
                return fmtTimeShort(new Date(h.time)) + (h.is_tomorrow ? ' · Tomorrow' : ' · Today');
              },
              label: (ctx) => {
                const v = ctx.parsed.y;
                if (v == null) return `${ctx.dataset.label}: —`;
                return `${ctx.dataset.label}: ${Math.round(v)}%`;
              },
              afterBody: (items) => {
                if (!items.length) return '';
                const h = hours[items[0].dataIndex];
                return h.disagreement ? '\nModels disagree this hour' : '';
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: 'rgba(240,246,252,0.55)',
              font: { family: 'Inter', size: 10, weight: '500' },
              maxRotation: 0,
              autoSkip: true,
              autoSkipPadding: 12,
            },
            border: { color: 'rgba(255,255,255,0.08)' },
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: 'rgba(255,255,255,0.06)', drawTicks: false },
            ticks: {
              color: 'rgba(240,246,252,0.55)',
              font: { family: 'Inter', size: 10 },
              padding: 8,
              stepSize: 25,
              callback: (v) => `${v}%`,
            },
            border: { display: false },
          },
        },
      },
      plugins: [nightPlugin, disagreePlugin, sunMarkersPlugin, nowPlugin],
    });
  }

  // ---- Hourly strip ----
  function renderHourlyStrip(data) {
    const strip = $('#hourly-strip');
    if (!data.hourly) return;
    const next24 = data.hourly.slice(0, 24);
    const isNight = data.tomorrow ? buildNightTester(data.tomorrow.sunrise, data.tomorrow.sunset) : () => false;

    strip.innerHTML = '';
    strip.classList.add('anim-slide-in');

    next24.forEach((h, i) => {
      const p = Math.round(h.rain_probability_consensus ?? 0);
      const tint = rainTint(p);
      const night = isNight(new Date(h.time));
      const chip = document.createElement('div');
      chip.className = `strip-chip ${h.disagreement ? 'is-disagree' : ''} ${night ? 'is-night' : ''}`;
      chip.style.animation = `fadeUp 350ms cubic-bezier(0.2,0.7,0.2,1) ${i * 25}ms both`;
      chip.innerHTML = `
        <div class="chip-hour">${fmtTimeShort(new Date(h.time))}</div>
        <div class="chip-icon" aria-hidden="true">${weatherIcon(h.weathercode)}</div>
        <div class="chip-temp tabular-nums">${Math.round(h.temperature_f)}°</div>
        <div class="chip-rain tabular-nums">${p}%</div>
        ${h.disagreement ? '<div class="chip-split"><svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 1.2 11 10.4H1L6 1.2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 5v2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="9" r="0.7" fill="currentColor"/></svg><span>Split</span></div>' : ''}
        <div class="chip-bar"><span style="width:${clamp(p, 2, 100)}%; background:${tint}"></span></div>
      `;
      strip.appendChild(chip);
    });
  }

  // ---- Footer ----
  function renderFooter(data) {
    const info = $('#generated-info');
    if (!info) return;
    const when = data.generated_at ? fmtTimestamp(data.generated_at) : '—';
    const cachedLabel = data.cached ? 'cached' : 'fresh';
    info.innerHTML = `Forecast generated at <span class="text-ink-70">${when}</span> · <span class="text-ink-70">${cachedLabel}</span>`;
  }

  // ============================================================
  // Toast (transient status pill)
  // ============================================================
  let toastTimer = null;
  function showToast(msg, kind = 'ok', ms = 2000) {
    const el = $('#refresh-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('is-ok', 'is-error');
    el.classList.add(kind === 'error' ? 'is-error' : 'is-ok', 'is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), ms);
  }

  // ============================================================
  // Manual refresh button
  // ============================================================
  function wireRefreshButton() {
    const btn = $('#refresh-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('is-refreshing');
      try {
        await loadForecast({ refresh: true });
        showToast('Updated', 'ok');
      } catch (err) {
        showToast('Refresh failed', 'error');
      } finally {
        btn.classList.remove('is-refreshing');
        btn.disabled = false;
      }
    });
  }

  // ============================================================
  // Live Radar (Leaflet + RainViewer)
  // ============================================================
  const RADAR_CENTER = [26.3797, -80.1539];
  const RADAR_API = 'https://api.rainviewer.com/public/weather-maps.json';
  const RADAR_FRAME_MS = 500;
  const RADAR_LOOP_PAUSE_MS = 1500;
  // RainViewer color schemes: 0=BW, 1=Original, 2=Universal Blue, 3=TITAN,
  // 4=Weather Channel, 5=Meteored, 6=NEXRAD, 7=Rainbow, 8=Dark.
  const RADAR_COLOR = 2;

  const radarState = {
    map: null,
    host: '',
    frames: [],       // [{ time, path, kind: 'past' | 'nowcast' }]
    pastCount: 0,
    layers: {},       // index → L.tileLayer
    activeLayer: null,
    activeIndex: -1,
    playing: false,
    playTimer: null,
    booted: false,
  };

  function initRadar() {
    if (radarState.booted) return;
    if (typeof L === 'undefined') {
      // Leaflet loads with `defer`; if it isn't ready yet, retry once DOM settles.
      window.addEventListener('load', initRadar, { once: true });
      return;
    }
    const host = document.getElementById('radar-map');
    if (!host) return;
    radarState.booted = true;

    const map = L.map(host, {
      center: RADAR_CENTER,
      zoom: 9,
      minZoom: 7,
      maxZoom: 12,
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: true,
    });
    radarState.map = map;

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
      pane: 'shadowPane',
      attribution: '',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    // Custom pulsing marker at the home location.
    const icon = L.divIcon({
      className: 'radar-marker-wrap',
      html: '<div class="radar-marker" aria-hidden="true"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    L.marker(RADAR_CENTER, { icon, keyboard: false, interactive: false }).addTo(map);

    wireRadarControls();
    loadRadarFrames();
  }

  async function loadRadarFrames() {
    try {
      const res = await fetch(RADAR_API, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`RainViewer responded ${res.status}`);
      const data = await res.json();
      const host = data.host;
      const past = (data.radar && data.radar.past) || [];
      const nowcast = (data.radar && data.radar.nowcast) || [];
      const frames = [
        ...past.map(f => ({ ...f, kind: 'past' })),
        ...nowcast.map(f => ({ ...f, kind: 'nowcast' })),
      ];
      if (!frames.length) throw new Error('No radar frames available');

      radarState.host = host;
      radarState.frames = frames;
      radarState.pastCount = past.length;

      const slider = $('#radar-slider');
      if (slider) {
        slider.max = String(frames.length - 1);
        slider.value = '0';
        const pastPct = frames.length > 1
          ? Math.round((past.length / frames.length) * 100)
          : 100;
        slider.style.setProperty('--past-pct', `${pastPct}%`);
      }

      showRadarFrame(0);
      startRadarAutoplay();
    } catch (err) {
      console.error('[radar] load failed', err);
      showRadarFallback();
    }
  }

  function showRadarFallback() {
    const fb = $('#radar-fallback');
    if (fb) fb.classList.remove('hidden');
    // Disable controls — but leave the base map visible underneath.
    const slider = $('#radar-slider');
    const playBtn = $('#radar-play');
    if (slider) slider.disabled = true;
    if (playBtn) playBtn.disabled = true;
  }

  function tileUrlForFrame(frame) {
    // 256px tiles, color scheme, options "1_1" = smooth + snow.
    return `${radarState.host}${frame.path}/256/{z}/{x}/{y}/${RADAR_COLOR}/1_1.png`;
  }

  function showRadarFrame(index) {
    const { map, frames, layers, activeLayer } = radarState;
    if (!map || !frames[index]) return;

    // Reuse cached layer if present; otherwise build it.
    let next = layers[index];
    if (!next) {
      next = L.tileLayer(tileUrlForFrame(frames[index]), {
        opacity: 0.0,
        attribution: '',
        tileSize: 256,
        crossOrigin: true,
      });
      layers[index] = next;
    }

    // Add the next layer first so the swap doesn't flicker, then drop the old.
    next.addTo(map);
    next.setOpacity(0.75);
    if (activeLayer && activeLayer !== next) {
      map.removeLayer(activeLayer);
    }
    radarState.activeLayer = next;
    radarState.activeIndex = index;

    updateRadarUi(index);
  }

  function updateRadarUi(index) {
    const frame = radarState.frames[index];
    if (!frame) return;
    const slider = $('#radar-slider');
    const timeEl = $('#radar-time');
    if (slider && Number(slider.value) !== index) slider.value = String(index);

    if (slider) {
      slider.classList.toggle('is-nowcast-thumb', frame.kind === 'nowcast');
    }

    if (timeEl) {
      timeEl.classList.toggle('is-nowcast', frame.kind === 'nowcast');
      if (frame.kind === 'nowcast') {
        const nowSec = Math.floor(Date.now() / 1000);
        const minsAhead = Math.max(0, Math.round((frame.time - nowSec) / 60));
        timeEl.textContent = `+${minsAhead} min`;
      } else {
        timeEl.textContent = fmtTimeShort(new Date(frame.time * 1000));
      }
    }
  }

  function startRadarAutoplay() {
    stopRadarAutoplay();
    radarState.playing = true;
    setRadarPlayIcon(true);

    const step = () => {
      const { activeIndex, frames } = radarState;
      const isLast = activeIndex >= frames.length - 1;
      const delay = isLast ? RADAR_LOOP_PAUSE_MS : RADAR_FRAME_MS;
      radarState.playTimer = setTimeout(() => {
        if (!radarState.playing) return;
        const nextIndex = isLast ? 0 : activeIndex + 1;
        showRadarFrame(nextIndex);
        step();
      }, delay);
    };
    step();
  }

  function stopRadarAutoplay() {
    radarState.playing = false;
    if (radarState.playTimer) {
      clearTimeout(radarState.playTimer);
      radarState.playTimer = null;
    }
    setRadarPlayIcon(false);
  }

  function setRadarPlayIcon(playing) {
    const playIcon = document.querySelector('.radar-play-icon');
    const pauseIcon = document.querySelector('.radar-pause-icon');
    if (!playIcon || !pauseIcon) return;
    playIcon.classList.toggle('hidden', playing);
    pauseIcon.classList.toggle('hidden', !playing);
  }

  function wireRadarControls() {
    const playBtn = $('#radar-play');
    const slider = $('#radar-slider');
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        if (radarState.playing) stopRadarAutoplay();
        else startRadarAutoplay();
      });
    }
    if (slider) {
      slider.addEventListener('input', () => {
        stopRadarAutoplay();
        const idx = Number(slider.value);
        showRadarFrame(idx);
      });
    }
  }

  // `renderRadar` is intentionally a no-op: the radar lifecycle is independent
  // of the forecast payload — it bootstraps once on init and self-refreshes
  // through autoplay. Kept as a hook so future radar/forecast cross-talk
  // (e.g. drop a pin per disagreement hour) has an obvious home.
  function renderRadar(_data) { /* no-op */ }

  // ============================================================
  // "How this works" popover
  // ============================================================
  function wireHowItWorks() {
    const open = $('#how-it-works-btn');
    const close = $('#how-close');
    const modal = $('#how-it-works');
    if (!open || !modal) return;
    open.addEventListener('click', () => modal.classList.remove('hidden'));
    close.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.add('hidden'); });
  }

  // ============================================================
  // Retry button — mirrors the header refresh-button UX: disable + spin
  // the icon while a retry is in flight, toast on outcome.
  // ============================================================
  function wireRetry() {
    const btn = $('#retry-button');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('is-refreshing');
      try {
        await loadForecast();
        showToast('Updated', 'ok');
      } catch (err) {
        showToast('Retry failed', 'error');
      } finally {
        btn.classList.remove('is-refreshing');
        btn.disabled = false;
      }
    });
  }

  // ============================================================
  // Chart legend popovers — (?) buttons next to HRRR/AIFS labels.
  // Click toggles aria-expanded which CSS uses to show the popover.
  // Hover-only behavior on desktop is pure-CSS (no JS needed).
  // Outside-click and Escape both dismiss.
  // ============================================================
  function wireLegendPopovers() {
    const buttons = $$('.legend-help');
    if (!buttons.length) return;
    const closeAll = () => buttons.forEach(b => b.setAttribute('aria-expanded', 'false'));
    buttons.forEach(btn => {
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = btn.getAttribute('aria-expanded') === 'true';
        closeAll();
        btn.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
      });
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.legend-help')) closeAll();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  }

  // ============================================================
  // Boot
  // ============================================================
  function init() {
    wireHowItWorks();
    wireRetry();
    wireRefreshButton();
    wireLegendPopovers();
    loadForecast();
    scheduleRefresh();
    initRadar();

    // Pause-refresh when tab hidden, resume + refresh on visible.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      } else {
        loadForecast();
        scheduleRefresh();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
