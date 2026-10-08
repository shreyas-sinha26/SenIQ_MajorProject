# SenIQ

**Sentiment-driven market intelligence.** Build a portfolio of US stocks, Indian stocks,
crypto and commodities, and SenIQ reads the news, scores sentiment, tracks where smart money
(institutions, politicians, insiders) is moving, and surfaces **what actually matters to
_your_ holdings**.

> **North Star — Portfolio Impact Scoring.** The differentiator isn't raw sentiment
> ("Tesla is negative"); it's exposure-weighted impact: _"this event affects 18% of your
> portfolio — today's most important event for you."_

> ⚠️ SenIQ is **informational, not investment advice.**

---

## Two versions, one codebase

A feature switch (`FEATURES_STRATEGIES=1`) turns on the v2 pages. With it off, the v2 routes
return 404 and the v2 pages are hidden.

| | Pages |
|---|---|
| **v1** | Dashboard, Portfolio, Intelligence (news, Institutions, Congress), Analytics, AI Workspace (daily brief + Ask) |
| **v2** | v1 + Strategy Builder, Your Strategies, Backtest, Paper Trade, MCP server, public REST API (`/v1`), API keys |

Releases are tagged in pairs on the same commit: `v1.N` is that commit run with strategies
off, `v2.N` with them on. The latest is `v1.10` / `v2.10`.

---

## Features

### Portfolio and prices
- **Multi-asset portfolio** — quantity and cost basis per holding, converted to USD before
  exposure weights are computed.
- **Live prices** — crypto from CoinGecko (no key), US stocks from Finnhub (Yahoo as
  fallback), Indian stocks from Yahoo in INR, commodities from Yahoo futures (FMP as fallback).
- **Smart onboarding** — adding a holding returns a company brief and backfills its impact
  silently; a holding only alerts on events after it was added.

### News and sentiment
- **Sources** — Finnhub company news, GDELT, and four Indian RSS feeds (Economic Times, Mint,
  Moneycontrol, Business Standard). Reddit ingest is built but needs credentials.
- **Entity resolution** — a curated universe of 186 instruments (100 US, 57 India, 25 crypto,
  4 commodities) and 192 executives decides which companies a story names.
- **Relevance and de-spam** — every story is graded Holdings / Markets / World / noise, and
  the same story from several outlets becomes one card.
- **Sentiment reading** — **FinBERT**, a finance-trained model, runs locally and reads each
  new story (`FINBERT_CLASSIFY=1`); a keyword list is the default and the fallback.
- **Per-company sentiment** — a story naming several companies is read once per company, from
  the sentences that name it, so "the market fell, while Nike advanced" is not negative for
  Nike. An optional language model (a local Ollama model, or Claude Haiku) reads a clause
  that names two or more companies; the local model also reads every story, and how far it
  agrees with FinBERT becomes that reading's confidence. Market wraps and "stocks to watch" lists are treated as
  market stories, not as news about each company they list.
- **Sentiment per ticker** — computed on read: an acute score over 24–72 hours with a 7-day
  half-life, momentum (this week against last), and a z-score against the ticker's own
  90-day normal. Sources are weighted by credibility.

### Impact, alerts and outcomes
- **Portfolio impact** — for each holding,
  `exposure × relevance × severity × novelty × confidence × recency`, ranked per user.
- **Durable events** — one event per story cluster, typed (M&A, legal, earnings, guidance,
  rating, macro…).
- **Alert budgets** — one alert per story per user; at most 5 real-time alerts a day (2 of
  them market-wide), the rest filed as a digest.
- **Outcome logging** — each event's features and the price 1 and 3 days later are stored
  for later tuning.

### Smart money
- **US** — 13F filings of 10 seeded funds straight from SEC EDGAR, and congressional trades
  from Financial Modeling Prep.
- **India** (opt-in, `INDIA_SMART_MONEY=1`) — NSE bulk and block deals, SEBI insider-trading
  disclosures, and 16 curated investors to follow.
- **Follows and webhooks** — follow funds, politicians or investors; Pro can register signed
  outbound webhooks.

### AI Workspace
- **Daily brief** — led by what changed since yesterday and the most important event,
  grounded only in the user's own holdings.
- **Ask** — a tool-calling agent with saved conversations. It answers about the user's
  holdings, market news and general finance education, and each answer is checked against
  its evidence.
- Both use Claude Haiku and fall back to code-written text when the model is off or fails.
  Nothing calls a paid model unless `CLAUDE_REPORTS=1`; there are per-user daily quotas, a
  global daily spend ceiling, and a log of every call with its cost.

### Reports and email
- **Report emails** as PDF attachments, on each user's own clock: a weekly summary (Free),
  the daily brief on weekday mornings (Plus, Pro), and an end-of-day report (Pro).
- **Alert emails** — standard for Plus, with a short written explanation for Pro.
- Every email has an unsubscribe link and is logged.

### Accounts, tiers and security
- **Sign-in** — email and password, or Google / GitHub (the buttons appear once the provider
  keys are set). Email verification and password reset by emailed one-time link.
- **Server-side sessions** — a random id in an HttpOnly cookie, with idle and absolute limits.
- **Tiers** — Free / Plus / Pro, gating holdings count, impact-feed depth, Ask questions per
  day, real-time alerts, smart money and API access. An admin account can switch tiers to
  preview each one. **Checkout is a development stub**: no payment provider is wired.
- **Request safety** — per-user rate limits, a same-origin guard on `/api`, a
  Content-Security-Policy, and guarded fetching of user-supplied URLs.

### v2: strategies, MCP and the public API
- **Strategy Builder** — mixes technical factors (EMA, RSI, MACD) with SenIQ factors
  (sentiment, smart money) in one strategy.
- **Backtest and paper trading** — with a buy-and-hold benchmark and a walk-forward check.
- **MCP server (`/mcp`) and REST API (`/v1`)** — the same data tools and strategy actions,
  for Pro API keys, with one shared rate budget per key.
- These pages need a separate strategy engine that is **not in this repository**. Without it
  every strategy route answers "engine offline".

---

## Tech stack

- **Backend:** Node.js (≥ 18) + Express, `node-cron` for the pipeline and scheduled jobs
- **Database:** PostgreSQL (migrations run automatically on boot)
- **Frontend:** vanilla HTML / CSS / JS single-page app, served from `public/`
- **Sentiment model:** FinBERT, run in-process with `@huggingface/transformers` (optional)
- **Language models:** Claude Haiku for the brief, Ask and alert explanations (optional,
  flag-gated), directly or through an OpenAI-compatible router; a local Ollama model for
  per-company sentiment (optional)

---

## Getting started

### Prerequisites
- [Node.js](https://nodejs.org/) ≥ 18
- [PostgreSQL](https://www.postgresql.org/download/) 15 or later. Note the **port**: a
  default PostgreSQL 18 install on Windows often uses **5433**, older versions 5432.

### 1. Install dependencies
```bash
npm install
```

### 2. Create the database
macOS / Linux:
```bash
createdb seniq
```
Windows (adjust the path and port to your install):
```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -p 5433 -c "CREATE DATABASE seniq;"
```

### 3. Configure the environment
Copy the template and fill in your values (`Copy-Item .env.example .env` on Windows):
```bash
cp .env.example .env
```
At minimum set `DATABASE_URL` and `JWT_SECRET`. Everything else is optional and degrades
gracefully; `.env.example` documents every variable. The main ones:

| Variable | Purpose | Without it |
|---|---|---|
| `FINNHUB_API_KEY` | US prices and company news ([free](https://finnhub.io)) | US prices fall back to Yahoo; no Finnhub news |
| `FMP_API_KEY` | Commodity price fallback, executives refresh ([free](https://financialmodelingprep.com)) | Yahoo only |
| `FINBERT_CLASSIFY=1` | FinBERT reads each new story, locally (first run downloads about 110 MB) | Keyword list |
| `COMPANY_SENTIMENT_LLM` | `ollama` or `1`: a language model reads multi-company clauses | FinBERT's per-company reading |
| `CLAUDE_REPORTS=1` + `ANTHROPIC_API_KEY` or `AIROUTER_API_KEY` | Claude writes the brief, Ask answers and alert explanations | Code-written text |
| `INDIA_SMART_MONEY=1` + `NSE_USER_AGENT` | India deals and insider trades | US smart money only |
| `CONGRESS_TRADES_URL` | Live congressional trades | Bundled sample data |
| `SEC_USER_AGENT` | Contact address for SEC EDGAR requests | Default user agent |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | "Sign in with Google" (callback `<APP_URL>/api/auth/oauth/google/callback`) | Button hidden |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | "Sign in with GitHub" | Button hidden |
| `RESEND_API_KEY` or `SMTP_*`, `EMAIL_FROM` | Sending email (alerts, reports, password reset) | Dev builds show reset links inline; no email sent |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Seed an admin account (tier switcher) | No admin account |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Reddit ingest | Skipped |
| `FEATURES_STRATEGIES=1` + `STRATEGY_SERVICE_*` | The v2 pages | v1 only |

### 4. Run
```bash
npm start        # production
npm run dev      # auto-reload (node --watch)
```
Migrations apply on boot. Open **http://localhost:3000** for the landing page or
**http://localhost:3000/app** for the app (set `PORT` to change it), sign up, and add
holdings. Every boot runs the news pipeline once, then every 10 minutes.

### 5. Test
```bash
npm test
```
The tests run offline: no database, no API calls, no model downloads.

---

## Notes and known limits

- **Sentiment history is short.** It is only as long as the app has been recording, so the
  "90-day normal" rests on less than that until the store fills.
- **Sentiment has been checked on two small hand-labelled sheets only** (below), and matches
  the labels on about two pairs in three. Treat the readings as a signal, not a measurement.
- **Nothing is hosted.** `DEPLOY.md` and `render.yaml` describe a deployment that has not
  been carried out.
- **Payments are not wired.** Upgrading a tier works only through the development stub.
- **macOS ↔ Windows:** native modules don't transfer across platforms. If you copied
  `node_modules` from another OS and hit a `sharp` load error, run a clean `npm install`.

## How the sentiment readings were checked

One person labelled (story, company) pairs from the stored news by hand: positive, neutral
or negative for that company, or "not about this company". There are two sheets, about two
thirds of each from stories naming several companies.

- **Sheet 1** (100 pairs) was used to choose between designs and settings, so its figures
  flatter whatever was chosen.
- **Sheet 2** (101 pairs) was labelled afterwards, from stories never looked at during
  development, and scored once. It is the fairer test.

| How the story is read | Sheet 1: match | Sheet 1: opposite | Sheet 2: match | Sheet 2: opposite |
|---|---|---|---|---|
| One FinBERT reading for the whole story, given to every company named | 54 of 100 | 11 | 66 of 101 | 5 |
| FinBERT per company (the sentences that name it) | 56 | 8 | 69 | 5 |
| **FinBERT + a local model (Qwen 2.5 7B), as shipped** | 66 | 3 | 66 | 3 |
| FinBERT fine-tuned on SEntFiN + the local model (tried, not adopted) | 69 | 1 | 62 | 2 |

"Opposite" counts readings that said positive where the label said negative, or the reverse.

What this shows:

- **The gain in matches on sheet 1 did not repeat on sheet 2.** On fresh stories no way of
  reading matched clearly more labels than the plain whole-story reading; the differences
  are within what 100 pairs can resolve (roughly ±9 points).
- **Two things did repeat.** Opposite-direction readings fell on both sheets (11 → 3 and
  5 → 3). And with the shipped setup more of the *weight* sits on readings that match: each
  reading carries a confidence, which is its weight in a ticker's score, and the share of
  confidence on matching readings rose from 56% to 72% on sheet 1 and from 67% to 74% on
  sheet 2. That comes from asking the local model about every story and treating its
  agreement with FinBERT as confidence.
- **Fine-tuning helped on its own data, not on ours.** Trained on SEntFiN (Indian headlines
  labelled per company, MIT licence), FinBERT went from 65% to 88% on held-out SEntFiN
  pairs. On the hand-labelled stories it did not beat plain FinBERT on sheet 2, so it is
  left off (`training/train_target_sentiment.py` rebuilds it).
- **"Not about this company"** is caught only by the language model. Across both sheets its
  "not about" answers were right about two times in three, so they are stored as neutral
  readings at the lowest confidence and the tag is kept.
- On sheet 1 only, Claude Haiku in place of the local model matched 70 with 3 opposite.
- One labeller, about 100 pairs a sheet, and no comparison against price moves. Treat all of
  it as indicative, not as a benchmark.

`scripts/sentiment_label_sheet.js` writes such a sheet and `scripts/score_sentiment_labels.js`
scores it.

## More documentation

- [`handoff.md`](handoff.md) — the current state of the project, in detail: how each part
  works, what has and has not been proven, and open work
- [`PLAN.md`](PLAN.md) — the original product plan
- [`ENGINE_PLAN.md`](ENGINE_PLAN.md) — the intelligence engine
- [`STRATEGY_PLAN.md`](STRATEGY_PLAN.md) — strategies, MCP and the API
- [`RAG_PLAN.md`](RAG_PLAN.md) — Ask, retrieval and signals
- [`IPO_PLAN.md`](IPO_PLAN.md) — sentiment for IPOs and small/mid-caps (plan only)
- [`DEPLOY.md`](DEPLOY.md) — deployment steps (not yet executed)

## License

Proprietary — all rights reserved (update as needed).
