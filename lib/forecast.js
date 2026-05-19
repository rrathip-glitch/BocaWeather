import {
  LATITUDE,
  LONGITUDE,
  LOCATION_NAME,
  TIMEZONE,
  MODEL_HRRR,
  MODEL_AIFS,
  TENNIS_WINDOWS
} from "./config.js";

const DISAGREEMENT_HOURLY_PP = 25;
const DISAGREEMENT_DAILY_PP = 30;

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

function hourOfTimeString(t) {
  // Open-Meteo hourly time strings look like "2026-05-19T14:00"
  const m = /T(\d{2}):/.exec(t);
  return m ? parseInt(m[1], 10) : null;
}

function dateOfTimeString(t) {
  return t.slice(0, 10);
}

function verdictFromMetrics({ maxProb, precipSum, disagreement }) {
  if (maxProb != null && maxProb > 60) return "NO_GO";
  if (precipSum != null && precipSum > 0.2) return "NO_GO";
  if (maxProb != null && maxProb >= 35) return "CAUTION";
  if (precipSum != null && precipSum >= 0.05) return "CAUTION";
  if (disagreement) return "CAUTION";
  return "GO";
}

function verdictReason({ verdict, maxProb, precipSum, disagreement }) {
  const parts = [];
  if (maxProb != null) parts.push(`peak rain chance ${Math.round(maxProb)}%`);
  if (precipSum != null) parts.push(`expected ${precipSum.toFixed(2)}" of rain`);
  if (disagreement) parts.push("models disagree on timing/intensity");

  const base = parts.length ? parts.join(", ") : "no significant precipitation expected";

  switch (verdict) {
    case "NO_GO":
      return `Skip it: ${base}.`;
    case "CAUTION":
      return `Play with a backup plan: ${base}.`;
    case "GO":
    default:
      return `Good to play: ${base}.`;
  }
}

/**
 * Combine raw hourly arrays into a per-hour record with both models and a
 * consensus value. Returns the full array (today + tomorrow).
 */
function buildHourly(raw) {
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

  const todayLocal = localDateString(new Date());

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
      weathercode: wc
    };
  });
}

function pickTomorrowDaily(raw) {
  const d = raw.daily || {};
  const times = d.time || [];
  const todayLocal = localDateString(new Date());
  let idx = times.findIndex((t) => t !== todayLocal);
  if (idx === -1) idx = times.length - 1;
  if (idx < 0) return null;

  const get = (base) =>
    pickFirst(d, `${base}_${MODEL_HRRR}`, `${base}_${MODEL_AIFS}`, base);

  const date = times[idx];
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

function computeWindow(hoursForTomorrow, startHour, endHour) {
  const slice = hoursForTomorrow.filter(
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

function windowVerdictReason(label, stats) {
  return `${label}: peak ${Math.round(stats.max)}% rain chance, ~${stats.sumPrecip.toFixed(2)}" expected${stats.anyDisagree ? ", models disagree" : ""}.`;
}

export function buildForecast({ data, cached, models }) {
  const hourly = buildHourly(data);
  const tomorrowDaily = pickTomorrowDaily(data);
  const tomorrowDate = tomorrowDaily?.date;

  const tomorrowHours = hourly.filter((h) => h._date === tomorrowDate);

  // Daytime (8am-8pm) used for daily verdict & overall model agreement.
  const daytime = tomorrowHours.filter(
    (h) => h._hour != null && h._hour >= 8 && h._hour < 20
  );

  let maxConsensus = 0;
  let meanConsensus = 0;
  let anyHourlyDisagree = false;
  let peakDiff = 0;
  for (const h of daytime) {
    if (h.rain_probability_consensus > maxConsensus) maxConsensus = h.rain_probability_consensus;
    meanConsensus += h.rain_probability_consensus;
    if (h.disagreement) anyHourlyDisagree = true;
    if (h.rain_probability_hrrr != null && h.rain_probability_aifs != null) {
      const diff = Math.abs(h.rain_probability_hrrr - h.rain_probability_aifs);
      if (diff > peakDiff) peakDiff = diff;
    }
  }
  meanConsensus = daytime.length ? Math.round(meanConsensus / daytime.length) : 0;

  const modelAgreement = anyHourlyDisagree ? "DISAGREE" : "AGREE";
  const dailyDisagreement = peakDiff > DISAGREEMENT_DAILY_PP;

  const precipSum = tomorrowDaily?.precipitation_sum ?? 0;
  const verdict = verdictFromMetrics({
    maxProb: maxConsensus,
    precipSum,
    disagreement: dailyDisagreement
  });
  const reason = verdictReason({
    verdict,
    maxProb: maxConsensus,
    precipSum,
    disagreement: dailyDisagreement
  });

  const onlyOne =
    (models.hrrr.available && !models.aifs.available) ||
    (!models.hrrr.available && models.aifs.available);
  const uncertainty_note = onlyOne
    ? `Only one model available (${models.hrrr.available ? "HRRR" : "AIFS"}); consensus reflects a single source.`
    : null;

  const tennis_windows = TENNIS_WINDOWS.map(({ label, startHour, endHour }) => {
    const stats = computeWindow(tomorrowHours, startHour, endHour);
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
      reason: windowVerdictReason(label, stats)
    };
  });

  // Strip internal helper fields before returning.
  const cleanHourly = hourly.map(({ _date, _hour, ...rest }) => rest);

  return {
    location: {
      name: LOCATION_NAME,
      lat: LATITUDE,
      lon: LONGITUDE,
      timezone: TIMEZONE
    },
    generated_at: new Date().toISOString(),
    cached: Boolean(cached),
    tomorrow: {
      date: tomorrowDate,
      verdict,
      verdict_reason: reason,
      rain_probability_max: Math.round(maxConsensus),
      rain_probability_mean: meanConsensus,
      precipitation_sum_in: Number(precipSum.toFixed(3)),
      temperature_high_f: tomorrowDaily?.temperature_high_f ?? null,
      temperature_low_f: tomorrowDaily?.temperature_low_f ?? null,
      sunrise: tomorrowDaily?.sunrise ?? null,
      sunset: tomorrowDaily?.sunset ?? null,
      model_agreement: modelAgreement,
      uncertainty_note
    },
    hourly: cleanHourly,
    models: {
      hrrr: { available: models.hrrr.available, id: models.hrrr.id },
      aifs: { available: models.aifs.available, id: models.aifs.id }
    },
    tennis_windows
  };
}
