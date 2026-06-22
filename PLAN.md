# SenIQ — Phased Build Plan

Sentiment-driven market intelligence platform. Users build a multi-asset portfolio;
we pull news + social + macro signals, score sentiment, track where smart money
(institutions + politicians) is moving, gate features by tier, expose everything as an
API/MCP server, and run an agent that delivers a personalized daily report plus
immediate alerts on major events.

Budget stance: **cheapest viable** — free/low-cost data tiers and self-hosted LLM
(Ollama) wherever possible. Pay only for hosting, Stripe/Razorpay (per-transaction),
the Claude report API, and optionally X later.

> **Roadmap status:** Phases 0–3.5 are **DONE**. The remaining order was **re-sequenced
> 2026-06-20** (see `SenIQ_Roadmap.pdf`): cloud deployment + domain + OAuth move ahead of
> billing, because OAuth callbacks and payment webhooks both need a public HTTPS domain.
> This file is the authoritative plan; the old "Phase 4 = billing" is now **Phase 6**.

---

## North Star: Portfolio Impact Scoring (the real differentiator — prioritize this)

The hidden opportunity is **not** raw sentiment. Anyone can say "Tesla sentiment is negative."
The thing users *immediately* understand is **impact on their own portfolio**:

> "This event affects **18% of your portfolio exposure**."
> "Based on your holdings, this is **today's most important event**."

So the core unit of analysis is **event → portfolio impact**, not asset → sentiment. Sentiment is an
input; the headline output is an **exposure-weighted impact score**. This is where engineering effort
should concentrate — it's the feature that makes the product feel personal and obviously valuable.

**How it threads through the phases:**
- **Position weights** (Phase 1, done): impact = exposure × relevance × magnitude.
- **Impact score** (Phase 2, done): per event, Σ over affected holdings of
  (holding weight × relevance × sentiment magnitude/z-score). Direct holdings first; macro applies broadly.
- **"Most important event today"** (Phase 2 dashboard, done; Phase 9 report): rank events by impact and
  lead with the top one — the dashboard headline and the first line of the daily report.
- **Exposure-weighted alerts** (Phase 3.5, done): the materiality score's "relevance" term is the
  holding's *weight* — a 20% position firing beats a 2% position firing.

---

## Working agreement (READ FIRST)

**Before starting to build ANY phase, ask the user a short batch of clarifying questions first —
do not start writing code until they answer.** The goal is to stay on the same page on the choices
that phase locks in (which API, which library, schema shape, thresholds, etc.). Each remaining phase
carries a **Kickoff Qs** line. Keep the batch tight (use the AskUserQuestion flow), then build.

---

## Completed phases (0 → 3.5) — DONE & verified

Detailed build notes for each live in `handoff.md` and auto-memory; concise summary here.

| Phase | Scope | Status |
|---|---|---|
| **0 · Foundations** | Moved SQLite → **Postgres** (`seniq`); migration runner (`server/migrations/*.sql`) run on boot; config/feature-flag layer (`server/config.js`); global "informational, not advice" disclaimer | ✅ Done |
| **1 · Multi-asset portfolio** | equity / crypto / commodity; Finnhub + CoinGecko prices; per-holding **quantity + cost_basis** → exposure weights (the impact-scoring input) | ✅ Done |
| **2 · Sentiment engine v2** | decay-weighted acute + momentum + 90-day **z-score baseline** (computed on read); multi-source ingest (GDELT + RSS + Reddit, X stubbed); source-credibility weights; FinBERT (env-opt-in) with lexicon default; **Portfolio Impact Scoring (North Star)** + per-user ranked feed | ✅ Done |
| **3 · Smart money** | 13F via **SEC EDGAR** (10 seeded funds) + Congress trades (free dataset + bundled sample); follows; **signed outbound webhooks** (Pro); emulated-webhook 15-min poller; backfill guard so history doesn't alert | ✅ Done |
| **3.5 · News relevance & de-spam** | 3-bucket feed (**holdings / market / world**), **event clustering** (one card per event, source count), **materiality alerting** (replaces per-article rules; one alert per event per user, gated on exposure × z-surprise × volume); **top-level page tabs** (Dashboard / Institutions / Congress) | ✅ Done |

**Decided during these phases (still binding):** model split (FinBERT local batch + lexicon realtime;
Claude API for report/alert narrative); X deferred (Reddit-only social v1); tier matrix (see Phase 6);
North Star = Portfolio Impact Scoring; strategies tab has **no** backtesting (lives in a separate project).

---

# The road ahead (re-sequenced)

**Sequencing: 4 → (5, 6 in parallel) → 7 → 8 → 9.** Deploy + domain + HTTPS come first because both
OAuth (5) and billing (6) need public callback/webhook URLs.

---

## Phase 4 — Cloud Deployment, Domain & HTTPS  *(NEW — do first; unblocks 5 & 6)*
**Goal:** take SenIQ off localhost onto a public, always-on, TLS-secured host so the cron pipeline
runs 24/7 and OAuth/Stripe callbacks have a real URL.
**Kickoff Qs:** Render vs Fly.io vs a VPS? Which domain + registrar (and is it bought yet)? Managed
Postgres provider (Render PG / Neon / Supabase)? Keep node-cron in-process or split a worker?

- **Hosting:** deploy to a managed PaaS (recommend **Render** or **Fly.io** — cheapest-viable, auto-TLS,
  built-in cron/worker support). Web service for Express + the in-process node-cron pipeline.
- **Managed Postgres:** move off the local `seniq` DB to a managed instance. Keep the `DATABASE_URL`
  contract; migrations already run on boot.
- **Domain name:** register (e.g. `seniq.app` / `getseniq.com` via Cloudflare or Namecheap); point DNS at the host.
- **HTTPS/TLS:** automatic certs from the host (or Cloudflare proxy); force HTTPS + HSTS.
- **Secrets:** move `.env` into host environment variables (JWT secret, Finnhub, Reddit, SEC UA,
  congress URL, and later Stripe/OAuth keys). **Rotate the JWT secret for production.**
- **CI/CD:** auto-deploy on push to `main`; run migrations on deploy.
- **Ops baseline:** health-check endpoint, structured logs, error monitoring (free Sentry tier),
  automated Postgres backups.

**Done when:** the app is reachable at `https://<domain>` over TLS, migrations apply on deploy, and the
news + smart-money cron jobs run in the cloud.

---

## Phase 5 — Auth & Accounts (OAuth)  *(NEW)*
**Goal:** add social sign-in beside the existing email/password so users onboard in one click.
Depends on the public HTTPS domain (Phase 4) for callback URLs.
**Kickoff Qs:** which providers at launch (Google only, or + GitHub/Apple)? Require email verification
before use? Refresh tokens now or later?

- **OAuth providers:** Google first (highest conversion), GitHub optional. Authorization-Code flow;
  callback at `https://<domain>/api/auth/oauth/<provider>/callback`.
- **Account model:** link an OAuth identity to a user row by **verified email** so password + Google
  land on the same account; store `provider` + `provider_id`.
- **Email flows:** email verification on signup + password reset (needs the email provider — cross-cutting).
- **Hardening:** production JWT secret, sensible token expiry, optional refresh tokens, rate-limit auth endpoints.

**Done when:** a user can sign in with Google and land in their portfolio, and email/password accounts
can reset their password.

---

## Phase 6 — Tiers & billing (Free / Plus / Pro)  *(was Phase 4)*
**Goal:** monetize via feature gating + Stripe/Razorpay, with hard cost guardrails on the Claude-backed
reports. Needs the public HTTPS domain (Phase 4) for payment webhooks.
**Kickoff Qs:** confirm final price points + annual discount. Stripe (US) + Razorpay (India) accounts
ready? Global daily kill-switch $ ceiling? Region-gate by card BIN confirmed?

- Add `subscription_tier` to `users`; build gating middleware. **This finally enforces the smart-money
  tier split** (Free teaser / Plus full / Pro webhooks) that Phase 3 left open.

**Confirmed tier split:**

| Capability | Free | Plus | Pro |
|---|---|---|---|
| Holdings | up to 7 (any mix) | unlimited | unlimited |
| Sentiment depth | acute, 7-day history | full: acute + momentum + 90-day z-score | full + per-asset deep dive |
| Portfolio impact scoring | top event only | full ranked impact feed + exposure % | full + intraday refresh |
| Sources | news + macro | news + Reddit + macro | news + Reddit + macro |
| Smart money | teaser (top 1–2, delayed) | full Institutions + Politicians | full + filtered to holdings |
| Alerts | daily in-app digest | real-time (in-app + email) | real-time + full narrative |
| Strategies | list + descriptions | + live applicability | personalized to portfolio |
| Claude daily report (PDF) | — | 1 / day | 1 / day |
| Second intraday report | — | — | yes (2 / day total) |
| API / MCP access | — | — | yes |

- Stripe Checkout + webhook for tier changes; Razorpay for INR.

**Cost guardrails (non-negotiable — protect the Claude key from runaway bills):**
- Reports are **server-scheduled, never user-triggered on demand** (no loopable "generate" button).
- **Per-user daily call quota** in a counter table, reset at UTC midnight (Plus=1, Pro=2 [+1 manual]);
  over quota → blocked *before* any Claude call.
- **Hard token caps per call** (trim input to top-N holdings + capped news chars; `max_tokens` ~1.5–2k).
- **Global daily spend kill switch** with admin alert.
- **Per-user monthly token budget** → degrade to local Ollama (free) on exceed.
- API/MCP never exposes raw generation as a free-call tool; cache generated reports; sanitize untrusted
  news/social text before prompting; log every Claude call (user, tokens, cost).

### Pricing
COGS driven by the Claude report (~$0.04–0.05/report cached): **Plus ~$2/user/mo, Pro ~$5/user/mo.**
Claude cost is USD-fixed regardless of location, so India can be cheaper but never below cost.

| Tier | US / mo | India / mo | Cost / user | US margin |
|---|---|---|---|---|
| Free | $0 | ₹0 | ~$0 | — |
| Plus | $9 | ₹399 (~$4.70) | ~$2 | ~78% |
| Pro  | $24 | ₹999 (~$11.75) | ~$5 | ~79% |

- **Annual** ≈ 2 months free. **Region gate by billing country / card BIN** (not IP). INR via Razorpay.
- Cost lever: route routine reports through **Haiku** (~4–5× cheaper); reserve Sonnet/Opus for Pro/major events.

**Done when:** gating returns 402/upsell for lower tiers; Stripe/Razorpay upgrade flips the tier via
webhook; no code path lets a user invoke Claude beyond their quota; the global kill switch trips in testing.

---

## Phase 7 — Strategies tab  *(was Phase 5)*
**Goal:** 3–5 preset sentiment strategies as **education** (not signals), with live applicability to the
user's holdings. **No backtesting** — that lives in the user's separate backtesting project.
**Kickoff Qs:** which strategies make the cut? How to present live applicability? Disclaimer wording?
Where to link out to the backtesting project?

- Present well-known approaches + logic: sentiment-momentum, sentiment-reversal (fade extremes),
  news-volume spike, smart-money follow, macro-risk-off overlay.
- **Live applicability:** which of the user's *current* holdings each strategy flags right now, given
  today's sentiment / z-score / impact data. Educational disclaimers throughout.

**Done when:** each strategy has a description, logic, and a live "what it flags in your portfolio
today" view — no backtest charts.

---

## Phase 8 — API / MCP server  *(was Phase 6)*
**Goal:** expose the platform as a clean REST API and an MCP server the agent consumes; UI and agent
share one tool layer.
**Kickoff Qs:** REST + MCP both at launch or MCP later? Auth scheme (API keys per user)? Which tools
first? Rate-limit tiers per plan?

- REST API keyed by tier: portfolio sentiment, smart-money, alerts, strategies.
- **MCP server** wrapping the same tools (`get_portfolio_sentiment`, `get_smart_money`, `get_alerts`,
  `run_strategy`) so any MCP agent (incl. this one) can call them.
- Per-key auth + rate limit; report generation is never a free-call tool (hits the same per-user quota).

**Done when:** an external MCP client can authenticate and pull a user's sentiment picture.

---

## Phase 9 — Agent (daily report + instant alerts)  *(was Phase 7)*
**Goal:** personalized, well-reasoned reports — "no generic stuff." The **materiality alert engine
already shipped in Phase 3.5**, so this phase is Claude narrative + email delivery.
**Kickoff Qs:** which Claude model (Sonnet default / Haiku routine)? Report format + branding? Email
provider (Resend/SES)? Confirm materiality thresholds for the narrative path.

- **Scheduled report:** reuse the ReportLab PDF builder; feed per-user sentiment + impact + smart-money
  context; generate prose with the **Claude API** (`ollamaExplainer.js` = dev/fallback). Cadence by tier:
  Plus 1×/day, Pro 2×/day — server-scheduled, subject to the Phase 6 quota + token caps; prompt-cache the
  static system prompt.
- **Lead with portfolio impact (North Star):** open with today's most important event + its % exposure.
- **Grounding, not model choice:** every claim cites a number (FinBERT score, z-score, exposure %,
  smart-money fact) passed as structured context.
- **Instant alert path:** the materiality score + event dedupe from Phase 3.5 already decide *when* to
  fire; this phase adds **email delivery** (SMTP/SES/Resend) and, for **Pro**, an attached **Claude
  narrative** within quota.

**Done when:** a Plus user gets a daily portfolio-grounded PDF (Pro also an intraday one), and a major
event pages them within minutes — all within the Phase 6 quota/cost guardrails.

---

## Cross-cutting (runs alongside the phases)
- **Email provider** (Resend or AWS SES) — powers verification + reset (Phase 5) and alerts + reports (Phase 9).
- **Monitoring & backups** — error tracking, uptime checks, automated Postgres backups (stand up in
  Phase 4, maintain after).
- **Legal** — disclaimer is live; add Terms + Privacy before billing (Phase 6).
- **Open data gap** — live Congress data runs on the bundled sample until `CONGRESS_TRADES_URL` is set or
  a paid feed is chosen.

## Dependency order
0 → 1 → 2 → 3 → 3.5 (all done) → **4** → (**5**, **6** in parallel) → **7** → **8** → **9**.
Build API-first (Phase 8 thinking) incrementally so the agent isn't bolted on at the end.

## Open decisions
Phase 4 kickoff (hosting target, domain/registrar, managed Postgres provider, cron in-process vs worker)
— **ask before building.** Billing kickoff deferred to Phase 6.
