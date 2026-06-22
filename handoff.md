# Handoff — SenIQ (Phase 3 + 3.5 complete)

## Goal
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

## Current state of the code — Phase 2 DONE, verified
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

## Files actively edited this session
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

## Bugs found + fixed during verification
- **`portfolioService` exposure fallback gave every holding `exposure_pct=100`** when only one
  holding was priced (its weight is 100% by definition, and that "average priced weight" was then
  copied to all unpriced holdings). This broke the North Star ("affects 100% of your portfolio" for
  everything). **Fixed:** exposure is now a normalized share across all holdings — unpriced ones are
  imputed the average priced value, everything divided by the imputed total, sums to ~100. Verified:
  4 holdings → 25% each.
- **Hero time-ago showed `NaNd`** — `timeAgo()` does `new Date() - date` and was passed a raw
  string. **Fixed:** wrapped in `new Date(top.published_at)` (matches the other call sites). Verified
  → "2h ago".

## Gotchas / known limitations (NOT bugs)
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

## Hard constraint — do NOT touch `zeuniq`
Separate, unrelated project: Postgres DB `zeuniq` + app at `~/Downloads/Zeuniq` (frontend launch
config `zeuniq-frontend`). Name resembles SenIQ but it's a different project. Never connect to,
query, modify, or build against it. SenIQ uses the `seniq` DB only. (Firm rule in memory.)

## Phase 3 — Smart-money tracking — DONE, verified

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

## Bugs found + fixed during Phase 3 verification
- **Historical 13F filings alerted as "news" on the first steady-state poll.** The baseline guard only
  silenced the 2 most-recent filings; the next poll fetched recent[3]/[4] (older quarters), saw them as
  "not in DB", ingested them and **fired alerts for year-old filings**. **Fixed:** steady-state now
  ingests/alerts only filings with `filed_at` newer than the max already stored for that fund; a
  late-fetched older filing is skipped, so it can't masquerade as a new disclosure. Re-verified: a
  follow-up poll is silent (0 new, 0 alerts).

## Phase 3 known limitations / gotchas (NOT bugs)
- **Live congress data needs a source decision (see "What I need from you").** Right now it runs on the
  bundled sample; institutions (EDGAR) is fully live.
- **CUSIP→ticker is a ~50-name static map.** Holdings outside it show the issuer name with a null
  ticker and won't match a user's portfolio for alerting. A full map needs a paid CUSIP DB.
- **Tier gating not enforced yet** (no `subscription_tier` column until Phase 4). Smart-money routes +
  webhooks are open to any authenticated user; the Free-teaser / Plus-full / Pro-webhooks split lands
  with the Phase 4 gating middleware. Tier flags are already in `config.TIERS`.
- **Amendments (13F-HR/A) are skipped** — we track the primary quarterly book only.
- Scion/Appaloosa file sporadically, so their "latest" period may be older than Q1 — expected.

## Phase 3.5 — News Relevance & De-spam — DONE, verified

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

## UI restructure (2026-06-20) — top-level page tabs
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

## Roadmap (2026-06-20) — re-sequenced, see SenIQ_Roadmap.pdf
A full roadmap PDF now lives at `SenIQ_Roadmap.pdf` (regenerate with
`python scripts/build_roadmap_pdf.py` on Windows; `python3 …` on macOS/Linux). It **supersedes the phase ordering in PLAN.md** because two
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

## Next step
Start **Phase 4 — Cloud Deployment, Domain & HTTPS** (see `SenIQ_Roadmap.pdf`). Per the working
agreement, ask the Phase 4 kickoff questions first: Render vs Fly vs VPS; which domain + registrar;
managed Postgres provider; keep node-cron in-process or split a worker. (The old "Phase 4 = billing"
is now **Phase 6**.) Per the working agreement, **ask the Phase 4
kickoff questions first** (final price points + annual discount; Stripe/Razorpay readiness; global
daily kill-switch $ ceiling; region-gate by card BIN). Phase 4 adds `subscription_tier` + gating
middleware, which is what finally enforces the smart-money tier split (Free teaser / Plus+ full /
Pro webhooks) that Phase 3 left open. (Phases 3 and 4 were planned to run in parallel — 3 is done.)
