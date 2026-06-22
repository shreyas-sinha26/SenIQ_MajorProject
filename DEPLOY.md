# SenIQ — Deployment (Phase 4)

Production target: **Render** (web service, always-on) · **Neon** (managed Postgres) ·
**Cloudflare** (domain + DNS) · in-process `node-cron`.

The code is already deploy-ready:
- `DATABASE_URL` is the only DB contract ([server/db.js](server/db.js)).
- Migrations run automatically on every boot → **migrate-on-deploy is free** ([server/db.js](server/db.js) `runMigrations`).
- Health check: `GET /api/health`.
- In prod the app **forces HTTPS + HSTS**, trusts the proxy, and **refuses to boot** on the
  default `JWT_SECRET` ([server/index.js](server/index.js)).
- Error monitoring (Sentry) is wired but **off until `SENTRY_DSN` is set**.

Everything below is account-side (needs your logins) and only has to be done once.

---

## 1. Managed Postgres — Neon

1. Sign up at <https://neon.tech> → **New Project** (region closest to you, e.g. Singapore/Mumbai).
2. Name the database `seniq`.
3. Copy the **Pooled** connection string (Dashboard → Connection Details → toggle *Pooled connection*).
   It looks like:
   ```
   postgres://USER:PASS@ep-xxxx-pooler.REGION.aws.neon.tech/seniq?sslmode=require
   ```
   Use the **pooled** (`-pooler`) host — the cron pipeline opens connections repeatedly.
4. Keep this string for step 2 (`DATABASE_URL`). Migrations create all tables on first boot —
   no manual schema setup.

---

## 2. Hosting — Render

1. Push this branch to GitHub `main` (the blueprint auto-deploys from `main`).
2. Render → **New → Blueprint** → pick this repo. It reads [render.yaml](render.yaml) and
   creates the `seniq` web service (**Starter plan, always-on** — required so cron runs 24/7).
3. When prompted, fill the `sync:false` secrets:
   | Var | Value |
   |---|---|
   | `DATABASE_URL` | Neon pooled string from step 1 |
   | `APP_URL` | leave blank for now; set to `https://<domain>` after step 3 |
   | `FINNHUB_API_KEY` | your Finnhub key (optional) |
   | `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Reddit script app (optional) |
   | `CONGRESS_TRADES_URL` | optional |
   | `SENTRY_DSN` | optional (step 4) |

   `JWT_SECRET` is **auto-generated** by Render. `NODE_ENV=production` and `SEC_USER_AGENT`
   are preset in the blueprint.
4. Deploy. Watch the log for `✅ N migration(s) applied` then the SenIQ banner. Hit
   `https://seniq-XXXX.onrender.com/api/health` → `{"status":"ok",...}`.

CI/CD is now live: every push to `main` redeploys and re-runs migrations.

---

## 3. Domain + HTTPS — Cloudflare

1. Register the domain at **Cloudflare Registrar** (Dashboard → Domain Registration). Pick the
   name you chose (e.g. `seniq.app` — `.app` is HSTS-preloaded so HTTPS is browser-enforced).
2. Render service → **Settings → Custom Domains** → add `seniq.app` (and `www.seniq.app`).
   Render shows the DNS target.
3. In Cloudflare DNS, add the record Render asks for:
   - Apex `seniq.app`: an `A`/`ALIAS`/`CNAME-flattening` record to Render's target, **or** a
     `CNAME` for `www` → `seniq-XXXX.onrender.com`.
   - Start with the record **DNS-only (grey cloud)** so Render can issue its own cert; once
     verified you may switch to **Proxied (orange)** for Cloudflare's CDN/edge TLS.
4. Render auto-provisions a Let's Encrypt cert. Wait until the custom domain shows **Issued**.
5. Set `APP_URL=https://seniq.app` in Render env and redeploy.
6. Verify: `https://seniq.app/api/health` works, and plain `http://seniq.app` **308-redirects**
   to HTTPS. Confirm the `Strict-Transport-Security` header is present (DevTools → Network).

---

## 4. Error monitoring — Sentry (optional but recommended)

1. <https://sentry.io> → new **Node.js** project → copy the **DSN**.
2. Set `SENTRY_DSN` in Render env → redeploy. Boot log prints `🛰️  Sentry error monitoring enabled`.
   Both HTTP errors and cron-pipeline failures now report to Sentry.

---

## 5. Backups

- Neon keeps automatic point-in-time restore on its history-retention window (free tier ~24h;
  paid extends it). For longer retention, schedule a periodic `pg_dump` (e.g. a GitHub Action
  on a cron) to object storage.

---

## Done when
- `https://<domain>/api/health` returns `ok` over TLS, HTTP redirects to HTTPS.
- Render shows a green deploy with `migration(s) applied` in the log.
- The news (10 min) and smart-money (15 min) cron lines appear in Render logs on schedule.

## Notes / gotchas
- **Keep exactly one always-on web instance.** The cron runs in-process and the `isRunning`
  guard only dedupes within a process — scaling web to 2+ would double-run the pipeline. If you
  later need to scale HTTP, split the scheduler into a separate Render **worker** first.
- **Don't enable `FINBERT_CLASSIFY` on Starter.** It pulls ~250MB and is RAM-heavy; the lexicon
  fallback is automatic. Only turn it on after moving to a larger instance.
- **Neon cold starts:** the free tier scales compute to zero after inactivity; the first request
  after idle has a ~1s wake. The 10-min cron keeps it warm during active hours.
