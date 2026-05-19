// Tests for fetchForecast — the upstream Open-Meteo client.
//
// The bug we're reproducing: when the combined request `models=gfs_hrrr,
// ecmwf_aifs025` returns successfully but the response body only contains
// HRRR-suffixed variables (no AIFS keys at all), the original code blindly
// marked both models as available. Downstream, the hourly array had null
// AIFS probabilities, the chart rendered an empty magenta line, and the user
// saw "Both models" branding with only one model of actual data.
//
// These tests use a fetch shim (global fetch override) so they run hermetic.
// Run: npm test

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchForecast, _clearCache } from "../lib/openMeteo.js";
import { MODEL_HRRR, MODEL_AIFS } from "../lib/config.js";

// --- fetch shim ---------------------------------------------------------
const realFetch = globalThis.fetch;
let nextResponses = []; // FIFO of { ok, status, body } per fetch() call
let calls = [];         // record of URLs called

function setFetchQueue(responses) {
  nextResponses = [...responses];
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (!nextResponses.length) {
      throw new Error(`Test fetch underflow: no response queued for ${url}`);
    }
    const r = nextResponses.shift();
    return {
      ok: r.ok,
      status: r.status,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      json: async () => (typeof r.body === "string" ? JSON.parse(r.body) : r.body)
    };
  };
}

beforeEach(() => {
  _clearCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  nextResponses = [];
  calls = [];
});

// --- canned response builders ------------------------------------------
function hourlyTime(n = 4) {
  const base = new Date("2026-05-19T00:00:00").getTime();
  return Array.from({ length: n }, (_, i) =>
    new Date(base + i * 3600000).toISOString().slice(0, 16)
  );
}

function bothModelsResponse() {
  const time = hourlyTime(4);
  return {
    hourly: {
      time,
      [`precipitation_${MODEL_HRRR}`]: [0, 0, 0.05, 0.1],
      [`precipitation_probability_${MODEL_HRRR}`]: [10, 15, 60, 80],
      [`precipitation_${MODEL_AIFS}`]: [0, 0, 0.02, 0.08],
      [`precipitation_probability_${MODEL_AIFS}`]: [12, 18, 55, 75],
      [`temperature_2m_${MODEL_HRRR}`]: [70, 71, 72, 73],
      [`temperature_2m_${MODEL_AIFS}`]: [70, 71, 72, 73],
      [`weathercode_${MODEL_HRRR}`]: [0, 1, 61, 65],
      [`weathercode_${MODEL_AIFS}`]: [0, 1, 61, 65],
      [`windspeed_10m_${MODEL_HRRR}`]: [5, 6, 8, 9],
      [`windspeed_10m_${MODEL_AIFS}`]: [5, 6, 8, 9],
      [`wind_gusts_10m_${MODEL_HRRR}`]: [10, 12, 15, 17],
      [`wind_gusts_10m_${MODEL_AIFS}`]: [10, 12, 15, 17]
    },
    daily: { time: ["2026-05-19"] }
  };
}

// This is the bug scenario: combined request returns ONLY HRRR keys.
function hrrrOnlyCombinedResponse() {
  const time = hourlyTime(4);
  return {
    hourly: {
      time,
      [`precipitation_${MODEL_HRRR}`]: [0, 0, 0.05, 0.1],
      [`precipitation_probability_${MODEL_HRRR}`]: [10, 15, 60, 80],
      [`temperature_2m_${MODEL_HRRR}`]: [70, 71, 72, 73],
      [`weathercode_${MODEL_HRRR}`]: [0, 1, 61, 65],
      [`windspeed_10m_${MODEL_HRRR}`]: [5, 6, 8, 9],
      [`wind_gusts_10m_${MODEL_HRRR}`]: [10, 12, 15, 17]
    },
    daily: { time: ["2026-05-19"] }
  };
}

// AIFS single-model response (bare keys, no suffix).
function aifsSingleModelResponse() {
  const time = hourlyTime(4);
  return {
    hourly: {
      time,
      precipitation: [0, 0, 0.02, 0.08],
      precipitation_probability: [12, 18, 55, 75],
      temperature_2m: [70, 71, 72, 73],
      weathercode: [0, 1, 61, 65],
      windspeed_10m: [5, 6, 8, 9],
      wind_gusts_10m: [10, 12, 15, 17]
    },
    daily: { time: ["2026-05-19"] }
  };
}

// --- tests --------------------------------------------------------------

test("combined response with both models → both marked available, AIFS data present", async () => {
  setFetchQueue([{ ok: true, status: 200, body: bothModelsResponse() }]);

  const { data, models } = await fetchForecast();

  assert.equal(models.hrrr.available, true);
  assert.equal(models.aifs.available, true);

  // Verify AIFS variables made it through under their suffixed keys.
  assert.ok(
    Array.isArray(data.hourly[`precipitation_probability_${MODEL_AIFS}`]),
    "expected AIFS probability array on combined response"
  );
  assert.deepEqual(
    data.hourly[`precipitation_probability_${MODEL_AIFS}`],
    [12, 18, 55, 75]
  );
});

test("BUG REPRO: combined response has only HRRR variables → must NOT mark AIFS available, must attempt per-model fallback", async () => {
  // First call: combined request returns success but only HRRR keys.
  // Second call (the fix): per-model AIFS fetch.
  setFetchQueue([
    { ok: true, status: 200, body: hrrrOnlyCombinedResponse() },
    { ok: true, status: 200, body: aifsSingleModelResponse() }
  ]);

  const { data, models } = await fetchForecast();

  // The fix's contract:
  assert.equal(models.hrrr.available, true, "HRRR must remain available");
  assert.equal(
    models.aifs.available,
    true,
    "AIFS must be marked available AFTER per-model fallback re-fetches it"
  );

  // The fallback path keys per-model bare variables with the model suffix
  // so the rest of the pipeline sees the same shape as a combined response.
  assert.ok(
    Array.isArray(data.hourly[`precipitation_probability_${MODEL_AIFS}`]),
    "AIFS probability array must exist after fallback merge"
  );
  assert.deepEqual(
    data.hourly[`precipitation_probability_${MODEL_AIFS}`],
    [12, 18, 55, 75]
  );

  // The fix must have made the fallback call.
  assert.equal(calls.length, 2, "expected combined + per-model AIFS fetch");
  assert.ok(
    calls[1].includes(`models=${MODEL_AIFS}`),
    `second call should be the per-model AIFS fetch — saw: ${calls[1]}`
  );
});

test("combined OK + HRRR-only, AND per-model AIFS fallback also fails → AIFS marked unavailable, HRRR-only mode", async () => {
  setFetchQueue([
    { ok: true, status: 200, body: hrrrOnlyCombinedResponse() },
    { ok: false, status: 503, body: "AIFS upstream down" }
  ]);

  const { data, models } = await fetchForecast();

  assert.equal(models.hrrr.available, true);
  assert.equal(
    models.aifs.available,
    false,
    "AIFS must be marked unavailable when both combined and per-model fail to surface it"
  );
  assert.ok(
    models.aifs.error,
    "AIFS error message should be populated for debugging"
  );

  // HRRR data must still be intact.
  assert.deepEqual(
    data.hourly[`precipitation_probability_${MODEL_HRRR}`],
    [10, 15, 60, 80]
  );
});

test("combined request fails entirely → per-model fallback for both models", async () => {
  setFetchQueue([
    { ok: false, status: 500, body: "Combined upstream error" },
    {
      ok: true,
      status: 200,
      body: {
        hourly: {
          time: hourlyTime(2),
          precipitation: [0, 0.05],
          precipitation_probability: [10, 60],
          temperature_2m: [70, 72],
          weathercode: [0, 61],
          windspeed_10m: [5, 8],
          wind_gusts_10m: [10, 15]
        },
        daily: { time: ["2026-05-19"] }
      }
    },
    {
      ok: true,
      status: 200,
      body: aifsSingleModelResponse()
    }
  ]);

  const { models } = await fetchForecast();
  assert.equal(models.hrrr.available, true);
  assert.equal(models.aifs.available, true);
});

test("combined fails + both per-model fail → throws", async () => {
  setFetchQueue([
    { ok: false, status: 500, body: "combined fail" },
    { ok: false, status: 500, body: "hrrr fail" },
    { ok: false, status: 500, body: "aifs fail" }
  ]);

  await assert.rejects(() => fetchForecast(), /All models failed/);
});
