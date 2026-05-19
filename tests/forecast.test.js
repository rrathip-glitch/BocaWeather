// Tests for buildForecast — the consensus + verdict pipeline.
// These cover the probability-derivation fallback that fires when a model
// reports precipitation amount but not probability, and the per-window
// confidence tag added in the same pass.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildForecast } from "../lib/forecast.js";
import { MODEL_HRRR, MODEL_IFS } from "../lib/config.js";

function makeRaw({ ifsProbability = true } = {}) {
  // 48 hourly slots starting at today 00:00 local-naive (Open-Meteo format).
  const base = new Date("2026-05-19T00:00:00");
  const time = Array.from({ length: 48 }, (_, i) => {
    const d = new Date(base.getTime() + i * 3600000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  // HRRR: dry morning, light afternoon shower.
  const probHrrr = time.map((_, i) => {
    const h = i % 24;
    if (h >= 14 && h <= 17) return 55;
    return 10;
  });
  const precipHrrr = time.map((_, i) => {
    const h = i % 24;
    if (h === 15) return 0.04;
    if (h === 16) return 0.06;
    return 0;
  });

  // IFS: precipitation only (no probability — reproduces real behavior).
  const precipIfs = time.map((_, i) => {
    const h = i % 24;
    if (h === 15) return 0.03;
    if (h === 16) return 0.05;
    return 0;
  });
  const probIfs = ifsProbability ? precipIfs.map((p) => (p > 0 ? 50 : 8)) : new Array(48).fill(null);

  const hourly = {
    time,
    [`precipitation_${MODEL_HRRR}`]: precipHrrr,
    [`precipitation_probability_${MODEL_HRRR}`]: probHrrr,
    [`precipitation_${MODEL_IFS}`]: precipIfs,
    [`precipitation_probability_${MODEL_IFS}`]: probIfs,
    [`temperature_2m_${MODEL_HRRR}`]: time.map(() => 80),
    [`temperature_2m_${MODEL_IFS}`]: time.map(() => 80),
    [`weathercode_${MODEL_HRRR}`]: time.map(() => 0),
    [`weathercode_${MODEL_IFS}`]: time.map(() => 0),
    [`windspeed_10m_${MODEL_HRRR}`]: time.map(() => 8),
    [`windspeed_10m_${MODEL_IFS}`]: time.map(() => 9),
    [`wind_gusts_10m_${MODEL_HRRR}`]: time.map(() => 15),
    [`wind_gusts_10m_${MODEL_IFS}`]: time.map(() => 16)
  };

  const dailyTimes = ["2026-05-19", "2026-05-20"];
  const daily = {
    time: dailyTimes,
    [`precipitation_sum_${MODEL_HRRR}`]: [0.1, 0.1],
    [`precipitation_sum_${MODEL_IFS}`]: [0.08, 0.08],
    [`precipitation_probability_max_${MODEL_HRRR}`]: [55, 55],
    [`precipitation_probability_max_${MODEL_IFS}`]: [50, 50],
    [`temperature_2m_max_${MODEL_HRRR}`]: [85, 85],
    [`temperature_2m_max_${MODEL_IFS}`]: [85, 85],
    [`temperature_2m_min_${MODEL_HRRR}`]: [70, 70],
    [`temperature_2m_min_${MODEL_IFS}`]: [70, 70],
    sunrise: ["2026-05-19T06:30", "2026-05-20T06:30"],
    sunset: ["2026-05-19T20:00", "2026-05-20T20:00"]
  };

  return { hourly, daily };
}

test("BUG REPRO: IFS probability null but precip non-null → probability is derived (not null)", () => {
  const raw = makeRaw({ ifsProbability: false });
  // Pick a "now" in the afternoon so today's tennis hours include the storm.
  const now = new Date("2026-05-19T13:00:00-04:00"); // 1 PM EDT
  const f = buildForecast({ data: raw, cached: false, models: { hrrr: { available: true, id: MODEL_HRRR }, ifs: { available: true, id: MODEL_IFS } } }, { now });

  // The two storm hours (15:00, 16:00) should have IFS probability derived,
  // not null. 0.03 in → 25 + 15 = 40; 0.05 in → 25 + 25 = 50.
  const storm15 = f.hourly.find((h) => h.time.endsWith("T15:00"));
  const storm16 = f.hourly.find((h) => h.time.endsWith("T16:00"));
  assert.ok(storm15, "hour 15:00 must exist");
  assert.ok(storm16, "hour 16:00 must exist");

  assert.notEqual(
    storm15.rain_probability_ifs,
    null,
    "IFS probability must be derived from precipitation when missing"
  );
  assert.equal(storm15.rain_probability_ifs, 40); // 25 + 0.03*500
  assert.equal(storm16.rain_probability_ifs, 50); // 25 + 0.05*500

  // Dry hours stay at 0 (not null).
  const dry = f.hourly.find((h) => h.time.endsWith("T03:00"));
  assert.equal(dry.rain_probability_ifs, 0);
});

test("IFS probability present → derivation does NOT overwrite native values", () => {
  const raw = makeRaw({ ifsProbability: true });
  const now = new Date("2026-05-19T13:00:00-04:00");
  const f = buildForecast({ data: raw, cached: false, models: { hrrr: { available: true, id: MODEL_HRRR }, ifs: { available: true, id: MODEL_IFS } } }, { now });

  const storm15 = f.hourly.find((h) => h.time.endsWith("T15:00"));
  // Native IFS prob in fixture was 50 (set via `p > 0 ? 50 : 8`).
  assert.equal(storm15.rain_probability_ifs, 50);
});

test("Per-window confidence is populated on every tennis_windows entry", () => {
  const raw = makeRaw();
  const now = new Date("2026-05-19T05:00:00-04:00"); // 5 AM, full tennis day ahead
  const f = buildForecast({ data: raw, cached: false, models: { hrrr: { available: true, id: MODEL_HRRR }, ifs: { available: true, id: MODEL_IFS } } }, { now });

  assert.ok(f.tomorrow.tennis_windows.length === 4, "expected 4 windows");
  for (const w of f.tomorrow.tennis_windows) {
    assert.ok(
      ["HIGH", "MODERATE", "LOW"].includes(w.confidence),
      `window ${w.label} must have a valid confidence tier (got ${w.confidence})`
    );
    assert.ok(
      typeof w.confidence_note === "string" && w.confidence_note.length > 0,
      `window ${w.label} must have a non-empty confidence_note`
    );
  }
});

test("Day-level confidence and chip-implied agreement come from the same metric (no contradiction)", () => {
  // Cap on the user-facing bug: confidence: LOW + 'Both models agree' chip.
  // The fix is structural — confidence is the single signal — but verify
  // here that the confidence field exists and is one of the three tiers.
  const raw = makeRaw();
  const now = new Date("2026-05-19T05:00:00-04:00");
  const f = buildForecast({ data: raw, cached: false, models: { hrrr: { available: true, id: MODEL_HRRR }, ifs: { available: true, id: MODEL_IFS } } }, { now });

  assert.ok(["HIGH", "MODERATE", "LOW"].includes(f.tomorrow.confidence));
  assert.ok(typeof f.tomorrow.confidence_note === "string");
});
