# Deploying BocaWeather to Railway

This guide deploys BocaWeather to [Railway](https://railway.app/) from GitHub. No environment variables are required. Total time: about 5 minutes.

## Prerequisites

- A GitHub account with push access to `rrathip-glitch/bocaweather`.
- A Railway account (free tier is sufficient for this app).
- The code on branch `claude/weather-prediction-website-DhTIq`, or whichever branch you want to deploy.

## Step 1 — Push to GitHub

From the repo root:

```bash
git add .
git commit -m "Initial BocaWeather scaffold"
git push -u origin claude/weather-prediction-website-DhTIq
```

If the branch already exists on the remote, a plain `git push` is enough.

## Step 2 — Create the Railway project

1. Go to <https://railway.app/new>.
2. Choose **Deploy from GitHub repo**.
3. If prompted, install the Railway GitHub app on your account and grant access to `rrathip-glitch/bocaweather`.
4. Select the `bocaweather` repository.
5. In the deployment settings, change the deploy branch to `claude/weather-prediction-website-DhTIq` (or your branch).

Railway will start its first build immediately.

## Step 3 — Verify build configuration

Railway uses [Nixpacks](https://nixpacks.com/) to detect the stack. With `package.json` and `.node-version` in the repo it will:

- Install Node 20 (pinned by `.node-version`).
- Run `npm ci` (or `npm install`) to install dependencies.
- Run `npm start` to launch the app (configured in `railway.json`).

No environment variables are needed. Open-Meteo requires no API key.

## Step 4 — Healthcheck

`railway.json` declares:

```json
{
  "deploy": {
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

Railway will hit `GET /api/health` after start and treat the deploy as healthy when it returns 200. The endpoint deliberately does **not** call Open-Meteo so transient upstream outages do not trigger restarts.

## Step 5 — PORT

Railway sets `PORT` as an environment variable at runtime. The app reads it with `process.env.PORT || 3000`. Do **not** hardcode 3000 in `server.js` or override `PORT` in Railway variables.

## Step 6 — Generate a public domain

1. In the Railway project, open the deployed service.
2. Go to **Settings → Networking**.
3. Click **Generate Domain**.

You will get a URL like `bocaweather-production.up.railway.app`. The app should be reachable there within seconds.

## Step 7 — (Optional) Custom domain

1. In **Settings → Networking → Custom Domain**, add your domain.
2. Railway will display a CNAME target (the Railway-generated host from Step 6, or a Railway proxy host).
3. In your DNS provider, create a CNAME record pointing your subdomain (for example `weather.example.com`) at that target.
4. Wait for DNS to propagate (usually under 5 minutes). Railway provisions an HTTPS certificate automatically.

## Step 8 — Watching logs

Easiest path is the Railway dashboard: open the service, click **Deployments**, click the active deployment, and tail the logs in the browser.

For CLI access:

```bash
npm install -g @railway/cli
railway login
railway link            # interactive: pick the project
railway logs            # live tail
railway logs --deployment <id>
```

## Troubleshooting

### App returns 502

- Check that `server.js` listens on `process.env.PORT || 3000`. A hardcoded port will not bind correctly on Railway.
- Check the deploy logs for a startup crash before the healthcheck ran.
- Confirm the healthcheck timeout (30s) is enough for cold start. If startup is slow (it should not be — this app is tiny), raise `healthcheckTimeout` in `railway.json`.

### Open-Meteo rate limits / 429s

- The 10-minute in-memory cache should keep us well below the ~10k requests/day free-tier limit.
- If you start hitting limits anyway, increase `CACHE_TTL_MS` in `lib/config.js`. Do not go below 5 minutes (Open-Meteo etiquette).
- Confirm you have not accidentally introduced a cache-bypassing query string from the frontend.

### Forecast looks stale

- The in-memory cache holds responses for 10 minutes. To force a flush, redeploy or restart the service from the Railway dashboard.
- Open-Meteo itself updates HRRR roughly hourly and IFS less often. A "stale" forecast may just be the latest run.

### One model is missing in the response

- If `models.hrrr.ok` or `models.ifs.ok` is false in `/api/forecast`, the upstream call for that model failed. The app continues with the surviving model — this is intentional, see [DESIGN.md](./DESIGN.md). Check Railway logs for the upstream error.

### Healthcheck fails on first deploy

- Make sure `GET /api/health` returns 200 without hitting external services. If you have wired the healthcheck through a path that calls Open-Meteo, undo that.
