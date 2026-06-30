# SenIQ

**Sentiment-driven market intelligence.** Build a multi-asset portfolio, and SenIQ pulls
news + social + macro signals, scores sentiment, tracks where smart money (institutions +
politicians) is moving, and surfaces **what actually matters to _your_ holdings**.

> **North Star — Portfolio Impact Scoring.** The differentiator isn't raw sentiment
> ("Tesla is negative"); it's exposure-weighted impact: _"this event affects 18% of your
> portfolio — today's most important event for you."_

> ⚠️ SenIQ is **informational, not investment advice.**

---

## Features (Phases 0–3.5 + 6 + Engine E1–E6, shipped)

- **Multi-asset portfolio** — equities / crypto / commodities with quantity + cost basis →
  exposure weights. **Live price + day-change shown next to each holding:** crypto via
  CoinGecko (no key), US equities + commodities via FMP (`FMP_API_KEY`) — or Finnhub
  (`FINNHUB_API_KEY`) for unthrottled real-time equity quotes; commodities (incl. oil) and
  Indian stocks fall back to yfinance via the strategy service.
- **Sentiment engine v2** — decay-weighted acute score + momentum + 90-day z-score baseline,
  computed on read. Multi-source ingest (GDELT + Indian RSS + Reddit). Optional **FinBERT**
  classifier via the Hugging Face Inference API; keyword lexicon by default.
- **Portfolio Impact Scoring** — per-event, exposure-weighted impact ranking + a per-user feed.
- **Smart money** — 13F filings via free **SEC EDGAR** (10 seeded funds) + **live Congress
  trades** (Financial Modeling Prep, both chambers — see `CONGRESS_TRADES_URL`), follows,
  signed outbound webhooks, and a **search bar** on both Institutions and Congress.
- **News relevance & de-spam** — a 3-bucket feed (Holdings / Markets / World), event
  clustering (one card per story), and materiality-gated alerts.
- **Tiers & billing (Phase 6)** — Free / Plus / Pro with real gating (holdings cap, smart-money
  teaser, impact-feed depth, AI Workspace), a Plans/upgrade page (Stripe/Razorpay stubbed until
  deploy), and an **admin tier switcher** to preview every tier live (`is_admin` + `ADMIN_*`).

**Intelligence engine (E1–E6):**
- **E1 — entity resolution + durable events** — a curated company universe (~US 100 / Nifty 50 /
  top crypto) resolves names, executives, and sector themes; stories become *remembered* events
  that articles attach to across runs.
- **E2 — event typing + 6-factor impact** — `exposure × relevance × severity × novelty ×
  confidence × recency`.
- **E3 — alert budgets + outcome logging** — top few realtime/day, rest digest; per-ticker
  cooldown; auto-logged 1–3 day price outcomes for future supervised tuning.
- **E4 — smart onboarding** — adding a holding gives an instant company brief + silent backfill
  + a "monitoring since" watermark (no alert blast for old news).
- **E5 — daily brief** — Claude (Haiku) writes a brief grounded entirely in your holdings, led by
  what changed since yesterday. Server-scheduled, behind a flag, with hard cost guardrails.
- **E6 — Ask anything** — natural-language portfolio Q&A grounded strictly on engine data.

**In progress — Strategies (Phase 7) + MCP (Phase 8):** a visual **strategy builder** (pick
EMA/RSI/MACD…), **backtesting**, and **paper trading** for US stocks + crypto (+ India), reusing
the zeuniq Python engine as a separate service, plus an **MCP server** exposing SenIQ signals to
agents. Strategies sit in the sidebar (Builder / Your Strategies / Backtest / Paper Trade) as
scaffolds today. Design + decisions in [`STRATEGY_PLAN.md`](STRATEGY_PLAN.md).

See [`PLAN.md`](PLAN.md) (product roadmap), [`ENGINE_PLAN.md`](ENGINE_PLAN.md) (engine track),
[`STRATEGY_PLAN.md`](STRATEGY_PLAN.md) (strategies/MCP), and [`handoff.md`](handoff.md) for build notes.

---

## Tech stack

- **Backend:** Node.js (≥18) + Express, `node-cron` pipeline
- **Database:** PostgreSQL (migrations run automatically on boot)
- **Frontend:** vanilla HTML / CSS / JS SPA (served from `public/`)
- **ML:** FinBERT via the Hugging Face Inference API (`@huggingface/inference`, optional)
- **LLM:** Claude (Anthropic) for the daily brief + portfolio Q&A (optional, flag-gated)

---

## Getting started (Windows)

### Prerequisites
- [Node.js](https://nodejs.org/) ≥ 18
- [PostgreSQL](https://www.postgresql.org/download/windows/) (16/17/18). Note the **port** —
  a default PostgreSQL 18 install on Windows often uses **5433**, older versions 5432.

### 1. Install dependencies
```powershell
npm install
```

### 2. Create the database
Using `psql` (adjust the path/port to your install):
```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -p 5433 -c "CREATE DATABASE seniq;"
```

### 3. Configure environment
Copy the template and fill in your values:
```powershell
Copy-Item .env.example .env
```
At minimum set `DATABASE_URL` (with your Postgres password and port) and `JWT_SECRET`.
Optional API keys (all degrade gracefully — see inline comments in `.env.example`):

| Variable | Purpose | Without it |
|---|---|---|
| `FMP_API_KEY` | Live US-equity + commodity (gold) prices, congress data ([free](https://financialmodelingprep.com)) | Those prices show N/A; crypto still prices free |
| `FINNHUB_API_KEY` | Unthrottled real-time US-equity prices ([free](https://finnhub.io), preferred over FMP) | Falls back to FMP (cached, rate-limited) |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Reddit social ingest | Skipped; GDELT + RSS still feed news |
| `FINBERT_CLASSIFY=1` | Use the FinBERT classifier (HF Inference API) | Keyword lexicon (default) |
| `HF_API_TOKEN` | Hugging Face token for FinBERT | FinBERT disabled; lexicon used |
| `SEC_USER_AGENT` | SEC EDGAR contact (real email) | Default UA used |
| `CONGRESS_TRADES_URL` | Live congress-trade data | Bundled sample (`data/congress_sample.json`) |
| `ANTHROPIC_API_KEY` | Claude — daily brief (E5) + Q&A (E6) | Free deterministic writer |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Seed an admin account (tier switcher, set any user's tier) | No admin account seeded |

### 4. Run
```powershell
npm start        # production
npm run dev      # auto-reload (node --watch)
```
Migrations apply on boot. Open **http://localhost:3000**, sign up, and add holdings.

---

## Notes

- **macOS → Windows:** native modules don't transfer across platforms. If you copied
  `node_modules` from another OS and hit a `sharp` load error, run a clean `npm install` on
  Windows (it pulls the correct platform binaries automatically).
- **Indian equities** have no free price source — they show N/A and rely on normalized
  equal-share exposure for scoring (a deliberate decision).

## License

Proprietary — all rights reserved (update as needed).
