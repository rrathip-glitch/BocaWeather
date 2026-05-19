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

  const verdictClass = (v) => {
    if (v === 'GO') return 'go';
    if (v === 'NO_GO' || v === 'NO-GO') return 'nogo';
    return 'caution';
  };

  const verdictLabel = (v) => {
    if (v === 'GO') return 'GO';
    if (v === 'NO_GO' || v === 'NO-GO') return 'NO-GO';
    return 'CAUTION';
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
  async function loadForecast() {
    try {
      const res = await fetch(API_URL, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      hideError();
      lastPayload = data;
      renderAll(data);
    } catch (err) {
      console.error('[forecast] load failed', err);
      // If we already have data, keep showing it. Only show error if first load.
      if (!lastPayload) showError(err.message || 'Network error');
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadForecast, REFRESH_MS);
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
    renderHourlyStrip(data);
    renderFooter(data);
  }

  // ---- Hero ----
  function renderHero(data) {
    const t = data.tomorrow;
    const vClass = verdictClass(t.verdict);
    const vLabel = verdictLabel(t.verdict);

    // Verdict text
    const verdictEl = $('#verdict');
    verdictEl.textContent = vLabel;
    verdictEl.className = `font-black leading-none tracking-tightest text-7xl sm:text-9xl select-none verdict-${vClass} anim-scale-in`;

    // Glow
    const glow = $('#hero-glow');
    glow.className = `hero-glow glow-${vClass}`;

    // Date — parse YYYY-MM-DD as noon UTC to safely format the calendar date in NY tz
    // (avoids DST edge cases vs. fixed-offset parsing).
    const dateLong = fmtDateLong(new Date(t.date + 'T17:00:00Z'));
    const dateEl = $('#hero-date');
    dateEl.innerHTML = '';
    dateEl.textContent = `Tomorrow · ${dateLong}`;
    dateEl.classList.add('anim-fade-up');

    // Reason
    const reasonEl = $('#verdict-reason');
    reasonEl.innerHTML = '';
    reasonEl.textContent = t.verdict_reason || '';
    reasonEl.classList.add('anim-fade-up');
    reasonEl.style.setProperty('animation-delay', '60ms');

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

  function renderHeroStats(t) {
    const grid = $('#hero-stats');
    const stats = [
      { label: 'Max rain prob.', value: `${Math.round(t.rain_probability_max ?? 0)}%`, tint: rainTint(t.rain_probability_max) },
      { label: 'Mean rain prob.', value: `${Math.round(t.rain_probability_mean ?? 0)}%`, tint: rainTint(t.rain_probability_mean) },
      { label: 'Total precip.', value: `${(t.precipitation_sum_in ?? 0).toFixed(2)}″`, tint: null },
      { label: 'High / Low', value: `${Math.round(t.temperature_high_f)}° / ${Math.round(t.temperature_low_f)}°`, tint: null },
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
    grid.classList.add('stagger');
    grid.innerHTML = windows.map((w, i) => {
      const vc = verdictClass(w.verdict);
      const vl = verdictLabel(w.verdict);
      return `
        <article class="window-card acc-${vc} anim-fade-up" style="--i:${i}; animation-delay:${i * 60}ms;">
          <div class="flex items-start justify-between gap-2 mb-3">
            <div>
              <div class="text-xs uppercase tracking-[0.18em] text-ink-50 font-semibold mb-1">${w.label}</div>
              <div class="text-sm text-ink-70">${fmtTimeRange(w.start, w.end)}</div>
            </div>
            <span class="verdict-pill pill-${vc}">${vl}</span>
          </div>
          <div class="flex items-baseline gap-2 mb-2">
            <div class="text-4xl font-bold text-ink-100 tabular-nums">${Math.round(w.max_rain_prob)}<span class="text-lg text-ink-50 font-medium">%</span></div>
            <div class="text-[11px] text-ink-50 uppercase tracking-wider">peak rain</div>
          </div>
          <p class="text-xs sm:text-sm text-ink-70 leading-snug">${w.reason || ''}</p>
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
                return h.disagreement ? '\n⚠ Models disagree this hour' : '';
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
      plugins: [nightPlugin, disagreePlugin],
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
        ${h.disagreement ? '<div class="text-[9px] text-caution font-bold uppercase tracking-wider mt-0.5">⚠ split</div>' : ''}
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
  // Retry button
  // ============================================================
  function wireRetry() {
    const btn = $('#retry-button');
    if (btn) btn.addEventListener('click', () => { hideError(); loadForecast(); });
  }

  // ============================================================
  // Boot
  // ============================================================
  function init() {
    wireHowItWorks();
    wireRetry();
    loadForecast();
    scheduleRefresh();

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
