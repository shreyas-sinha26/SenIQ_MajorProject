# Handoff — SenIQ (updated 2026-09-26)

**Current state in one paragraph:** v1 (Dashboard → Portfolio → Intelligence → Analytics →
AI Workspace) and v2 (+ Strategy Builder, Your Strategies, Backtest, Paper Trade, MCP, public
API) run from **one codebase** on `main`, split by a feature switch. Ask is now a
tool-calling agent with news retrieval (RAG), saved conversations and cost controls. The
whole frontend is re-themed to a light brand palette with a sliding nav indicator. Everything
since July is **committed locally and tagged, but NOT pushed**.

---

## 1. Versions & tags (local only)

| Tag | Commit | What it is | How to run |
|---|---|---|---|
| `v1.0` | `24148b2` | v1 on the old dark theme (presentation fallback) | `npm start` |
| `v1.1` | `673791a` | v1 on the light theme + sliding nav | `npm start` |
| `v2.1` | `673791a` | same code, strategies on | `FEATURES_STRATEGIES=1 PORT=3030 npm start` + strategy engine |

Local commits ahead of GitHub (`origin/main` = `ac6d217`, fetched in July):
```
673791a Light theme on the brand palette + sliding nav indicator      (v1.1, v2.1)
24148b2 v1/v2 split: STRATEGIES feature switch (off by default)       (v1.0)
d08fe98 Ask v2 — tool-calling agent, news search (RAG), saved conversations
```
Uncommitted on purpose: `eval/` (Ask test set) and `.github/` (CI workflow — see §8).

**Why one branch, not two:** strategy commits are interleaved in history (since `ecb9c83`),
so no commit is "v1 without strategies". The switch `FEATURES.STRATEGIES`
(env `FEATURES_STRATEGIES=1`, default off) hides the v2 UI (`body.no-strategies`) and makes
`/api/strategies`, `/api/paper`, `/api/keys`, `/mcp`, `/v1`, `/docs` return 404.

## 2. Run it locally

```bash
pg_isready                                   # Postgres@15 via brew services; if down: brew services start postgresql@15
cd ~/Downloads/SenIQ_MajorProject && npm start   # v1 → http://localhost:3010/app
```
v2 needs two terminals:
```bash
cd ~/Downloads/SenIQ_MajorProject/strategy-service && ./venv/bin/uvicorn app:app --port 8100
cd ~/Downloads/SenIQ_MajorProject && FEATURES_STRATEGIES=1 PORT=3030 npm start   # → http://localhost:3030/app
```
- Port busy → `lsof -ti :3010 | xargs kill`. Health → `curl -s localhost:3010/api/health`.
- Start ~5 min before a demo so the first news-pipeline run has finished.
- **Demo account:** `demo@xynthis.com` (Pro). The password is a bcrypt hash — it can't be
  recovered; set a new one with the one-liner below (prompts silently, local DB only):
  ```bash
  cd ~/Downloads/SenIQ_MajorProject && read -s -p "New demo password: " PW && echo && PW="$PW" node -e "require('dotenv').config();const b=require('bcryptjs');const {pool}=require('./server/db');b.hash(process.env.PW,10).then(h=>pool.query('UPDATE users SET password_hash=\$1 WHERE email=\$2',[h,'demo@xynthis.com'])).then(r=>{console.log(r.rowCount?'Password updated':'User not found');return pool.end()})"
  ```
- Demo portfolio holds 5 units of everything → BTC ≈ 99% exposure, which skews every
  portfolio answer. Consider realistic quantities before the next demo.

## 3. What was built since the July handoff

### Ask v2 (AI Workspace) — `server/services/qa.js`, `qaTools.js`, `newsSearch.js`, `askThreads.js`
- **Tool-calling agent** (Claude Haiku 4.5) instead of one stuffed context. 8 tools:
  portfolio overview, today's **attribution** (weight % × day change %), top impact events,
  ticker news, sentiment, smart money, market news, `search_news`.
- **RAG (`search_news`)**: corpus = headline + summary of relevant articles, last 90 days (no
  full-article scraping). Hard filters first (allowed tickers + date), then pgvector cosine
  similarity on HF `all-MiniLM-L6-v2` embeddings (384-d), deduped by story cluster, similarity
  floor 0.3. Falls back to keyword search (≥2 word matches) without pgvector/token/flag.
  The vector table is created **in code** (`ensureVectorStore`), not a migration, so a
  Postgres without pgvector still boots. Pipeline step 8 embeds new articles (≤200/run).
- **Scope:** user's holdings + market-wide news + general finance education. A question only
  about stocks the user doesn't hold gets a fixed refusal **before** any Claude call (no quota);
  every tool re-checks the holdings allowlist server-side (`requireHeld`).
- **Saved conversations** (migration `0016_ask_threads`): threads + messages, "Recent
  conversations" list, per-thread delete, 30-day purge (cron `15 4 * * *`). The **server**
  supplies follow-up history (last 3 Q&As) from the thread — clients can't inject turns.
  Routes: `POST /api/reports/ask {question, thread_id?}`, `GET/DELETE /api/reports/threads[/:id]`.
- **Cost controls:** per-tier daily cap from `TIERS[tier].qaPerDay` (Plus 10 / Pro 30); ≤4 tool
  rounds and a 25k input-token budget per question (then a "answer now" note — `tool_choice`
  stays `auto` because changing it invalidates the prompt cache); tool results clamped to 4,000
  chars; automatic prompt caching (Haiku 4.5 only caches prefixes ≥4,096 tokens, so only long
  multi-tool questions benefit); billable cost logged cache-aware; failed runs logged as
  `qa_failed` (counts toward the global $ ceiling, not the user quota).
- Estimates (not yet measured with a real key): typical question ≈ 7k input / 400 output
  tokens ≈ **$0.009**; worst case ≈ **$0.04**; peak context ~15% of Haiku's 200k window.

### Frontend re-theme (tags v1.1 / v2.1)
Light theme from the brand sheet — **colors and type only; SenIQ name/logo unchanged, Zeuniq
stays a separate project.** Royal `#0A2540` (brand, primary buttons), electric `#1E40AF`
(hover/links/text accents), AI cyan `#00C2FF` (gradients/charts only — never text), green
`#14B86A`, red `#EF4444`, neutral sentiment slate `#64748B`, amber only for real warnings;
bg `#F8FAFC`, cards white, borders `#E2E8F0`; Inter (numbers in JetBrains Mono). All tokens are
CSS variables in `public/css/style.css` / `landing.css` `:root` → a dark-mode toggle later is
mostly a second token set. Nav: sliding underline (horizontal) / left accent bar (sidebar).

### Live prices
`FINNHUB_API_KEY` (US stocks + company news) and `FMP_API_KEY` (gold/silver) are set in `.env`
and verified. Crypto via CoinGecko (no key). **Indian stocks: not priced yet** (see §6).

## 4. Environment (`.env` — never commit; names only)

| Variable | Status | Purpose |
|---|---|---|
| `DATABASE_URL`, `PORT` | set | local Postgres `seniq`, port 3010 |
| `STRATEGY_SERVICE_URL`, `STRATEGY_SERVICE_SECRET` | set | v2 engine at :8100 |
| `FINNHUB_API_KEY` | set | US prices + company news |
| `FMP_API_KEY` | set | commodities; US fallback |
| `UPSTOX_ANALYTICS_TOKEN` | **empty** | Indian prices (code not built yet) |
| `ANTHROPIC_API_KEY` | not set | Claude brief + Ask (also needs `CLAUDE_REPORTS`, §6) |
| `HF_API_TOKEN` (+ `FINBERT_CLASSIFY=1`, `NEWS_EMBEDDINGS=1`) | not set | FinBERT sentiment, RAG embeddings |
| `FEATURES_STRATEGIES` | unset = v1 | `1` = v2 |
| `CONGRESS_TRADES_URL` | not set locally | live congress data (set on the deploy host); local uses sample |
| `REDDIT_CLIENT_ID/SECRET`, `SENTRY_DSN` | not set | Reddit ingest, error monitoring |

Full API inventory: price (Finnhub, FMP, CoinGecko, Upstox planned) · news (Finnhub news,
GDELT, RSS: ET/Mint/Moneycontrol/Business Standard, Reddit) · smart money (SEC EDGAR, FMP
congress) · AI (Claude Haiku 4.5, HF FinBERT + MiniLM, optional local Ollama) · infra
(Postgres/Neon, Render, Sentry, Docker) · v2 (FastAPI + yfinance strategy service, MCP, `/v1`).

## 5. Tests & evaluation
- `npm test` — offline, no DB/API calls: 16 + 27 + 23 + **38 (Ask: `test/qa.test.js`)** + 12, all passing.
- **Ask eval set** `eval/ask/cases.json` (uncommitted): 30 cases over a fixture portfolio
  (AAPL, NVDA, BTC, XAU, RELIANCE, TCS) — portfolio moves, holding news, risk, smart money,
  macro, RAG search, education, out-of-scope, advice, data gaps, follow-ups/injection. Graded
  against each run's own tool results (not frozen answers). All 30 route correctly through the
  scope pre-check. **Awaiting your sign-off on the cases**; then: grader (programmatic route /
  tool / no-leak checks + LLM rubric), runner, and a small paid pilot. 30 cases × 2 reps ≈
  ±13-point noise floor — fine for catching real failures, too coarse for small prompt tweaks.

## 6. Open items (priority order)
1. **Turn on real AI answers:** add `ANTHROPIC_API_KEY` **and** flip `CLAUDE_REPORTS` — it is
   hard-coded `false` in `server/config.js`, so a key alone does nothing.
2. **Indian prices via Upstox:** paste the Analytics Token (free, read-only, 1-year expiry;
   Upstox Developer Apps → Analytics → Generate Token), then build the lookup: NSE ticker →
   Upstox instrument key, fetch price + day change, test on RELIANCE/TCS. Treat the token as a
   secret (it can also read account data).
3. **RAG embeddings:** `HF_API_TOKEN` + `NEWS_EMBEDDINGS=1` + pgvector
   (`brew install pgvector` locally; Neon has it). The semantic SQL path has **not run yet**.
4. **Eval:** sign off the 30 cases → build grader + runner → pilot (ask before any paid run).
5. **Visual check of v2 with the engine running** (Builder/Backtest with real content) — the
   preview tool can't start the engine (macOS blocks its venv), so run it in your terminal.
6. **Dark-mode toggle** (tokens are ready).
7. **Realistic demo portfolio quantities** (and add gold so commodities show).
8. Pre-existing quirk: `reports.js` counts **all** of a user's `claude_calls` for the daily-brief
   quota, including Ask questions.

## 7. Where things live
| Area | Files |
|---|---|
| Ask agent / tools / RAG / threads | `server/services/qa.js`, `qaTools.js`, `newsSearch.js`, `askThreads.js`, `server/routes/reports.js` |
| Grounding (fallback answers, attribution) | `server/services/grounding.js` |
| Prices | `server/services/priceService.js`, `portfolioService.js` |
| Pipeline / cron | `server/scheduler.js` |
| Config, tiers, feature flags, caps | `server/config.js` (`FEATURES`, `TIERS`, `QA`, `NEWS_SEARCH`) |
| v1/v2 route gating | `server/index.js` |
| Frontend | `public/index.html`, `public/js/app.js`, `public/css/style.css`; landing: `public/landing.html`, `public/css/landing.css`, `public/js/landing.js`; `public/docs.html` (v2) |
| Tests / eval | `test/qa.test.js`, `eval/ask/cases.json` |

## 8. Pushing to GitHub (when you decide)
- Repo `shreyas-sinha26/SenIQ_MajorProject` is **private**: only the `Annas-Shariff` gh account
  can fetch/push (`gh auth switch --user Annas-Shariff`, push, switch back).
- **Fetch first** — the local `origin/main` ref is from July; teammates may have pushed since.
- Push the commits **and** tags (`v1.0`, `v1.1`, `v2.1`). Commits are authored as Annas
  Shariff with no AI attribution.
- Decide whether `eval/` goes up. `.github/workflows/ci.yml` still can't be pushed until the
  token has the `workflow` scope (`gh auth refresh -h github.com -s workflow`, interactive).
- `strategy-service/` stays gitignored / local-only (your IP) unless you say otherwise.

---

# Earlier sessions (up to 2026-07-06)

## Original handoff (Phases 0–3.5 + Engine E1–E3, later sessions appended)

### Goal
Turn the existing `ai-portfolio-copilot` app into **SenIQ**, a sentiment-driven market
intelligence platform: multi-asset portfolios → news + Reddit + macro sentiment → smart-money
tabs (institutions + politicians) → Free/Plus/Pro tiers → API/MCP server → an agent that delivers
a personalized daily report (Claude) plus immediate alerts on major events. Budget stance:
**cheapest viable** (free data tiers, local FinBERT/Ollama; pay only Stripe/Razorpay + Claude API).
Full phased plan is in `PLAN.md`; long-term context lives in auto-memory
(`~/.claude/projects/-Users-annas-05/memory/`).

**North Star (prioritize): Portfolio Impact Scoring** — the differentiator is exposure-weighted
impact ("this event affects 18% of your portfolio / today's most important event for you"), NOT
raw sentiment. Phase 1 captured the position weights; **Phase 2e now computes the impact score +
per-user ranked feed** (`GET /api/news/impact`); Phase 7 will lead the report with the top-impact
event.

**Working agreement:** ask a short batch of kickoff questions at the START of each phase before
writing any code. Phase 0/1/2/3 kickoffs were asked + answered. **Phase 4 kickoff has NOT been
asked yet.**

**Two biggest markets = US + India.** Pricing is region-aware (see memory).

### Current state of the code — Phase 2 DONE, verified
The app boots on **Postgres** (DB `seniq`, `DATABASE_URL`), runs migrations on boot, ingests from
multiple sources, scores with decay/momentum/z-score, and computes per-user portfolio impact.

**Phase 2 kickoff answers:** news sources = **GDELT + RSS + Reddit** (X stubbed); India prices =
my call → **news-only for now** (no free NSE/BSE spot source wired); FinBERT runtime = **local CPU
batch**; windows = **confirmed 7d half-life + 90d z-score baseline**.

What Phase 2 added:
- **Migration `0003_sentiment_v2.sql`** — `articles.platform` (CHECK enum news|reddit|x|macro,
  default 'news'); `article_sentiments.confidence` (REAL) + `.model` (TEXT default 'lexicon');
  unique idx `uq_article_sentiments_article_ticker` on (article_id, ticker); new table
  `event_portfolio_impact` (user_id, article_id, impact_score, exposure_pct, direction,
  computed_at; UNIQUE(user_id, article_id)) + indexes. Applied cleanly on boot.
- **2a — `server/services/sentimentScoring.js`** (NEW) — pure `computeWindowedSentiment(rows, now)`
  → `{acute, momentum, baseline, magnitude, label}`. Decay-weighted acute (24-72h window,
  `decayWeight = 0.5^(ageHours/168)`), momentum (7d vs 7-14d), 90d z-score baseline (needs ≥5
  points + std>0, else z=null). DB wrapper `scoreTicker(ticker)`. Computed **on read** — the flat
  `sentiment_snapshots` write was removed.
- **2b — `server/services/ingest/*`** (NEW) — `gatherArticles(tickers)` runs enabled sources in
  parallel, dedupes by external_id+url, falls back to demo if all empty. Sources: `gdelt.js`
  (Promise.allSettled, 6s timeout each, macro + India-ticker queries), `rss.js` (dependency-free
  `<item>` parser; ET/Mint/Moneycontrol/Business Standard), `reddit.js` (OAuth client-credentials;
  warns once + returns [] if `REDDIT_CLIENT_ID/SECRET` unset), `x.js` (stub → []), `finnhub.js`
  ([] without key), `demo.js`. `util.js` has hashId/stripHtml/clampText/fetchWithTimeout.
- **2c — source-credibility weights** in `config.SOURCE_WEIGHTS` (bySource Reuters/Bloomberg=1.0,
  Indian feeds=0.8; byPlatform news 0.7 / macro 0.8 / reddit 0.35 / x 0.3), consumed by
  sentimentScoring's weighted average.
- **2d — `server/services/finbertClassifier.js`** (NEW) — lazy `pipeline('text-classification',
  'Xenova/finbert')` via transformers.js (ONNX/CPU). **Env-opt-in `FINBERT_CLASSIFY=1`** (~250MB
  first-run download); `classifyBatch()` chunks of 16, returns null if disabled/unavailable so the
  caller falls back to the lexicon. **Lexicon is the default working path.** Proven correct
  (positive 0.97 / negative 0.04 / neutral 0.5).
- **2e (North Star) — `server/services/impactScoring.js`** (NEW) —
  `impact = Σ_holdings(exposure_weight × magnitude × z_boost)` where `magnitude=|score-0.5|×2`,
  `zBoost=1+0.25·min(|z|,3)`; macro events apply broadly diluted by `MACRO_BROAD_FACTOR=0.5`.
  `recomputeImpacts()` upserts per-user rows + prunes aged-out events; `getImpactFeed(userId)`
  returns the ranked feed (top row = "today's most important event").
- **`server/services/portfolioService.js`** (NEW) — `getWeightedHoldings(userId)`: `weight_pct`
  (honest priced share, null when unpriced — display) + `exposure_pct` (**normalized share across
  ALL holdings, imputes avg priced value for unpriced, sums to ~100** — scoring input).
- **`server/scheduler.js`** (REWRITTEN) — pipeline: gather → classify (FinBERT-if-enabled-else-
  lexicon) → persist articles (+platform) + article_sentiments (upsert confidence/model) → alerts
  → `recomputeImpacts()`.
- **Routes** — `server/routes/news.js`: new `GET /api/news/impact` (`{topEvent, feed}`);
  `/sentiment/:ticker` now includes a `scoring` block. `server/routes/portfolio.js` GET uses
  `getWeightedHoldings`.
- **Frontend** — `public/index.html` "Today's Most Important Events" section (impact-hero +
  impact-list); `public/js/app.js` `loadImpactFeed()`/`renderImpactFeed()` + DIR_ICON, wired into
  dashboard load + 60s refresh; `public/css/style.css` impact-section styles.

**Verified end-to-end on the running app (port 3000)** with a 4-holding test user
(AAPL/RELIANCE/HDFCBANK/BTC): pipeline fetched **124 live RSS articles** (GDELT rate-limited, no
Reddit creds — both degraded cleanly), stored them, generated alerts, computed **420 impact rows**.
`GET /api/news/impact` → top event = "Dividend alert! ... RIL, HDFC AMC ..." at **50% exposure,
positive**; `/sentiment/RELIANCE` → full `scoring` block (acute/momentum/baseline; z=null as
expected on a fresh DB); `/api/portfolio` → BTC weight_pct 100 (sole priced) but **all four
exposure_pct=25, summing to 100**. UI renders the hero + ranked rows correctly ("50% of your
exposure", "2h ago").

### Files actively edited this session
- `server/migrations/0003_sentiment_v2.sql` — NEW.
- `server/config.js` — FEATURES (MACRO/RSS/REDDIT on, X off, FINBERT env-gated), SENTIMENT,
  SOURCE_WEIGHTS, IMPACT, INGEST blocks.
- `server/services/sentimentScoring.js`, `impactScoring.js`, `portfolioService.js`,
  `finbertClassifier.js` — NEW.
- `server/services/ingest/{index,util,gdelt,rss,reddit,x,finnhub,demo}.js` — NEW.
- `server/services/newsFetcher.js` — REWRITTEN (thin lexicon-enrich wrapper over gatherArticles).
- `server/scheduler.js` — REWRITTEN (multi-source pipeline + impact recompute).
- `server/routes/news.js` — `/impact` route + `scoring` in `/sentiment/:ticker`.
- `server/routes/portfolio.js` — GET uses getWeightedHoldings.
- `public/index.html`, `public/js/app.js`, `public/css/style.css` — impact section.
- Memory: `project_seniq.md` (Phase 2 done), `project_india_coverage_gap.md` (news closed, price
  still open).

### Bugs found + fixed during verification
- **`portfolioService` exposure fallback gave every holding `exposure_pct=100`** when only one
  holding was priced (its weight is 100% by definition, and that "average priced weight" was then
  copied to all unpriced holdings). This broke the North Star ("affects 100% of your portfolio" for
  everything). **Fixed:** exposure is now a normalized share across all holdings — unpriced ones are
  imputed the average priced value, everything divided by the imputed total, sums to ~100. Verified:
  4 holdings → 25% each.
- **Hero time-ago showed `NaNd`** — `timeAgo()` does `new Date() - date` and was passed a raw
  string. **Fixed:** wrapped in `new Date(top.published_at)` (matches the other call sites). Verified
  → "2h ago".

### Gotchas / known limitations (NOT bugs)
- **Stale preview server.** `preview_start` reuses a running server and won't pick up new
  migrations/routes — `preview_stop` then `preview_start` to actually restart. (Bit us again this
  session.) Same applies after editing server-side code; static assets (HTML/JS/CSS) just need a
  page reload.
- **`preview_screenshot` returned a 2px-wide sliver** because the viewport had collapsed to
  `innerWidth: 2`. Fix: `preview_resize` with explicit `width/height` (1280×860) before the
  screenshot — the `desktop` preset alone did NOT fix it. `preview_eval` DOM reads are the reliable
  fallback.
- **Baseline z-score is null on a fresh DB** until ≥5 article points accumulate per ticker over 90
  days — expected, fills in over time.
- **FinBERT is OFF by default** (env-gated to avoid the 250MB download); the lexicon path is what
  runs unless you set `FINBERT_CLASSIFY=1`.
- **India equity prices have NO source** (deliberate Phase 2 decision) — Indian holdings price to
  null, show N/A display weight, and rely on the normalized equal-share exposure for scoring.
- **No `FINNHUB_API_KEY` / `REDDIT_CLIENT_ID/SECRET` in `.env`** — equities price null, Reddit
  ingest skips with a one-time warning. All degrade gracefully; RSS alone carries the feed.
- Pre-existing matcher substring quirk (e.g. "Bitcoin" matches `COIN`) — noise, not introduced here.

### Hard constraint — do NOT touch `zeuniq`
Separate, unrelated project: Postgres DB `zeuniq` + app at `~/Downloads/Zeuniq` (frontend launch
config `zeuniq-frontend`). Name resembles SenIQ but it's a different project. Never connect to,
query, modify, or build against it. SenIQ uses the `seniq` DB only. (Firm rule in memory.)

### Phase 3 — Smart-money tracking — DONE, verified

**Phase 3 kickoff answers:** 13F source = **SEC EDGAR direct (free)**; institutions = **top-10 funds**
(seeded); congress source = **free community dataset** (configurable URL + bundled sample); polling +
scope → the user asked "I thought we're using webhooks?" — clarified: **SEC/Congress do NOT push, so
inbound is an emulated webhook (15-min poller); outbound webhooks are a real Pro feature we built.**
Default alert scope = **followed entities + holdings** (not the firehose).

What Phase 3 added:
- **Migration `0004_smart_money.sql`** (NEW) — `institutions` (cik/name/slug/manager; **seeded with 10
  verified CIKs**: Berkshire, ARK, Bridgewater, Scion, Tiger Global, Renaissance, Pershing Square,
  Citadel, Two Sigma, Appaloosa), `institution_filings` (accession UNIQUE, period_of_report vs
  filed_at, holdings_count, total_value), `institution_holdings` (cusip, ticker, issuer, shares,
  value, pct_of_portfolio, change_type; UNIQUE(filing_id, cusip)), `congress_trades` (source_id
  UNIQUE, politician/chamber/party/state, ticker, transaction_date vs disclosure_date, amount range,
  `is_sample`), `followed_entities` (user follows institutions/politicians; UNIQUE per user), and
  `webhooks` (url + per-hook secret, event_types csv, failure_count auto-disable).
- **`server/services/smartMoney/edgar.js`** (NEW) — free EDGAR client: submissions JSON → recent
  13F-HR accessions; filing `index.json` → the info-table XML (the `.xml` that isn't `primary_doc`);
  **dependency-free regex parse** of `<infoTable>` blocks aggregating duplicate CUSIPs per
  sub-manager; value treated as $thousands pre-2023 else whole dollars. UA + 250ms request spacing.
- **`server/services/smartMoney/cusipMap.js`** (NEW) — static CUSIP→ticker for ~50 mega-caps so 13F
  holdings match user portfolios. Unmapped CUSIPs keep issuer name + null ticker (honest gap).
- **`server/services/smartMoney/congress.js`** (NEW) — pluggable: tries `CONGRESS_TRADES_URL`,
  normalizes the common House/Senate stock-watcher field shapes, and **degrades to
  `data/congress_sample.json`** (12 illustrative rows, flagged `is_sample`) so the tab + pipeline work
  in dev. Lookback-windowed; stable `source_id` for dedupe.
- **`server/services/smartMoney/index.js`** (NEW) — orchestrator + event emitter. `pollSmartMoney()`
  runs institutions + congress. **Backfill guard:** first contact ingests silently (no alert blast on
  history); steady state ingests only genuinely NEWLY-DISCLOSED records (13F gated on `filed_at` >
  max stored; congress on new `source_id`). `emitEvent()` fans an event to recipients = users
  **following the entity ∪ holding an affected ticker** → inserts an `alerts` row (type
  `smart_money`) + dispatches outbound webhooks. change_type diff = new/added/reduced/unchanged vs the
  prior quarter's holdings.
- **`server/services/webhookService.js`** (NEW) — outbound delivery: HMAC-SHA256 signed POST
  (`X-SenIQ-Signature: sha256=…`), best-effort/non-blocking, tracks last_status + auto-disables after
  10 consecutive failures.
- **Routes `server/routes/smartMoney.js`** (NEW, mounted at `/api/smart-money`) — `GET /meta`
  (freshness note + sample flag), `GET /institutions` (+latest-filing summary, following flag via
  LATERAL), `GET /institutions/:slug` (top-N holdings + change_type + trade-vs-filing dates),
  `GET /congress?scope=mine|all` (default mine = followed + holdings; all = firehose),
  `GET /follows` + `POST /follow` + `DELETE /follow/:type/:ref`, webhooks `GET/POST/DELETE`,
  `POST /poll` (manual trigger).
- **`server/scheduler.js`** — added `runSmartMoneyPoll()` on its own `*/15 * * * *` cron (staggered
  8s after boot), guarded by `FEATURES.SMART_MONEY`.
- **`server/config.js`** — `FEATURES.SMART_MONEY = true`; new `SMART_MONEY` block (poll cron, SEC UA,
  rate delay, TOP_HOLDINGS, congress lookback + URL, webhook timeout/max-failures); tier flags
  (`smartMoney` teaser/full, `smartMoneyRealtime`, `webhooks`) added to Free/Plus/Pro.
- **Frontend** — `public/index.html` "Smart Money" section with Institutions/Politicians sub-tabs, a
  **legal-lag freshness banner**, a congress scope toggle (Mine / All firehose), a sample-data badge,
  and a collapsible **Pro webhooks manager**. `public/js/app.js` `loadSmartMoney()` + render/follow/
  webhook functions (wired into dashboard load + 60s refresh + `initSmartMoney()`).
  `public/css/style.css` smart-money styles appended.

**Verified end-to-end on the running app (port 3000):** boot applied `0004`, baseline backfill stored
**20 filings / 29,616 holdings / 12 congress (sample) / 0 alerts** (silent baseline — correct). Berkshire's
top book parsed correctly against reality (AAPL 22%, AXP 17.4%, KO 11.6%, BAC reduced, GOOGL added).
Simulated a new disclosure (deleted+re-polled Pelosi NVDA) → **1 insert, 1 alert** delivered to the
NVDA holder ("Rep. Nancy Pelosi (D-CA) bought NVDA …"). Follows persist across restart; webhooks create
with a one-time secret; congress scope mine=2 vs all=12; bad url/entity_type → 400. **Visual screenshot
not captured** (no preview/headless tooling wired in this environment) — verification was API + asset +
syntax level; the render functions are simple templating over verified shapes.

### Bugs found + fixed during Phase 3 verification
- **Historical 13F filings alerted as "news" on the first steady-state poll.** The baseline guard only
  silenced the 2 most-recent filings; the next poll fetched recent[3]/[4] (older quarters), saw them as
  "not in DB", ingested them and **fired alerts for year-old filings**. **Fixed:** steady-state now
  ingests/alerts only filings with `filed_at` newer than the max already stored for that fund; a
  late-fetched older filing is skipped, so it can't masquerade as a new disclosure. Re-verified: a
  follow-up poll is silent (0 new, 0 alerts).

### Phase 3 known limitations / gotchas (NOT bugs)
- **Live congress data needs a source decision (see "What I need from you").** Right now it runs on the
  bundled sample; institutions (EDGAR) is fully live.
- **CUSIP→ticker is a ~50-name static map.** Holdings outside it show the issuer name with a null
  ticker and won't match a user's portfolio for alerting. A full map needs a paid CUSIP DB.
- **Tier gating not enforced yet** (no `subscription_tier` column until Phase 4). Smart-money routes +
  webhooks are open to any authenticated user; the Free-teaser / Plus-full / Pro-webhooks split lands
  with the Phase 4 gating middleware. Tier flags are already in `config.TIERS`.
- **Amendments (13F-HR/A) are skipped** — we track the primary quarterly book only.
- Scion/Appaloosa file sporadically, so their "latest" period may be older than Q1 — expected.

### Phase 3.5 — News Relevance & De-spam — DONE, verified

**Why inserted before Phase 4:** the feed and alert path both spammed (dedupe was URL/id-only,
so the same event from 4 outlets stored 4×; RSS pulled whole feeds so generic filler reached every
user; the alert engine fired per-article/per-ticker on raw thresholds). No point gating/charging
(Phase 4) for a noisy feed. **Kickoff answers (all "recommended"):** scope = feed **and** alerts;
strictness = **balanced**; world bucket = market-moving world events scored off the existing
GDELT+RSS (no new source); storage = **keep all articles, flag relevance** (preserves the z-score
baseline + lets thresholds be re-tuned without re-fetch).

**The goal (user's words):** don't spam with irrelevant or repeating news — just (1) important
market news that applies to everyone, (2) news about their holdings, (3) major world affairs.

What Phase 3.5 added:
- **Migration `0005_news_relevance.sql`** (NEW) — `articles` gains `cluster_key`, `relevance_tier`
  (CHECK holding|market|world|none), `importance` REAL, `is_relevant` BOOL (default true); `alerts`
  gains `cluster_key` (the per-event dedupe key). Indexes on cluster/relevance/(user,cluster).
  Applied cleanly on boot. **Nothing is deleted** — noise is flagged `is_relevant=false` and just
  hidden from the feed.
- **`server/services/newsRelevance.js`** (NEW) — `classifyArticle(article, matched)` grades each
  article into holding / market / world / none. **Tier is decided by the HEADLINE, not the body**
  (a stocks-highs story whose summary mentions "trade war" is markets, not world — this fixed a real
  misclassification found in verification). importance = keyword-tier weight × source credibility;
  market/world must clear `RELEVANT_THRESHOLD=0.42` ("balanced"), a holding match is always relevant.
  `assignClusters(batch)` gives duplicates one key: exact stemmed-token key (stable across runs for
  verbatim syndication) + greedy union-find merge of same-window articles with stemmed-headline
  Jaccard ≥ `CLUSTER_SIM=0.6` → the same story from GDELT + N RSS feeds collapses to one event.
- **`server/services/materiality.js`** (NEW) — **replaces alertEngine.js's per-article rules**
  (pulled forward from Phase 7). One alert per EVENT cluster per user: holdings =
  `Σ(exposure × magnitude × confidence × z_surprise) × volume` (≥`HOLDING_THRESHOLD=0.35`);
  market/world = `importance × volume` (≥`BROAD_THRESHOLD=0.6`, fired to all). z-surprise is what
  kills "one more bad article on an already-negative name". Dedupe by (user_id, cluster_key), checked
  against existing `alerts` rows so an event never re-fires across runs.
- **`server/config.js`** — `NEWS_RELEVANCE` block (tiered MARKET/WORLD keyword lists, threshold,
  cluster window/tokens/sim; **'ipo' deliberately excluded** from market keywords — small-cap IPO
  subscription updates were the bulk of leaked noise) + `MATERIALITY` block. Both exported.
- **`server/scheduler.js`** — pipeline now grades relevance + clusters the whole batch, persists the
  4 new columns, and calls `generateAlerts()` instead of `processAlerts()`. (`alertEngine.js` left in
  place, now unused.)
- **`server/routes/news.js`** — `GET /api/news/feed` **rewritten DB-backed**: reads persisted
  relevant articles (last 48h), one representative row per cluster (latest, with a `source_count`),
  returns `{ articles, buckets:{holdings, market, world} }`. Holdings bucket = holding-tier stories
  about something THIS user owns (ranked by their impact score); market/world ranked by importance ×
  recency. (`/sentiment` + `/portfolio-sentiment` unchanged, still use the live lexicon path.)
- **Frontend** — `public/js/app.js` renders three labeled buckets (📌 Your Holdings / 📊 Markets /
  🌍 World) with a "+N more" source-count badge per card; search/ticker filter falls back to the flat
  list. `public/css/style.css` got `.news-bucket*` + `.news-source-count` styles.

**Verified end-to-end on Postgres `seniq`** (migrations + real pipeline runs + authenticated API):
124 RSS articles → **120 stored, ~57 (47%) flagged noise and hidden**, tiers holding=53 / market=10
(genuinely broad: Nasdaq/Wall St, Nifty/Sensex moves, Sensex crash, RBI policy, Rupee, IT rout) /
world=0 (GDELT returned 0 this run — world bucket fills from GDELT war/sanctions headlines when it's
up). Clustering diagnostic: **0 stored pairs with Jaccard ≥ 0.5 left in different clusters** (no
missed dups). Synthetic test merged near-identical Reliance-dividend headlines. Alerts are
event-deduped (2 broad events → fanned to users, then silent on re-run = correct cross-run dedup) and
materiality-gated. `GET /api/news/feed` for a fresh RELIANCE holder returned the three buckets;
holdings bucket correctly showed Jio/NSE IPO news (Jio = Reliance alias).

**Phase 3.5 known limitations (NOT bugs):** heavily paraphrased duplicates across outlets (Jaccard <
0.6) stay as separate cards — we kill verbatim/near-verbatim syndication spam, not all paraphrase
(a full fix needs embeddings/minhash). World bucket depends on GDELT being reachable. Keyword lists +
thresholds in `config.NEWS_RELEVANCE` / `config.MATERIALITY` are the tuning knobs. Frontend verified
at API + asset + syntax level (SPA auth wall + documented preview flakiness — no browser screenshot).

### UI restructure (2026-06-20) — top-level page tabs
Smart Money used to sit mid-page on the single dashboard, sharing the page with the multi-asset
portfolio. Per the user, it's now split into **top-level page tabs** at the top of the app:
**📊 Dashboard** (portfolio + impact + news + alerts + chart + analyzer), **🏛️ Institutions**
(big firms / 13F), **🗳️ Congress** (politician trades + the Pro webhooks panel). `public/index.html`
wraps each in a `.page` div (`#page-dashboard|institutions|congress`) under a `.main-tabs` nav; the
old in-section `.sm-tabs` sub-tabs are gone. `public/js/app.js` `initMainTabs()` toggles `.page`
visibility + lazy-reloads the smart-money pages on entry (`smActiveTab` removed; follow-change now
refreshes congress only when that page is visible). `.main-tab(s)` styles added in `style.css`
(replacing the old `.sm-tab` rules). Verified in-browser: all three tabs switch, Institutions shows
the fund cards, Congress shows scope toggle + a Pelosi/AAPL disclosure (mine-scope matched the
holder), no console errors.

### Roadmap (2026-06-20) — re-sequenced, see SenIQ_Roadmap.pdf
A full roadmap PDF now lives at `SenIQ_Roadmap.pdf` (regenerate with
`python3 scripts/build_roadmap_pdf.py`). It **supersedes the phase ordering in PLAN.md** because two
launch blockers — **OAuth** and **Stripe/Razorpay billing** — both need a public domain over HTTPS
(OAuth callbacks + payment webhooks). So cloud deployment is pulled to the front:

- **Phase 4 — Cloud Deployment, Domain & HTTPS (NEW, do first):** managed PaaS (Render/Fly), managed
  Postgres (move off local `seniq`), register a domain + DNS, auto-TLS + force HTTPS, secrets → host
  env vars (rotate JWT secret for prod), CI/CD auto-deploy + migrations on deploy, health check +
  logging + Sentry + DB backups.
- **Phase 5 — Auth & Accounts / OAuth (NEW):** Google (then optional GitHub) Authorization-Code flow,
  callback `https://<domain>/api/auth/oauth/<provider>/callback`, link OAuth identity to user by
  verified email, email verification + password reset, JWT hardening. Depends on Phase 4.
- **Phase 6 — Tiers & billing** (the old Phase 4): gating middleware + `subscription_tier` (finally
  enforces the smart-money tier split), Stripe US + Razorpay India, region-gate by card BIN, Claude
  cost guardrails. Depends on Phase 4 (webhooks).
- **Phase 7 — Strategies** (old 5) · **Phase 8 — API/MCP** (old 6) · **Phase 9 — Agent: daily report
  + alerts** (old 7; materiality alerting already shipped in 3.5, so this is Claude narrative +
  email delivery).

Sequencing: **4 → (5, 6 in parallel) → 7 → 8 → 9.** Cross-cutting: email provider (Resend/SES),
monitoring/backups, Terms+Privacy before billing, live-congress data source still open.

### Engine track (owned solo) — see ENGINE_PLAN.md
The user owns the **intelligence engine + alerts + reporting** and wants it perfect. Locked plan in
`ENGINE_PLAN.md` (6 phases E1–E6 + a live-refinement testing approach + v2 scope). Key decisions made
in discussion: **Events become first-class** (the keystone); knowledge "graph" right-sized to a
**curated company reference table** (name/aliases/ticker/**sector**/key execs), capped to ~US 100 /
India 50 / crypto 25, graceful fallback for holdings outside it; **outcome logging from day one →
supervised tuning later, NO reinforcement learning**; testing = offline logic fixtures + live canary
portfolios (labels arrive on their own from price-moves + open/dismiss), tune via config, replay over
stored data. v2 = learned relevance model, opportunity radar, deeper graph (suppliers/competitors),
universe expansion, X/transcripts.

**E1a — Company reference + entity resolution — DONE (2026-06-23), verified.**
- Migration `0006_company_reference.sql` (NEW): `companies` (ticker, name, aliases[], sector,
  asset_class, exchange, country) + `executives` (full_name, ticker, role).
- `server/data/universe.js` (NEW): curated seed — **129 entities** (54 US large-caps, 50 Nifty, 25
  crypto) with sectors + 17 key executives. Expandable toward the caps.
- `server/services/entityResolver.js` (NEW): pure `buildResolver(companies, executives)` +
  DB-backed cached `resolve()` + idempotent `seedUniverse()` (runs on boot in `index.js` after
  migrations). Resolves company names/aliases/UPPERCASE-symbols + **executive→ticker** (key-person w/o
  ticker) + **sector themes** ("IT sector"→Information Technology). Matching rules chosen to kill false
  positives: single-token names match **whole-word** (so "TRON" ≠ "sTRONg"/"elecTRONics"); symbols match
  **uppercase whole-word only** (so "SOL" surges matches, "sole" doesn't); ambiguous common-word names
  (e.g. "visa") only when **Capitalized** (so "US visa limits" ≠ Visa Inc).
- `scheduler.js`: replaced `matchTickers` with the resolver (passes held holdings as fallback for
  non-universe tickers); `__MARKET__` now derived from the relevance tier (market/world/macro) instead
  of keyword matching. `tickerMatcher.js` still used only by `routes/news.js /analyze` (switch later).
- **Tests:** `test/entityResolver.test.js` + `npm test` — **16 checks pass** (incl. the TRON & visa
  regressions). **Bugs found+fixed during build:** (1) "Bitcoin"→COIN (old matcher) — fixed; (2)
  "TRON" substring-matching inside "strong"/"electronics" — fixed via whole-word single tokens; (3)
  travel "visa"→Visa Inc — fixed via capitalized-only ambiguous match.
- **Verified on Postgres:** boot seeds 129 companies/17 execs; pipeline resolves cleanly
  ("Nifty IT slips: TCS, Infosys, Wipro" → all three; HDFC Life → HDFCLIFE+HDFCBANK; Jio → RELIANCE;
  non-universe gold holding → XAU via fallback); dedup holds (2nd run = 0 new, 0 alerts).

**E1b — Persistent events — DONE (2026-06-23), verified.** The keystone: a story is now a durable
remembered thing, not a per-batch cluster.
- Migration `0007_events.sql` (NEW): `events` table (id, cluster_key UNIQUE, title/url/source,
  relevance_tier, **event_type** default 'unknown' (E2 fills), importance, primary_ticker, source_count,
  first_seen/last_seen). `articles.event_id` FK. **Re-keyed `event_portfolio_impact` from article_id →
  event_id** (dropped old col/constraint, added UNIQUE(user_id,event_id); old rows cleared — recompute
  repopulates). Added `alerts.event_id`.
- `server/services/events.js` (NEW): `upsertEvents()` — set-based, runs every pipeline pass after
  article persist. (1) upserts one event per cluster_key from recent relevant articles (representative
  = highest-importance/newest; source_count/first/last_seen aggregated; first_seen kept as earliest,
  last_seen as latest), (2) sets primary_ticker = most-mentioned non-macro ticker, (3) attaches
  articles via event_id, (4) prunes events older than `EVENTS.WINDOW_DAYS` (7) — cascades impacts.
- `config.js`: new `EVENTS.WINDOW_DAYS = 7`.
- `scheduler.js`: calls `upsertEvents()` between article-persist and alerts/impact.
- `impactScoring.js`: `loadRecentEvents()` now groups **durable events** (join events→articles→
  article_sentiments, avg score per ticker, isMacro from tier/platform); upserts on event_id; pruning
  is automatic via FK cascade. `getImpactFeed` joins `events`.
- `materiality.js`: `loadRecentClusters()` loads events; alerts dedupe by **(user_id, event_id)**;
  insert writes event_id (no more cluster_key/article_id on the alert).
- `routes/news.js` `/feed`: reads one row per **event**, attaches tickers/sentiment via `event_id`,
  impact via event_id → same 3 buckets.
- **Verified on Postgres:** 0007 applied; pipeline built **103 durable events** (71 holding/30 market/
  2 world), 103 articles attached; impact = 153 rows across 27 events/7 users keyed on event_id;
  run-2 dedup = 0 new/0 alerts; HTTP `/api/news/feed` for a fresh RELIANCE/TCS/BTC user returned the 3
  buckets with stable event ids (holdings: TCS/Jio events). `npm test` still 16/16.
- **Note (for E3):** run-1 fired ~77 alerts (~11 events × 7 users) — too many *per user*; that's the
  per-user volume **E3 alert budgets** will cap (thresholds in `config.MATERIALITY` are also tunable).
  Today's RSS had no duplicate headlines so every event is source_count=1 (clustering proven earlier).

**E2 — Event typing + 6-factor impact — DONE (2026-06-24), verified.**
- Migration `0008_event_typing.sql` (NEW): `articles.sectors TEXT[]` + `events.sectors TEXT[]` (event_type
  already on events from 0007); index on event_type.
- `server/services/eventTyping.js` (NEW): pure `classifyEventType(title, summary, tier)` → one of
  ma/legal/disruption/executive/earnings/guidance/rating/insider/product/macro/other (ordered rules,
  highest-severity first). `severityFor(type)` reads `config.EVENT_TYPES.SEVERITY`.
- `config.js`: `EVENT_TYPES.SEVERITY` (ma 1.0 … rating 0.4 … other 0.3) + `IMPACT` factor knobs
  (SECTOR_RELEVANCE 0.4, NOVELTY_BASE/GAIN, CONFIDENCE_FLOOR, RECENCY_FLOOR; MACRO_BROAD_FACTOR reused
  as macro relevance).
- `events.js upsertEvents()`: added step 4 (aggregate article sectors → `events.sectors`) + step 5
  (type each recent event from its representative title).
- `impactScoring.js`: **rewrote impact to the 6-factor model** —
  `impact(holding) = exposure × relevance × severity × novelty × confidence × recency`, where
  relevance = 1.0 direct / SECTOR_RELEVANCE sector-match / MACRO_BROAD_FACTOR macro; severity =
  type-weight × |score-0.5|×2; novelty from z-surprise; recency = decay on last_seen. Each holding
  scored by its strongest link (direct > sector > macro), no double-count. `recomputeImpacts` now passes
  holdings enriched with **sector** (ticker→sector from companies) so sector-wide events touch sector
  holdings. **db/portfolioService lazy-required** so the pure `impactForEvent` is testable without a DB.
- **Tests:** `test/engine.test.js` (NEW) — 10 typing + 6 impact checks; `npm test` now runs both suites
  = **32 checks pass**. Bug fixed during build: "cuts target price" (analyst) was typing as guidance →
  moved analyst-target keywords to `rating`.
- **Verified on Postgres:** pipeline typed events (macro 33 / legal 4 / ma 4 / earnings/guidance/
  product/disruption / other 45), 19 events carry sector themes, impact now **75 distinct scores
  spanning 0.001–0.523** (was ~flat 0.5) — the 6-factor model differentiates. On a market-selloff day
  macro events legitimately top the feed.
- **Tuning notes (live loop, not bugs):** the lexicon over-scores bland macro headlines ("Rupee 1 paise
  lower") — FinBERT or a lower macro severity fixes it; relevance-tier still has occasional
  summary-driven edge artifacts (e.g. a micro-cap mis-tagged world). Both are config/live-refinement.

**E3 — Alert budgets + outcome logging — DONE (2026-06-24), verified.**
- Migration `0009_alert_budgets_outcomes.sql` (NEW): `alerts.delivery` ('realtime'|'digest' CHECK) +
  `alerts.dismissed`; `event_outcomes` table (per-event feature snapshot + 1d/3d price move + label).
- `config.js`: `ALERT_BUDGET` (MAX_REALTIME_PER_DAY 5, PER_TICKER_COOLDOWN_HOURS 12, quiet-hours block
  gated off until per-user TZ) + `OUTCOMES.MATERIAL_MOVE_PCT 0.03`.
- `materiality.js`: pure **`planDeliveries(candidates, state)`** — sorts a user's candidates by priority,
  gives the top MAX_REALTIME_PER_DAY 'realtime', rest 'digest'; per-ticker cooldown + quiet-hours →
  digest; MARKET skips cooldown but counts to budget. `generateAlerts` gathers today's realtime count +
  cooldown tickers from DB, calls planDeliveries, inserts with `delivery`, returns `{total, realtime}`.
  Nothing is dropped — over-budget items are still recorded as digest. **db/portfolioService now
  lazy-required** so planDeliveries is unit-testable.
- `server/services/outcomes.js` (NEW): `logEventFeatures()` snapshots per-event features
  (type/severity/source_count/sentiment/z/max_impact + price_at_event) into `event_outcomes`;
  `resolveOutcomes()` fills 1d/3d price + move + `materially_moved` once events reach that age. Price
  resolves only where a feed exists (crypto via CoinGecko; US equities need a Finnhub key; India null) —
  degrades gracefully. Engagement labels = `alerts.read`/`dismissed`.
- `scheduler.js`: step 7 calls logEventFeatures + resolveOutcomes. `routes/news.js`: new
  `PUT /alerts/:id/dismiss`.
- **Tests:** `test/engine.test.js` +6 budget checks (priority cap, cooldown, daily cap, MARKET, quiet
  hours, overnight wrap) → `npm test` = **38 checks** (16 resolver + 22 engine).
- **Verified on Postgres:** delivery split works (low-volume run = all under cap; planDeliveries unit-
  tested for the cap path); 55 outcomes logged (39 with z, price where feeds exist), 5 price-resolved.
- **Bug found+fixed during verification:** **stale impact rows** — events live 7 days (clustering) but
  the impact feed window is 72h; aged events kept stale impact scores (saw a 0.523 on a low-severity
  'other' event = above its ceiling, 153 stale rows). Restored an explicit prune in `recomputeImpacts`
  (delete impacts for events with last_seen older than EVENT_WINDOW_HOURS). After fix: 0 stale rows, 0
  impossible impacts, max impact a sane 0.212. (This had been silently inflating "today's most important
  event.")

**E4 — New-holding onboarding — DONE (2026-06-28), verified.** Adding a holding now feels smart:
silent backfill (no alert blast for history), an instant company brief, and a per-holding watermark so
only post-add events can alert.
- **Decisions (user delegated all three):** brief = **deterministic/hybrid** (assembled from engine
  data, shaped for E5 to feed Claude later — **no Claude call in E4**); backfill = **reuse stored
  events** (no fresh per-ticker fetch); watermark = **new `portfolio.monitoring_since` column** (not
  overloading `added_at`).
- Migration `0010_onboarding.sql` (NEW): `portfolio.monitoring_since TIMESTAMPTZ NOT NULL DEFAULT now()`
  + index; existing rows aligned to `added_at` so the migration doesn't silence legit post-add events.
- `server/services/onboarding.js` (NEW): `onboardHolding(userId, ticker, holding)` = silent backfill +
  brief; `buildCompanyBrief()` (read-only, reused by the GET endpoint) assembles a structured packet —
  company reference (sector/exchange/country/aliases/execs), current sentiment (acute/momentum/z), the
  holding's recent typed events (last 7d), this user's impact row, light smart-money (funds holding it +
  congress trades), `in_universe` flag + a "monitoring from here on" note. Degrades gracefully for
  non-universe holdings and missing sources.
- `impactScoring.js`: added **`recomputeImpactsForUser(userId)`** — scoped silent backfill (impact only,
  no alerts, no other users) over the 72h event window.
- `materiality.js`: pure **`isPostWatermark(eventFirstSeen, watermark)`** gate; `loadRecentClusters` now
  selects `e.first_seen`; `generateAlerts` loads per-(user,ticker) watermarks (+ per-user earliest) and
  **skips holding alerts whose event predates the holding's `monitoring_since`** and **market/world
  alerts that predate the user's earliest watermark** (so a brand-new user isn't blasted with pre-join
  events). Nothing is hidden from the feed — only alerts are gated.
- `config.js`: `ONBOARDING` block (BRIEF_EVENTS 5 / BRIEF_EVENT_DAYS 7 / BRIEF_SMART_MONEY 3).
- `routes/portfolio.js`: `POST /` returns `{holding, brief}` (onboarding best-effort, never blocks the
  add); new **`GET /api/portfolio/:ticker/brief`** to re-fetch.
- **Tests:** `test/engine.test.js` +5 `isPostWatermark` checks → `npm test` = **43 checks** (16 resolver
  + 27 engine).
- **Verified on Postgres `seniq` (live API + DB):** boot applied `0010`; added RELIANCE for a fresh user
  → brief came back fully populated (Energy/NSE/IN, alias "jio", exec Mukesh Ambani, sentiment
  acute 0.67 / z −0.48 / 34 pts, 5 typed events, **backfilled impact 0.424**, honest smart-money gap);
  **17 impact rows** written silently, **0 alerts**. Watermark gate proven both directions: **holding**
  (SBIN event, watermark after event → 0 alerts, rewound before → 1 fires) and **market/world**
  (watermark=now suppressed 2 broad events; rewound → both fired). `GET /:ticker/brief` returns the same
  packet. Test users cleaned up afterward.
- **Note:** RELIANCE's holding *materiality* scored 0 (below the 0.35 alert threshold) on this data, so
  its alert wouldn't fire regardless of the watermark — orthogonal to E4; the gate was proven on SBIN,
  which clears the threshold.
- **UI wired (2026-06-28):** the brief now surfaces in the product. `public/index.html` got a
  `#brief-modal`; `public/js/app.js` `renderBrief()/showBrief()/openBriefFor()` + `initBriefModal()` —
  the brief pops automatically after a successful add (`addStock` shows `res.brief`), and each holding
  card gained an "ℹ" button that re-fetches via `GET /:ticker/brief`. `public/css/style.css` has the
  `.brief-*` styles. **Verified in-browser** (port 3000, 1280×860): adding RELIANCE auto-opened the
  brief (Energy·NSE·IN, Mukesh Ambani, sentiment grid positive/0.67/flat/−0.48, impact hero "100%
  exposure", 5 typed events NEWS/LEGAL with time-ago, monitoring note); the card "ℹ" re-opens it via the
  GET path; no console errors. Test user cleaned up, preview stopped.

**E5 — The analyst voice (daily brief) — DONE (2026-06-28), verified.** Claude (Haiku) writes a daily
brief grounded entirely in the user's holdings, led by "what changed since yesterday" + the single most
important event. In-app delivery only (email is Phase 9).
- **Decisions (kickoff):** model = **Haiku 4.5** (`claude-haiku-4-5`); wiring = **build behind flag +
  fallback** (user adds the key after); scope = **daily brief first** (alert narratives later);
  delivery = **in-app only**.
- **SDK:** added `@anthropic-ai/sdk` (0.106.0). Consulted the `claude-api` skill — Haiku has no `effort`
  param and a routine brief needs no extended thinking, so `thinking` is omitted; the **static system
  prompt is prompt-cached** (`cache_control: ephemeral`); `max_tokens` capped at 1800.
- Migration `0011_daily_briefs.sql` (NEW): `daily_briefs` (user_id, brief_date, packet JSONB, narrative,
  headline, writer, model; UNIQUE(user_id,brief_date) — cache + diff baseline) + `claude_calls`
  (per-call token/cost log driving the per-user quota + global kill-switch, no separate counter table).
- `server/services/grounding.js` (NEW): `buildGroundingPacket(userId, prevPacket)` assembles top
  holdings (by exposure, with sentiment/z), top impact events, most_important, light smart-money, and a
  pure **`buildDiff(today, prev)`** (new/dropped events, impact-rank moves, sentiment swings — the diff
  is the engine's job).
- `server/services/briefWriter.js` (NEW): `writeBrief(packet, {allowClaude})` — Claude writer (cached
  system prompt, grounded JSON packet, `parseClaudeOutput` splits HEADLINE) with a pure deterministic
  template fallback. Falls back on ANY Claude error so a brief always ships.
- `server/services/reports.js` (NEW): orchestration + pure **`guardCheck(state)`** (flag → key → global
  kill-switch → per-user quota). `generateBriefForUser` (cache-or-generate, logs cost only on a real
  Claude call), `generateDailyBriefs` (cron entry over all users), `getLatestBrief`.
- `config.REPORTS` (MODEL, CRON `30 5 * * *`, MAX_OUTPUT_TOKENS 1800, TOP_HOLDINGS/EVENTS, PER_USER_DAILY_QUOTA 1,
  GLOBAL_DAILY_USD_CEILING 5, Haiku PRICE_PER_MTOK). `FEATURES.CLAUDE_REPORTS` stays **false** until the
  key is added. `.env.example` documents `ANTHROPIC_API_KEY`.
- `routes/reports.js` (NEW, mounted `/api/reports`): `GET /daily` (latest, generates if missing —
  idempotent per day, not a loopable Claude trigger), `POST /daily/generate` (force; quota still applies
  so repeats fall back to the free writer — never runaway). `scheduler.js`: daily `runDailyBriefs` cron.
- **Frontend:** `public/index.html` "Your Daily Brief" panel atop the dashboard; `public/js/app.js`
  `loadDailyBrief()/renderDailyBrief()/refreshDailyBrief()` (date, writer badge, change chips, headline,
  narrative; wired into dashboard load + a ↻ Refresh button); `public/css/style.css` `.brief-section`/
  `.daily-brief`/`.brief-chip` styles.
- **Tests:** `test/reports.test.js` (NEW, +16: guardCheck, buildDiff, deterministic writer,
  parseClaudeOutput) → `npm test` = **59 checks** (16 resolver + 27 engine + 16 reports).
- **Verified on Postgres `seniq`:** boot applied `0011` + registered the brief cron. No key →
  `GET /api/reports/daily` returned a deterministic brief grounded in real holdings (49.9% exposure,
  impact 0.207, "first brief"), guard reason `claude_reports_disabled`. Seeded a fake yesterday packet
  → diff correctly flagged 6 new events + dropped the stale one, narrative led with the change. **Claude
  path proven:** flag on + (bad) key → guard allowed, the real SDK call fired (401 with a genuine
  `request_id`), then fell back to deterministic with **no** `claude_calls` row logged (errored call not
  billed). UI verified in-browser (panel renders headline/chips/narrative atop the dashboard; ↻ Refresh
  works; no console errors). Test users cleaned up, preview stopped.
- **To activate Claude:** put `ANTHROPIC_API_KEY` in `.env` and set `FEATURES.CLAUDE_REPORTS = true`.

**E6 — Ask it anything — DONE (2026-06-28), verified.** Natural-language portfolio Q&A answered by
Claude (Haiku), grounded STRICTLY on the user's engine data, citing the numbers. In-app only.
- **Decisions (kickoff, all recommended):** **single-shot** (stateless, grounded per question);
  **10 questions/user/day** hard cap; **deterministic data-answer fallback** when Claude is
  unavailable; **extended grounding** (all holdings + fuller impact feed + sentiment + smart-money).
- `config.QA` (MODEL haiku, MAX_OUTPUT_TOKENS 1000, PER_USER_DAILY_QUESTIONS 10, MAX_QUESTION_CHARS 500,
  TOP_EVENTS 10, MAX_HOLDINGS 30). Same `FEATURES.CLAUDE_REPORTS` flag + REPORTS global $/day
  kill-switch + `claude_calls` cost log (kind='qa') as E5 — no new table.
- `grounding.js`: `topHoldings(userId, limit)` parameterized + new **`buildQAContext(userId)`** (all
  holdings up to cap, fuller feed, smart-money — so "biggest risk?" sees the whole book).
- `server/services/qa.js` (NEW): pure `sanitizeQuestion` (clamp/collapse) + `deterministicAnswer`
  (intent-aware grounded digest: risk / down / improving / general, cites exposure + sentiment).
  `answerQuestion(userId, q)` — clamps → builds context → **guardCheck** (reused from reports;
  counts today's kind='qa' calls vs the 10/day cap, global kill-switch) → Claude (cached system prompt,
  strict-grounding, no-advice) and logs cost, else deterministic. Returns `{answer, writer, quota}`.
- `routes/reports.js`: `POST /api/reports/ask` (empty question → 400). Frontend: "Ask About Your
  Portfolio" panel under the daily brief — input + example chips + answer area + "N/10 left today"
  counter (`public/index.html`, `app.js` `askPortfolio()/initAsk()`, `style.css` `.ask-*`).
- **Tests:** `test/reports.test.js` +7 (sanitize, deterministicAnswer intents) → `npm test` = **66
  checks** (16 resolver + 27 engine + 23 reports).
- **Verified on Postgres `seniq`:** no key → 3 questions returned intent-correct grounded answers
  (risk→AAPL/BTC negative; improving→RELIANCE; down→negative concentration), each leading with the
  most-important event + citing exposure/impact; empty question → 400. Guardrails proven: flag+bad key →
  guard allowed, real Claude 401 (`request_id`), graceful fallback, no qa row logged; **10 qa calls →
  guard `user_quota_exceeded`, 0 remaining** (anti-runaway cap holds). UI verified in-browser (chip →
  grounded answer, writer badge, quota counter; no console errors). Test user cleaned up, preview stopped.
- **To activate Claude (E5 + E6):** set `ANTHROPIC_API_KEY` in `.env` + `FEATURES.CLAUDE_REPORTS = true`.

### Engine track COMPLETE — E1–E6 all shipped + verified
The locked `ENGINE_PLAN.md` v1 is done end-to-end: durable events + entity resolution (E1), event
typing + 6-factor impact (E2), alert budgets + outcome logging (E3), smart new-holding onboarding (E4),
the Claude analyst voice / daily brief (E5), and grounded NL Q&A (E6). Remaining engine work is the
**v2 scope** in ENGINE_PLAN.md (learned relevance model on the logged outcomes, opportunity radar,
deeper supplier/competitor graph, universe expansion, X/transcripts) — none started. The live-refinement
testing loop (canary portfolios, config-tuned thresholds, replay over stored data) runs continuously.

### Next (product track, separate from the engine)
Per the re-sequenced roadmap, the product track resumes at **Phase 4 — Cloud Deployment, Domain &
HTTPS** (NOT yet started; kickoff Qs unasked — Render vs Fly vs VPS, domain/registrar, managed Postgres
provider, cron in-process vs worker). Phases 5 (OAuth), 6 (tiers/billing — finally enforces the
smart-money + report/QA tier split and the per-tier quotas E5/E6 stubbed), 7 (strategies), 8 (API/MCP),
9 (agent email delivery) follow. The engine work above feeds Phase 9's report/alert delivery.

### Session 2026-06-30 — GitHub unification + Congress live + Phase 6 + scaffolds

This session merged the solo engine track onto the **team GitHub repo**
`shreyas-sinha26/SenIQ_MajorProject` and shipped several product features. Repo + account
notes: push only via the **`Annas-Shariff`** gh account (`annas05shariff` is pull-only → 403);
commit author `Annas Shariff <annasshariff05@gmail.com>`.

**1. Engine unified onto the GitHub base.** GitHub had Phase 4 cloud-deploy artifacts
(`render.yaml`, `DEPLOY.md`, `observability.js`/Sentry, prod-hardened `index.js`), a Phase 5
landing page + 5-page nav + profile, and FinBERT on the **HuggingFace Inference API**. Local had
the full engine (E1–E6). Merged GitHub-base + grafted the engine: 9 engine services + migrations
0006–0011 + reports route + universe + tests are pure adds; took the engine versions of the
shared backend files (scheduler/config/impactScoring/materiality/news/portfolio), folded in the
Phase-4 `captureException` + `seedUniverse` + landing route; kept HF FinBERT, dropped local
transformers; integrated the engine UI (daily brief, Ask, brief modal) into the 5-page frontend.
Verified clean boot (all migrations + seed), `npm test` 66/66, UI in-browser.

**2. Congress data now LIVE.** Was on the bundled sample; now uses **Financial Modeling Prep**
(`/stable/senate-latest` + `/stable/house-latest`, comma-separated in `CONGRESS_TRADES_URL`).
`congress.js` extended to parse the FMP shape (firstName/lastName→politician, symbol→ticker,
assetDescription, dateRecieved) + multi-URL fetch + chamber stamped from the URL. FMP free tier:
single-symbol/stable endpoints only (v4 + batch are dead/premium), ~250 calls/day.

**3. Search bars** on Institutions (by fund/manager) and Congress (by politician/ticker/company)
— client-side filters over the loaded lists.

**4. Phase 6 — Tiers & billing — DONE (see PLAN.md).** Migration 0012 (`subscription_tier`,
`is_admin`, fwd-compat billing cols); tier read **per-request from the DB, not the JWT**;
`middleware/tier.js`; gating on holdings cap / smart-money teaser / impact-feed depth / AI
Workspace; `routes/admin.js` + `routes/billing.js` (checkout is a **dev stub** — flips tier
directly; real Stripe/Razorpay at deploy); nav **tier switcher** for `is_admin`; `seedAdmin.js`
seeds `admin@seniq.local` from `ADMIN_PASSWORD`. Plans/upgrade UI on the profile page.

**5. Strategies sidebar scaffold.** New nav group with **Strategy Builder / Your Strategies /
Backtest / Paper Trade** + placeholder pages — the shell for Phase 7.

**6. Live prices next to each holding.** `priceService.js` now returns price + day-change %:
crypto via CoinGecko (24h change, no key), equities via **Finnhub** (if `FINNHUB_API_KEY`) else
**FMP** `/stable/quote` (single-symbol, cached 5 min vs the shared 250/day budget), commodities
via FMP (gold/metals work; oil is premium → use yfinance later). `FMP_API_KEY` env added. UI
shows `$price ▲/▼ chg%` next to the ticker.

**Activation knobs:** `ANTHROPIC_API_KEY`+`FEATURES.CLAUDE_REPORTS=true` (Claude brief/Q&A);
`HF_API_TOKEN`+`FINBERT_CLASSIFY=1` (FinBERT); `FINNHUB_API_KEY` (unthrottled US prices);
`FMP_API_KEY`+`CONGRESS_TRADES_URL` (congress + FMP prices); `ADMIN_PASSWORD` (admin account).

### Next — Phase 7 (Strategies) + Phase 8 (MCP) — see STRATEGY_PLAN.md
The Strategies scaffold needs the real engine. **Locked decisions:** reuse the **zeuniq Python
engine as a separate strategy service** (backtest + paper only; live/Dhan stays in zeuniq);
data = **Finnhub** (US live), **yfinance** (India + commodities + backtest), CoinGecko/Binance
(crypto), Dhan (India, from zeuniq); the visual builder mixes **technical factors** (EMA/RSI/MACD)
with **SenIQ signal factors** (sentiment/z-score/smart-money/impact) in one strategy schema; the
**MCP server (Phase 8)** is the signal-delivery bridge feeding SenIQ signals into the engine and
exposing tools to external agents. Honest caveat: technical backtests go back years, but
SenIQ-signal backtests are limited to SenIQ's recorded history (grows over time). Full design,
schema sketch, and data adapters in **`STRATEGY_PLAN.md`**.

Still open product-side: **Phase 4 cloud deploy** (artifacts exist; not confirmed live) and
**Phase 5 OAuth** (Google/GitHub — not built; the teammates' "Phase 5" was nav/profile UI, not
sign-in). Email provider (Resend/SES) still needed for OAuth verification + Phase 9 alerts.
