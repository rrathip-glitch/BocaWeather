import express from "express";
import { fetchForecast } from "./lib/openMeteo.js";
import { buildForecast } from "./lib/forecast.js";

const app = express();
app.set("trust proxy", true);

app.use(express.static("public"));

let firstRequestLogged = false;
app.use((req, _res, next) => {
  if (!firstRequestLogged) {
    firstRequestLogged = true;
    console.log(`[boca-weather] first request: ${req.method} ${req.url}`);
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/api/forecast", async (_req, res, next) => {
  try {
    const raw = await fetchForecast();
    const forecast = buildForecast(raw);
    res.set("Cache-Control", "public, max-age=300");
    res.json(forecast);
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error("[boca-weather] error:", err);
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[boca-weather] listening on port ${PORT}`);
});
