import {
  LATITUDE,
  LONGITUDE,
  TIMEZONE,
  CACHE_TTL_MS,
  MODEL_HRRR,
  MODEL_AIFS,
  OPEN_METEO_URL
} from "./config.js";
import { TtlCache } from "./cache.js";

const cache = new TtlCache(CACHE_TTL_MS);
const CACHE_KEY = "forecast";

const HOURLY_VARS = [
  "precipitation",
  "precipitation_probability",
  "temperature_2m",
  "weathercode",
  "cloudcover",
  "windspeed_10m"
];

const DAILY_VARS = [
  "precipitation_sum",
  "precipitation_probability_max",
  "weathercode",
  "temperature_2m_max",
  "temperature_2m_min",
  "sunrise",
  "sunset"
];

function buildUrl(models) {
  const params = new URLSearchParams({
    latitude: String(LATITUDE),
    longitude: String(LONGITUDE),
    models: Array.isArray(models) ? models.join(",") : models,
    hourly: HOURLY_VARS.join(","),
    daily: DAILY_VARS.join(","),
    temperature_unit: "fahrenheit",
    windspeed_unit: "mph",
    precipitation_unit: "inch",
    timezone: TIMEZONE,
    forecast_days: "2"
  });
  return `${OPEN_METEO_URL}?${params.toString()}`;
}

async function fetchModel(modelId) {
  const url = buildUrl([modelId]);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Open-Meteo ${modelId} request failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchCombined() {
  const url = buildUrl([MODEL_HRRR, MODEL_AIFS]);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Open-Meteo combined request failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Returns { data, cached, models: { hrrr: { available, id, error? }, aifs: { ... } } }
 * Strategy: try the combined request first (one HTTP call). If it fails, fall
 * back to per-model requests so a single bad model doesn't kill the response.
 */
export async function fetchForecast() {
  const cached = cache.get(CACHE_KEY);
  if (cached) {
    return { ...cached, cached: true };
  }

  const modelsMeta = {
    hrrr: { available: false, id: MODEL_HRRR },
    aifs: { available: false, id: MODEL_AIFS }
  };

  let combined = null;
  try {
    combined = await fetchCombined();
    modelsMeta.hrrr.available = true;
    modelsMeta.aifs.available = true;
  } catch (combinedErr) {
    const [hrrrResult, aifsResult] = await Promise.allSettled([
      fetchModel(MODEL_HRRR),
      fetchModel(MODEL_AIFS)
    ]);

    const merged = { hourly: {}, hourly_units: {}, daily: {}, daily_units: {} };

    if (hrrrResult.status === "fulfilled") {
      modelsMeta.hrrr.available = true;
      mergeModelResponse(merged, hrrrResult.value, MODEL_HRRR);
    } else {
      modelsMeta.hrrr.error = String(hrrrResult.reason?.message || hrrrResult.reason);
    }

    if (aifsResult.status === "fulfilled") {
      modelsMeta.aifs.available = true;
      mergeModelResponse(merged, aifsResult.value, MODEL_AIFS);
    } else {
      modelsMeta.aifs.error = String(aifsResult.reason?.message || aifsResult.reason);
    }

    if (!modelsMeta.hrrr.available && !modelsMeta.aifs.available) {
      throw new Error(`All models failed. Combined error: ${combinedErr.message}`);
    }

    combined = merged;
  }

  const payload = { data: combined, models: modelsMeta };
  cache.set(CACHE_KEY, payload);
  return { ...payload, cached: false };
}

/**
 * When we fall back to per-model requests, each response has bare variable
 * names (e.g. `precipitation`). Re-key them with the model suffix so the rest
 * of the pipeline sees the same shape as the combined response.
 */
function mergeModelResponse(target, source, modelId) {
  for (const key of ["latitude", "longitude", "timezone", "timezone_abbreviation", "utc_offset_seconds", "elevation", "generationtime_ms"]) {
    if (source[key] !== undefined && target[key] === undefined) {
      target[key] = source[key];
    }
  }

  if (source.hourly) {
    if (!target.hourly.time && source.hourly.time) {
      target.hourly.time = source.hourly.time;
    }
    for (const [name, values] of Object.entries(source.hourly)) {
      if (name === "time") continue;
      target.hourly[`${name}_${modelId}`] = values;
    }
  }

  if (source.hourly_units) {
    for (const [name, unit] of Object.entries(source.hourly_units)) {
      if (name === "time") continue;
      target.hourly_units[`${name}_${modelId}`] = unit;
    }
  }

  if (source.daily) {
    if (!target.daily.time && source.daily.time) {
      target.daily.time = source.daily.time;
    }
    for (const [name, values] of Object.entries(source.daily)) {
      if (name === "time") continue;
      target.daily[`${name}_${modelId}`] = values;
    }
  }

  if (source.daily_units) {
    for (const [name, unit] of Object.entries(source.daily_units)) {
      if (name === "time") continue;
      target.daily_units[`${name}_${modelId}`] = unit;
    }
  }
}

export function _clearCache() {
  cache.clear();
}
