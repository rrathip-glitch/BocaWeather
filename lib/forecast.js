import {
  LATITUDE,
  LONGITUDE,
  LOCATION_NAME,
  TIMEZONE,
  MODEL_HRRR,
  MODEL_AIFS,
  TENNIS_WINDOWS
} from "./config.js";

export const VERDICT = {
  GO: "GO",
  LIGHT_CAUTION: "LIGHT_CAUTION",
  HEAVY_CAUTION: "HEAVY_CAUTION"
};

const DISAGREEMENT_HOURLY_PP = 25;
const DISAGREEMENT_DAILY_PP = 30;

const TENNIS_DAY_START_HOUR = 6;
const TENNIS_DAY_END_HOUR = 21;
const NOGO_HEAVY_HOURS = 6;
const NOGO_HEAVY_PROB = 60;
const NOGO_PRECIP_IN = 0.4;
const CAUTION_PEAK_PROB = 50;
const CAUTION_PRECIP_IN = 0.1;
const CAUTION_DISAGREEMENT_PROB = 35;

const CONFIDENCE_HIGH_MAX_DIFF = 5;
const CONFIDENCE_MODERATE_MAX_DIFF = 15;
const FIRST_RAIN_THRESHOLD = 50;

function pickFirst(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined) return obj[k];
  }
  return null;
}

function num(v) {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

function avg(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}

function localDateString(date) {
  // Format YYYY-MM-DD in the configured timezone
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(date);
}

function localHour(date) {
  // Wall-clock hour 0-23 in the configured timezone.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    hour12: false
  });
  // Some ICU builds return "24" for midnight; normalize to 0.
  const h = parseInt(fmt.format(date), 10);
  return h === 24 ? 0 : h;
}

function hourOfTimeString(t) {
  // Open-Meteo hourly time strings look like "2026-05-19T14:00"
  const m = /T(\d{2}):/.exec(t);
  return m ? parseInt(m[1], 10) : null;
}

function dateOfTimeString(t) {
  return t.slice(0, 10);
}

function verdictFromMetrics({ maxProb, precipSum, disagreement }) {
  if (maxProb != null && maxProb > 60) return VERDICT.HEAVY_CAUTION;
  if (precipSum != null && precipSum > 0.2) return VERDICT.HEAVY_CAUTION;
  if (maxProb != null && maxProb >= 35) return VERDICT.LIGHT_CAUTION;
  if (precipSum != null && precipSum >= 0.05) return VERDICT.LIGHT_CAUTION;
  if (disagreement) return VERDICT.LIGHT_CAUTION;
  return VERDICT.GO;
}

function windowVerdictReason({ verdict, maxProb, precipSum }) {
  const peak = Math.round(maxProb ?? 0);
  switch (verdict) {
    case VERDICT.HEAVY_CAUTION:
      if (precipSum != null && precipSum > 0.2 && (maxProb == null || maxProb <= 60)) {
        return `Strong caution: ${precipSum.toFixed(2)}" of rain expected in this window.`;
      }
      return `Strong caution: peak ${peak}% rain chance in this window.`;
    case VERDICT.LIGHT_CAUTION:
      return `Heads up: peak ${peak}% rain chance — keep an eye on the radar.`;
    case VERDICT.GO:
    default:
      return `Clear: peak ${peak}% rain chance.`;
  }
}

function dailyVerdictFromTennisStats({
  heavyHours,
  tennisPrecip,
  peakTennisProb,
  disagreementAtRiskyHour
}) {
  if (heavyHours >= NOGO_HEAVY_HOURS) {
    return {
      verdict: VERDICT.HEAVY_CAUTION,
      reason: `Strong caution: ${heavyHours} tennis hours forecast at ≥60% rain — expect interruptions.`
    };
  }
  if (tennisPrecip >= NOGO_PRECIP_IN) {
    return {
      verdict: VERDICT.HEAVY_CAUTION,
      reason: `Strong caution: ${tennisPrecip.toFixed(2)}" of rain expected through the tennis day.`
    };
  }
  if (peakTennisProb >= CAUTION_PEAK_PROB) {
    return {
      verdict: VERDICT.LIGHT_CAUTION,
      reason: `Heads up: peak ${peakTennisProb}% rain chance during tennis hours — watch the radar.`
    };
  }
  if (tennisPrecip >= CAUTION_PRECIP_IN) {
    return {
      verdict: VERDICT.LIGHT_CAUTION,
      reason: `Heads up: about ${tennisPrecip.toFixed(2)}" of rain possible during tennis hours.`
    };
  }
  if (disagreementAtRiskyHour) {
    return {
      verdict: VERDICT.LIGHT_CAUTION,
      reason: "Heads up: models disagree on storm timing — check radar 60 min before."
    };
  }
  return {
    verdict: VERDICT.GO,
    reason: `Looks good: peak ${peakTennisProb}% rain chance during tennis hours.`
  };
}

/**
 * Combine raw hourly arrays into a per-hour record with both models and a
 * consensus value. Returns the full array (today + tomorrow).
 */
function buildHourly(raw, now) {
  const h = raw.hourly || {};
  const times = h.time || [];

  const probHrrr = h[`precipitation_probability_${MODEL_HRRR}`] || [];
  const probAifs = h[`precipitation_probability_${MODEL_AIFS}`] || [];
  const precipHrrr = h[`precipitation_${MODEL_HRRR}`] || [];
  const precipAifs = h[`precipitation_${MODEL_AIFS}`] || [];
  const tempHrrr = h[`temperature_2m_${MODEL_HRRR}`] || [];
  const tempAifs = h[`temperature_2m_${MODEL_AIFS}`] || [];
  const wcodeHrrr = h[`weathercode_${MODEL_HRRR}`] || [];
  const wcodeAifs = h[`weathercode_${MODEL_AIFS}`] || [];
  const windHrrr = h[`windspeed_10m_${MODEL_HRRR}`] || [];
  const windAifs = h[`windspeed_10m_${MODEL_AIFS}`] || [];

  const todayLocal = localDateString(now);

  return times.map((t, i) => {
    const ph = num(probHrrr[i]);
    const pa = num(probAifs[i]);
    const consensusProb = Math.round(avg(ph, pa));

    const rh = num(precipHrrr[i]);
    const ra = num(precipAifs[i]);
    const consensusPrecip = avg(rh, ra);

    const th = num(tempHrrr[i]);
    const ta = num(tempAifs[i]);
    const temp = avg(th, ta);

    const wc = num(wcodeHrrr[i]) ?? num(wcodeAifs[i]);

    const wh = num(windHrrr[i]);
    const wa = num(windAifs[i]);
    const windConsensus =
      wh != null || wa != null ? avg(wh, wa) : null;

    const dateStr = dateOfTimeString(t);
    const hour = hourOfTimeString(t);

    const disagreement =
      ph != null && pa != null && Math.abs(ph - pa) > DISAGREEMENT_HOURLY_PP;

    return {
      time: t,
      hour_local: hour != null ? `${String(hour).padStart(2, "0")}:00` : null,
      _date: dateStr,
      _hour: hour,
      is_tomorrow: dateStr !== todayLocal,
      rain_probability_hrrr: ph,
      rain_probability_aifs: pa,
      rain_probability_consensus: consensusProb,
      precipitation_in_hrrr: rh,
      precipitation_in_aifs: ra,
      precipitation_in_consensus: Number(consensusPrecip.toFixed(3)),
      disagreement,
      temperature_f: temp != null ? Number(temp.toFixed(1)) : null,
      weathercode: wc,
      windspeed_10m_hrrr: wh,
      windspeed_10m_aifs: wa,
      windspeed_10m_consensus:
        windConsensus != null ? Number(windConsensus.toFixed(1)) : null
    };
  });
}

function pickDailyForDate(raw, date) {
  const d = raw.daily || {};
  const times = d.time || [];
  const idx = times.findIndex((t) => t === date);
  if (idx === -1) return null;

  const get = (base) =>
    pickFirst(d, `${base}_${MODEL_HRRR}`, `${base}_${MODEL_AIFS}`, base);

  const precipSumArr = get("precipitation_sum");
  const probMaxArr = get("precipitation_probability_max");
  const tmaxArr = get("temperature_2m_max");
  const tminArr = get("temperature_2m_min");
  const sunriseArr = get("sunrise");
  const sunsetArr = get("sunset");
  const wcArr = get("weathercode");

  return {
    date,
    precipitation_sum: num(precipSumArr?.[idx]) ?? 0,
    precipitation_probability_max: num(probMaxArr?.[idx]),
    temperature_high_f: num(tmaxArr?.[idx]),
    temperature_low_f: num(tminArr?.[idx]),
    sunrise: sunriseArr?.[idx] ?? null,
    sunset: sunsetArr?.[idx] ?? null,
    weathercode: num(wcArr?.[idx])
  };
}

function computeWindow(hoursForDay, startHour, endHour) {
  const slice = hoursForDay.filter(
    (h) => h._hour != null && h._hour >= startHour && h._hour < endHour
  );
  if (slice.length === 0) {
    return { max: 0, anyDisagree: false, sumPrecip: 0, first: null, last: null };
  }
  let max = 0;
  let anyDisagree = false;
  let sumPrecip = 0;
  for (const h of slice) {
    if (h.rain_probability_consensus > max) max = h.rain_probability_consensus;
    if (h.disagreement) anyDisagree = true;
    sumPrecip += h.precipitation_in_consensus || 0;
  }
  return {
    max,
    anyDisagree,
    sumPrecip: Number(sumPrecip.toFixed(3)),
    first: slice[0],
    last: slice[slice.length - 1]
  };
}

function formatLocalHour(isoLike) {
  // Open-Meteo returns naive local strings like "2026-05-20T08:00".
  // Parse the components and format via Intl in the configured timezone.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoLike);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  // Construct a Date treating the components as a wall-clock moment in TIMEZONE.
  // Use Date.UTC then format with timeZone — since the source is already local,
  // we want to display the same wall-clock values back out.
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
  return fmt.format(dt);
}

function pickBestWindow(windows) {
  const candidates = windows.filter((w) => !w.is_past);
  const gos = candidates.filter((w) => w.verdict === VERDICT.GO);
  if (gos.length > 0) {
    const best = gos.reduce((a, b) => (b.max_rain_prob < a.max_rain_prob ? b : a));
    return { label: best.label, max_rain_prob: best.max_rain_prob, verdict: best.verdict };
  }
  const lights = candidates.filter((w) => w.verdict === VERDICT.LIGHT_CAUTION);
  if (lights.length > 0) {
    const best = lights.reduce((a, b) => (b.max_rain_prob < a.max_rain_prob ? b : a));
    return { label: best.label, max_rain_prob: best.max_rain_prob, verdict: best.verdict };
  }
  return null;
}

function computeConfidence(tennisHours) {
  const diffs = [];
  for (const h of tennisHours) {
    if (h.rain_probability_hrrr != null && h.rain_probability_aifs != null) {
      diffs.push(Math.abs(h.rain_probability_hrrr - h.rain_probability_aifs));
    }
  }
  if (diffs.length === 0) {
    return {
      confidence: "LOW",
      confidence_note: "Only one model available — forecast uncertainty is higher."
    };
  }
  const meanAbsDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const rounded = Math.round(meanAbsDiff);
  if (meanAbsDiff < CONFIDENCE_HIGH_MAX_DIFF) {
    return {
      confidence: "HIGH",
      confidence_note: `Both models agree within ${rounded} pts on average.`
    };
  }
  if (meanAbsDiff < CONFIDENCE_MODERATE_MAX_DIFF) {
    return {
      confidence: "MODERATE",
      confidence_note: `Models differ by ${rounded} pts on average — moderate uncertainty.`
    };
  }
  return {
    confidence: "LOW",
    confidence_note: `Models differ by ${rounded} pts on average — forecast uncertain.`
  };
}

function buildTennisWindows(hoursForDay, isPastFn) {
  return TENNIS_WINDOWS.map(({ label, startHour, endHour }) => {
    const stats = computeWindow(hoursForDay, startHour, endHour);
    const wVerdict = verdictFromMetrics({
      maxProb: stats.max,
      precipSum: stats.sumPrecip,
      disagreement: stats.anyDisagree
    });
    return {
      label,
      start: stats.first?.time ?? null,
      end: stats.last?.time ?? null,
      verdict: wVerdict,
      max_rain_prob: Math.round(stats.max),
      reason: windowVerdictReason({
        verdict: wVerdict,
        maxProb: stats.max,
        precipSum: stats.sumPrecip
      }),
      is_past: isPastFn({ startHour, endHour })
    };
  });
}

/**
 * Build a single day object (today or tomorrow) from filtered hourly data.
 * `tennisHours` is the filter slice used for verdict math; for today it can
 * be partial (only remaining hours), for tomorrow it is the full 06-21 set.
 */
function buildDay({
  label,
  date,
  tennisHours,
  dailyDataForDate,
  tennisWindows,
  models
}) {
  let maxConsensus = 0;
  let meanConsensus = 0;
  let heavyHours = 0;
  let tennisPrecip = 0;
  let anyHourlyDisagree = false;
  let disagreementAtRiskyHour = false;
  let peakDiff = 0;
  let windMax = null;
  let windSum = 0;
  let windCount = 0;
  let firstRainHour = null;

  for (const h of tennisHours) {
    const prob = h.rain_probability_consensus;
    if (prob > maxConsensus) maxConsensus = prob;
    meanConsensus += prob;
    if (prob >= NOGO_HEAVY_PROB) heavyHours += 1;
    tennisPrecip += h.precipitation_in_consensus || 0;
    if (h.disagreement) {
      anyHourlyDisagree = true;
      if (prob >= CAUTION_DISAGREEMENT_PROB) disagreementAtRiskyHour = true;
    }
    if (h.rain_probability_hrrr != null && h.rain_probability_aifs != null) {
      const diff = Math.abs(h.rain_probability_hrrr - h.rain_probability_aifs);
      if (diff > peakDiff) peakDiff = diff;
    }
    if (h.windspeed_10m_consensus != null) {
      if (windMax == null || h.windspeed_10m_consensus > windMax) {
        windMax = h.windspeed_10m_consensus;
      }
      windSum += h.windspeed_10m_consensus;
      windCount += 1;
    }
    if (firstRainHour == null && prob >= FIRST_RAIN_THRESHOLD) {
      firstRainHour = h;
    }
  }
  meanConsensus = tennisHours.length ? Math.round(meanConsensus / tennisHours.length) : 0;
  tennisPrecip = Number(tennisPrecip.toFixed(3));

  const wind_max_mph = windMax != null ? Math.round(windMax) : null;
  const wind_mean_mph = windCount > 0 ? Math.round(windSum / windCount) : null;
  const first_rain_time = firstRainHour ? firstRainHour.time : null;
  const first_rain_hour_local = firstRainHour ? formatLocalHour(firstRainHour.time) : null;

  const modelAgreement = anyHourlyDisagree ? "DISAGREE" : "AGREE";

  const precipSum = dailyDataForDate?.precipitation_sum ?? 0;
  const { verdict, reason } = dailyVerdictFromTennisStats({
    heavyHours,
    tennisPrecip,
    peakTennisProb: maxConsensus,
    disagreementAtRiskyHour
  });

  const onlyOne =
    (models.hrrr.available && !models.aifs.available) ||
    (!models.hrrr.available && models.aifs.available);
  const uncertainty_note = onlyOne
    ? `Only one model available (${models.hrrr.available ? "HRRR" : "AIFS"}); consensus reflects a single source.`
    : null;

  const best_window = pickBestWindow(tennisWindows);
  const { confidence, confidence_note } = computeConfidence(tennisHours);

  return {
    date,
    label,
    is_concluded: false,
    verdict,
    verdict_reason: reason,
    rain_probability_max: Math.round(maxConsensus),
    rain_probability_mean: meanConsensus,
    precipitation_sum_in: Number(precipSum.toFixed(3)),
    temperature_high_f: dailyDataForDate?.temperature_high_f ?? null,
    temperature_low_f: dailyDataForDate?.temperature_low_f ?? null,
    sunrise: dailyDataForDate?.sunrise ?? null,
    sunset: dailyDataForDate?.sunset ?? null,
    model_agreement: modelAgreement,
    uncertainty_note,
    wind_max_mph,
    wind_mean_mph,
    first_rain_time,
    first_rain_hour_local,
    best_window,
    confidence,
    confidence_note,
    tennis_windows: tennisWindows
  };
}

function buildConcludedDay({ date, dailyDataForDate, tennisWindows }) {
  const precipSum = dailyDataForDate?.precipitation_sum ?? 0;
  return {
    date,
    label: "today",
    is_concluded: true,
    tennis_hours_remaining: 0,
    verdict: null,
    verdict_reason: "Tennis day complete — check Tomorrow for the next forecast.",
    rain_probability_max: null,
    rain_probability_mean: null,
    precipitation_sum_in: Number(precipSum.toFixed(3)),
    temperature_high_f: dailyDataForDate?.temperature_high_f ?? null,
    temperature_low_f: dailyDataForDate?.temperature_low_f ?? null,
    sunrise: dailyDataForDate?.sunrise ?? null,
    sunset: dailyDataForDate?.sunset ?? null,
    model_agreement: "AGREE",
    uncertainty_note: null,
    wind_max_mph: null,
    wind_mean_mph: null,
    first_rain_time: null,
    first_rain_hour_local: null,
    best_window: null,
    confidence: null,
    confidence_note: "Tennis day complete.",
    tennis_windows: tennisWindows.map((w) => ({ ...w, is_past: true }))
  };
}

export function buildForecast({ data, cached, models }, { now } = {}) {
  const nowDate = now instanceof Date ? now : new Date();
  const hourly = buildHourly(data, nowDate);

  const todayLocal = localDateString(nowDate);
  const currentHour = localHour(nowDate);

  // Determine today's and tomorrow's date strings from the hourly data.
  const dateSet = [...new Set(hourly.map((h) => h._date))];
  const todayDate = dateSet.includes(todayLocal) ? todayLocal : dateSet[0];
  const tomorrowDate = dateSet.find((d) => d !== todayDate) ?? null;

  const todayHours = hourly.filter((h) => h._date === todayDate);
  const tomorrowHours = tomorrowDate
    ? hourly.filter((h) => h._date === tomorrowDate)
    : [];

  const todayDaily = pickDailyForDate(data, todayDate);
  const tomorrowDaily = tomorrowDate ? pickDailyForDate(data, tomorrowDate) : null;

  // -------- TOMORROW (always full 06-21) --------
  const tomorrowTennisHours = tomorrowHours.filter(
    (h) =>
      h.is_tomorrow === true &&
      h._hour != null &&
      h._hour >= TENNIS_DAY_START_HOUR &&
      h._hour <= TENNIS_DAY_END_HOUR
  );
  const tomorrowWindows = buildTennisWindows(tomorrowHours, () => false);
  const tomorrow = tomorrowDate
    ? buildDay({
        label: "tomorrow",
        date: tomorrowDate,
        tennisHours: tomorrowTennisHours,
        dailyDataForDate: tomorrowDaily,
        tennisWindows: tomorrowWindows,
        models
      })
    : null;

  // -------- TODAY (now-relative; may be partial or concluded) --------
  const todayConcluded = currentHour >= TENNIS_DAY_END_HOUR;
  const todayWindows = buildTennisWindows(todayHours, ({ endHour }) =>
    endHour <= currentHour
  );

  let today;
  if (todayConcluded) {
    today = buildConcludedDay({
      date: todayDate,
      dailyDataForDate: todayDaily,
      tennisWindows: todayWindows
    });
  } else {
    // Floor to the start of the current local hour. If now is before 6am,
    // include the full 06-21 set; otherwise include hours [currentHour, 21].
    const minHour = Math.max(TENNIS_DAY_START_HOUR, currentHour);
    const todayTennisHours = todayHours.filter(
      (h) =>
        h.is_tomorrow === false &&
        h._hour != null &&
        h._hour >= minHour &&
        h._hour <= TENNIS_DAY_END_HOUR
    );
    today = buildDay({
      label: "today",
      date: todayDate,
      tennisHours: todayTennisHours,
      dailyDataForDate: todayDaily,
      tennisWindows: todayWindows,
      models
    });
    today.tennis_hours_remaining = todayTennisHours.length;
  }

  // Strip internal helper fields before returning.
  const cleanHourly = hourly.map(({ _date, _hour, ...rest }) => rest);

  return {
    location: {
      name: LOCATION_NAME,
      lat: LATITUDE,
      lon: LONGITUDE,
      timezone: TIMEZONE
    },
    generated_at: nowDate.toISOString(),
    cached: Boolean(cached),
    today,
    tomorrow,
    hourly: cleanHourly,
    models: {
      hrrr: { available: models.hrrr.available, id: models.hrrr.id },
      aifs: { available: models.aifs.available, id: models.aifs.id }
    }
  };
}
