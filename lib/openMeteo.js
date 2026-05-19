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
  "windspeed_10m",
  // Wind gusts matter more for tennis disruption than sustained wind:
  // a 12 mph mean with 28 mph gusts kills ball-toss and lobs even though
  // the sustained reading looks fine. HRRR (NOAA GRIB GUST field) and
  // ECMWF AIFS both expose wind_gusts_10m on Open-Meteo, so it round-trips
  // through the same consensus pipeline as windspeed_10m.
  "wind_gusts_10m"
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
 * Returns whether a model's variables actually appear in a response payload.
 * A combined request can return HTTP 200 yet only include variables for one
 * of the requested models (real observed behavior with `ecmwf_aifs025` in
 * the combined `gfs_hrrr,ecmwf_aifs025` call). Treat that case as "model
 * not available from combined" so the caller can retry per-model.
 */
function hasModelData(response, modelId) {
  if (!response || !response.hourly) return false;
  const suffix = `_${modelId}`;
  for (const key of Object.keys(response.hourly)) {
    if (key !== "time" && key.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Returns { data, cached, models: { hrrr: { available, id, error? }, aifs: { ... } } }
 *
 * Strategy:
 *   1. Try the combined request (one HTTP call).
 *   2. Verify each requested model actually appears in the response — Open-Meteo
 *      sometimes returns 200 OK while silently dropping AIFS variables, which
 *      previously caused the UI to show an empty AIFS chart line. For any
 *      model that's missing from the combined response, fire a per-model
 *      fetch and merge it in.
 *   3. If the combined request itself fails, fall back to per-model requests
 *      for both models so a single bad model doesn't kill the response.
 *
 * Options:
 *   - bypassCache: skip cache read; still writes the fresh result to cache.
 */
export async function fetchForecast({ bypassCache = false } = {}) {
  if (!bypassCache) {
    const cached = cache.get(CACHE_KEY);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const modelsMeta = {
    hrrr: { available: false, id: MODEL_HRRR },
    aifs: { available: false, id: MODEL_AIFS }
  };

  let combined = null;
  let combinedSucceeded = false;
  try {
    combined = await fetchCombined();
    combinedSucceeded = true;
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

  if (combinedSucceeded) {
    // Mark availability based on actual data presence, not on HTTP success.
    modelsMeta.hrrr.available = hasModelData(combined, MODEL_HRRR);
    modelsMeta.aifs.available = hasModelData(combined, MODEL_AIFS);

    // Repair: for any requested model the combined call dropped, retry it
    // alone. This recovers the AIFS line in the common Open-Meteo case where
    // the combined response is 200 OK with HRRR-only variables.
    const missingModels = [];
    if (!modelsMeta.hrrr.available) missingModels.push({ id: MODEL_HRRR, meta: modelsMeta.hrrr });
    if (!modelsMeta.aifs.available) missingModels.push({ id: MODEL_AIFS, meta: modelsMeta.aifs });

    if (missingModels.length) {
      const retries = await Promise.allSettled(
        missingModels.map(({ id }) => fetchModel(id))
      );
      retries.forEach((res, i) => {
        const { id, meta } = missingModels[i];
        if (res.status === "fulfilled") {
          mergeModelResponse(combined, res.value, id);
          meta.available = true;
        } else {
          meta.error = String(res.reason?.message || res.reason);
        }
      });
    }
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
