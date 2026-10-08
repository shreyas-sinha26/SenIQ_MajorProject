# SenIQ — Handoff

Rewritten 2026-10-08. This file describes the project **as it stands now**. The previous
handoff was a session-by-session log (1,658 lines); it is still in git history
(`git show 6ee98d9:handoff.md`) if a detail of how something was built is needed.

Facts marked *(checked)* were re-checked against the code, the dev database or a test run while
writing this. Everything else is carried over from the previous handoff.

---

## 1. What SenIQ is

A sentiment-driven market-intelligence web app for people who hold US stocks, Indian stocks,
crypto and commodities. It reads news, scores sentiment, and tells each user which events
matter **for their own portfolio**.

- **The differentiator is portfolio impact scoring**, not raw sentiment: "this event touches
  18% of your portfolio", ranked per user.
- Two main markets: **US and India**. Budget stance: cheapest viable (free data tiers, local
  models; pay only for Claude calls and, later, billing providers).
- First audience is the major-project evaluators; real users come later.
- Team repository: `shreyas-sinha26/SenIQ_MajorProject` (private). Annas owns the engine,
  alerts, reports, Ask and strategies; Shreyas built OAuth sign-in and the first alert emails.

**v1 and v2 are one codebase.** A feature switch (`FEATURES_STRATEGIES=1`) turns on the v2
pages. With it off, the v2 routes (`/api/strategies`, `/api/paper`, `/api/keys`, `/mcp`, `/v1`,
`/docs`) return 404 and the v2 UI is hidden.

| | Pages |
|---|---|
| **v1** | Dashboard, Portfolio, Intelligence (news, Institutions, Congress), Analytics, AI Workspace (daily brief + Ask) |
| **v2** | v1 + Strategy Builder, Your Strategies, Backtest, Paper Trade, MCP server, public REST API (`/v1`), API keys |

---

## 2. Standing rules

1. **No Claude API calls until Annas says so** (set 2026-10-08, still in force). He approves
   paid calls one at a time. `CLAUDE_REPORTS=0` is set in `.env`, which turns off every model
   call the app could make by itself (and Ask with it).
2. **Ask before any run that costs money or takes long**: paid model call, embedding run,
   backfill, eval run.
3. **Annas is the sole author.** No AI attribution in commits, pull requests or code.
4. **`strategy-service/` is local-only** (gitignored, his IP). Never push it without asking.
5. **Do not touch Zeuniq.** It is a separate project (database `zeuniq`, folder
   `~/Downloads/Zeuniq`). SenIQ uses the `seniq` database only.
6. **Kickoff questions first.** At the start of each new phase, ask a short batch of
   clarifying questions before writing code.
7. **Work in `~/Downloads/SenIQ_MajorProject`.** `~/Downloads/ai-portfolio-copilot` is a stale
   copy.
8. From the Claude desktop app, a session **cannot merge pull requests into `main` or delete
   database rows**, even with a yes. Give Annas the one-line command and check the result
   before writing "done".

---

## 3. Current state

- **Git** *(checked 2026-10-08)*: on `main`, level with `origin/main`, no other branch, no
  open pull request. `main` is at `d13a560`, the merge of pull request #8 (per-company
  sentiment), which is **not tagged yet**: the latest tags are still **`v1.7` / `v2.7`** on
  `898314c`. Untracked and never pushed: `samples/` and `.github/` (see §11).
- **Tests** *(checked 2026-10-08)*: `npm test` passes — 22 files, 530 checks, offline
  (no database or API calls).
- **Dev database** *(checked)*: Postgres `seniq`, all 30 migration files applied (latest
  `0029_user_time_zone`). 1,917 articles, 308 events.
- **Nothing is running.** Nothing is hosted.
- **Local `.env` switches that differ from the defaults** *(checked)*: `CLAUDE_REPORTS=0`,
  `INDIA_SMART_MONEY=1`, `FINBERT_CLASSIFY=1`, `COMPANY_SENTIMENT_LLM=ollama` (the local
  model reads multi-company stories, §8; it needs `ollama serve`, which is **not** running),
  plus Annas's own `NSE_USER_AGENT`.

### Next, in order

1. **Tell Shreyas that `main` moved.** Sign-in is now server-side sessions, so part of his
   OAuth callback (`server/routes/oauth.js`) was rewritten and everyone must sign in again.
   `README.md` on `main` is garbled since his commit `ffa4fde` (316 bytes of random
   characters) and needs restoring.
2. **India smart money:** keep running `node scripts/india_smart_money.js poll` (60 insider
   filings per run) to drain the backlog and catch each evening's deal file. Before any
   hosting, settle NSE's terms or find a licensed source.
3. **When Annas allows Claude calls:** one report-card call to see the pass rate after the
   last two check changes; regenerate the stale daily brief on account 36 (needs the brief
   quota raised once); rerun the 30-case Ask eval (about $0.50) to measure the tool changes.
4. **Reddit:** wait for Reddit's reply (§8). Do not switch it on as-is.
5. **Open decisions:** see §10.

---

## 4. Run it locally

```bash
pg_isready    # Postgres 15 via brew; if down: brew services start postgresql@15
```

v1:
```bash
cd ~/Downloads/SenIQ_MajorProject && npm start    # http://localhost:3010/app
```

v2 needs the strategy engine in a second terminal:
```bash
cd ~/Downloads/SenIQ_MajorProject/strategy-service && ./venv/bin/uvicorn app:app --port 8100
```
```bash
cd ~/Downloads/SenIQ_MajorProject && FEATURES_STRATEGIES=1 PORT=3030 npm start    # http://localhost:3030/app
```

- `npm start` does not watch files. Restart after any server-side edit; HTML/JS/CSS only need
  a page reload.
- Every boot runs the news pipeline. Several restarts in a row hit Finnhub/CoinGecko rate
  limits and prices come back empty until they clear. Start about 5 minutes before a demo.
- Port busy: `lsof -ti :3010 | xargs kill`. Health: `curl -s localhost:3010/api/health`.
- Preview-pane launch names (in `~/.claude/launch.json`) *(checked)*: `seniq-main` (:3010),
  `seniq-v2` (:3030), `seniq-strategy` (:8100). The pane cannot start the engine (macOS blocks
  it from reading the venv in Downloads); start the engine from a shell.
- The first FinBERT run downloads the model (~110 MB) into
  `node_modules/@huggingface/transformers/.cache/`; `npm ci` removes it.

### Accounts in the dev database *(checked)*

| id | Email | Tier | Notes |
|---|---|---|---|
| 36 | Annas's own Gmail | Pro, verified | The demo account. TCS 120, RELIANCE 170, AAPL 6, NVDA 9, BTC 0.02. No `home_market`, so its report is in USD. |
| 16 | `demo@xynthis.com` | Pro, unverified | Older demo. 5 units of each holding, so BTC is about 99% of it and every portfolio answer is skewed. |
| 19 | `admin@seniq.local` | Pro | Admin (tier switcher in the nav). Seeded from `ADMIN_PASSWORD`. |
| 37 | `eval-ask@seniq.local` | Pro | Fixture for the Ask eval. |
| 44 | `india-ui-check@example.test` | Plus | Throwaway from the India browser check. Safe to delete. |
| 1–8 | old test users | Free | Left over from early phases. |

Passwords are bcrypt hashes and cannot be recovered. To set a new one for `demo@xynthis.com`
(prompts silently, local database only):
```bash
cd ~/Downloads/SenIQ_MajorProject && read -s -p "New demo password: " PW && echo && PW="$PW" node -e "require('dotenv').config();const b=require('bcryptjs');const {pool}=require('./server/db');b.hash(process.env.PW,10).then(h=>pool.query('UPDATE users SET password_hash=\$1 WHERE email=\$2',[h,'demo@xynthis.com'])).then(r=>{console.log(r.rowCount?'Password updated':'User not found');return pool.end()})"
```

---

## 5. How it works

### The pipeline (`server/scheduler.js`, every 10 minutes and on boot)

1. **Gather** articles from the enabled sources (`services/ingest/`): Finnhub company news,
   GDELT, four Indian RSS feeds (ET, Mint, Moneycontrol, Business Standard). Reddit returns
   nothing without credentials; X is a stub.
2. **Resolve entities** (`entityResolver.js`): which companies, executives, sectors or
   commodities a headline names, against a curated universe of 186 instruments (100 US, 57
   India, 25 crypto, 4 commodities) and 192 dated executives.
3. **Grade relevance and cluster** (`newsRelevance.js`): each article is holding / market /
   world / none, decided by the headline. Duplicates across outlets share one cluster. Noise
   is kept but flagged and hidden.
4. **Score sentiment**: FinBERT locally when `FINBERT_CLASSIFY=1`, otherwise the word list
   (`sentiment.js`). FinBERT reads only stories not stored yet.
5. **Events** (`events.js`, `eventTyping.js`): one durable event per cluster, typed (M&A,
   legal, earnings, guidance, rating, macro, …), kept 7 days.
6. **Impact per user** (`impactScoring.js`): for each holding,
   `exposure × relevance × severity × novelty × confidence × recency`, with a stance factor
   (event 1.0, commentary 0.6, round-up 0.4). Market-wide stories reach only holdings in that
   market, at low relevance, scaled by how many outlets covered them.
7. **Alerts** (`materiality.js`): one alert per story per user. At most 5 real-time alerts a
   day (2 of them market-wide); the rest are filed as digest. A holding only alerts on events
   after it was added (`portfolio.monitoring_since`).
8. **Outcomes** (`outcomes.js`): snapshots each event's features and the price 1 and 3 days
   later, for tuning later. No reinforcement learning.

**Sentiment for a ticker** (`sentimentScoring.js`) is computed on read: an acute score over
24–72 hours with a 7-day half-life, momentum (this week against last), and a z-score against
the ticker's own 90-day normal. Sources are weighted by credibility.

### Other scheduled jobs *(checked in `scheduler.js` / `config.js`)*

| Job | When | Notes |
|---|---|---|
| US smart money (13F + congress) + 8-K filings | every 15 min | First contact is silent; only newly disclosed records alert |
| India smart money | weekdays 19:30 IST | Only when `INDIA_SMART_MONEY=1`; never on boot |
| Daily brief | checked every 15 min | Written when each user's clock passes 05:30 |
| Report emails | checked every 15 min | Schedule below |
| Ask thread purge | 04:15 daily | Threads older than 30 days |

### Features

**Portfolio and prices** (`priceService.js`, `portfolioService.js`). Crypto from CoinGecko, US
stocks from Finnhub (Yahoo as fallback), Indian stocks from Yahoo (`.NS` then `.BO`, in INR),
commodities from Yahoo futures with FMP as fallback. Every holding is converted to USD before
weights are computed. Adding a holding returns a company brief and backfills impact silently.

**Smart money.** US: 13F filings of 10 seeded funds straight from SEC EDGAR, and congressional
trades from Financial Modeling Prep. India (opt-in): NSE bulk and block deals on the
Institutions tab and SEBI insider-trading disclosures on the Congress tab, with 16 curated
followable investors (`server/data/indiaInvestors.js`). Users follow funds, politicians or
investors; Pro can register outbound webhooks. An Indian insider trade alerts only when it is a
promoter, director or key-manager open-market trade of ₹1 crore or more.

**Daily brief and Ask** (AI Workspace). The brief (`reports.js`, `briefWriter.js`,
`grounding.js`) is led by what changed since yesterday and the most important event. Ask
(`qa.js`, `qaTools.js`) is a tool-calling agent on Claude Haiku 4.5 with saved conversations;
it answers only about the user's holdings, market news and general finance education, and
refuses other stocks before any model call. Each answer is audited against its evidence
(`answerCheck.js`). News search (`newsSearch.js`) is keyword and full-text today; the vector
half has never run. Both features fall back to code-written text when Claude is off or fails.

**Model access and cost guards** (`llmClient.js`). Claude goes through AIRouter when
`AIROUTER_API_KEY` is set, otherwise the Anthropic key. Nothing is called unless
`CLAUDE_REPORTS=1`. Guards: per-user daily quotas by tier, a $5/day global ceiling, every call
logged with its cost in `claude_calls`.

**Report emails** (`reportEmails.js`, `reportPdf.js`, `reportInsights.js`, `cardWriter.js`,
`eveningReport.js`). The report is a PDF attachment; the email body is one line.

| Report | Who | When (user's own clock) |
|---|---|---|
| Weekly summary | Free | Sunday 18:00 |
| Daily brief | Plus, Pro | Weekdays 08:30 |
| End-of-day report | Pro | Every day from 20:00; full, shortened ("closed") or skipped depending on whether a market traded |

Sent only to verified addresses with reports switched on, once per local day
(`report_sends`). Sending goes through Resend when `RESEND_API_KEY` is set, otherwise SMTP
(a Gmail app password today, about 500 a day). Alert emails are separate (`alertNotifier.js`:
Free none, Plus standard, Pro with a short narrative). Every email has an unsubscribe link and
is logged in `email_log`.

**User time zones** (`userTime.js`). `users.time_zone` is an IANA name. Reports, the brief and
every per-user daily limit follow the user's own clock; the global spend ceiling stays on UTC.

**Accounts and security.** Email + password or Google/GitHub OAuth; email verification and
password reset. Server-side sessions (`sessions.js`): a random id in an HttpOnly cookie, 7-day
idle limit, 30-day absolute. `JWT_SECRET` is still needed: it signs OAuth state and
unsubscribe links, so changing it breaks links in emails already sent. Request safety:
`asyncRouter.js` (a failing handler is a 500, not a crash), per-user rate limits,
`safeFetch.js` for user-supplied URLs, a same-origin guard on `/api`, a Content-Security-Policy.

**Tiers** (`config.js` `TIERS`, `middleware/tier.js`) *(checked)*:

| | Free | Plus ($9 / ₹399) | Pro ($24 / ₹999) |
|---|---|---|---|
| Holdings | 7 | unlimited | unlimited |
| Sentiment | basic | + 90-day normal | same |
| Impact feed | top event only | full | full |
| Ask questions per day | 0 | 10 | 30 |
| Real-time alerts | no | yes | yes |
| Smart money | teaser | full | full |
| API / MCP, webhooks | no | no | yes |

Checkout is a **dev stub** that flips the tier directly; it refuses in production unless the
caller is an admin. No payment provider is wired.

**v2: strategies, MCP and the public API.** A separate FastAPI engine (`strategy-service/`,
port 8100, lifted from Zeuniq; backtest and paper trading only). The Builder mixes technical
factors (EMA, RSI, MACD) with SenIQ factors (sentiment, smart money). Backtests carry a
buy-and-hold benchmark and a walk-forward robustness check. `/mcp` and `/v1` expose the same
data tools and strategy actions to API keys (Pro), with one shared rate budget per key; write
actions need a key created with write access. A clone of the repository has no engine, so
every strategy route answers "engine offline".

### Where things live

| Area | Files |
|---|---|
| Config: tiers, feature switches, every threshold | `server/config.js` |
| App entry, v1/v2 route gating | `server/index.js` |
| Pipeline and scheduled jobs | `server/scheduler.js` |
| Ingest sources | `server/services/ingest/` |
| Universe and entity resolution | `server/data/universe.js`, `executives.json`, `services/entityResolver.js` |
| Sentiment | `services/sentiment.js` (word list), `finbertClassifier.js`, `sentimentScoring.js`, `sentimentBreakdown.js` |
| Events, impact, alerts, outcomes | `services/events.js`, `eventTyping.js`, `impactScoring.js`, `materiality.js`, `outcomes.js` |
| Prices and weights | `services/priceService.js`, `portfolioService.js` |
| Smart money | `services/smartMoney/` (`edgar.js`, `congress.js`, `india.js`, `nse*.js`), `routes/smartMoney.js` |
| Brief, Ask, news search | `services/reports.js`, `briefWriter.js`, `grounding.js`, `qa.js`, `qaTools.js`, `answerCheck.js`, `newsSearch.js`, `askThreads.js`, `routes/reports.js` |
| Model client | `services/llmClient.js` |
| Reports and email | `services/reportEmails.js`, `reportPdf.js`, `reportInsights.js`, `cardWriter.js`, `eveningReport.js`, `marketSessions.js`, `emailService.js`, `alertNotifier.js`, `alertNarrative.js`, `routes/email.js` |
| Sign-in and sessions | `routes/auth.js`, `routes/oauth.js`, `services/sessions.js`, `authTokens.js` |
| Request safety | `middleware/asyncRouter.js`, `rateLimit.js`, `tier.js`, `services/safeFetch.js` |
| v2 | `routes/strategies.js`, `paper.js`, `mcp.js`, `v1.js`, `apiKeys.js`; `services/strategyClient.js`, `strategyStore.js`, `strategyTools.js`, `strategySpec.js`, `signalHistory.js`, `dataTools.js`, `apiKeyGate.js` |
| Strategy engine (local-only) | `strategy-service/app.py`, `service/`, `engine/`, `tests/` |
| Frontend | `public/index.html`, `js/app.js`, `css/style.css`; landing: `landing.html`, `js/landing.js`, `css/landing.css`; `docs.html` (v2) |
| Migrations | `server/migrations/` (run on boot) |
| Tests and eval | `test/*.test.js`, `eval/ask/` (`cases.json`, `run.js`; runs are gitignored) |

Two migrations share the number `0016`. This is harmless; do not rename an applied one.

### Scripts

| Command | What it does |
|---|---|
| `node scripts/india_smart_money.js poll` | One India poll (deals + up to 60 insider filings) |
| `node scripts/india_smart_money.js history SYMBOL` | Pre-May-2026 insider trades for a symbol |
| `node scripts/india_smart_money.js import <csv> [--dry-run]` | Load a deal file downloaded by hand |
| `node scripts/rescore_sentiment.js [--write]` | Re-score stored word-list readings with FinBERT |
| `node scripts/retag_commodities.js [--write --backup <file>]` | Remove stored commodity tags the resolver would no longer give |
| `node scripts/retag_roundups.js [--write --backup <file>]` | Remove stored company tags from roundup stories and re-grade them |
| `node scripts/reread_companies.js [--tuning] [--write --backup <file>]` | Re-read stored multi-company stories per company (needs `FINBERT_CLASSIFY=1`) |
| `node scripts/sentiment_label_sheet.js <file>` | Write a sheet of (story, company) pairs to hand-label |
| `node scripts/score_sentiment_labels.js <file>` | Score each way of reading against the hand labels |
| `node scripts/refresh_executives.js [--write]` | Re-check US executives against FMP (about 100 of 250 daily calls) |
| `node eval/ask/run.js --check` | Free, offline check of the Ask eval set |
| `node eval/ask/run.js --run --yes-spend --max-usd N [--judge]` | **Paid** Ask eval run. Ask first. |

All the write scripts are dry runs without their flag.

---

## 6. Environment (`.env`, never committed; names only)

| Variable | Local state | Purpose |
|---|---|---|
| `DATABASE_URL`, `PORT` | set (3010) | Local Postgres `seniq` |
| `JWT_SECRET` | set | Signs OAuth state and unsubscribe links |
| `APP_URL` | `http://localhost:3010` | OAuth callback and email links; the public URL once hosted |
| `FINNHUB_API_KEY` | set | US prices and company news |
| `FMP_API_KEY` | set | Commodity fallback, executives refresh |
| `AIROUTER_API_KEY` | set | Claude through AIRouter (`ANTHROPIC_API_KEY` is the alternative) |
| `CLAUDE_REPORTS` | **`0`** | `1` lets the app call Claude: brief, Ask, alert narrative, report cards |
| `FINBERT_CLASSIFY` | **`1`** | Local FinBERT scores new stories. Default is off. `FINBERT_MODE=hosted` uses the Hugging Face API instead |
| `INDIA_SMART_MONEY`, `NSE_USER_AGENT` | **`1`**, set | India deals and insider trades. Default is off |
| `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM` | set (Gmail app password) | All email while there is no domain |
| `STRATEGY_SERVICE_URL`, `STRATEGY_SERVICE_SECRET` | set | v2 engine at :8100 |
| `FEATURES_STRATEGIES` | unset | `1` = v2 |
| `UPSTOX_ANALYTICS_TOKEN` | empty | Unused; the launch-grade source for Indian prices |
| `RESEND_API_KEY` | not set | Takes over from SMTP; needs a verified domain |
| `HF_API_TOKEN`, `NEWS_EMBEDDINGS` | not set | Vector news search (also needs pgvector) |
| `CONGRESS_TRADES_URL` | not set locally | Live congress data; without it the bundled sample is used |
| `GOOGLE_*`, `GITHUB_*` client id/secret | not set | OAuth buttons stay hidden until set |
| `REDDIT_CLIENT_ID/SECRET` | not set | Reddit ingest |
| `SENTRY_DSN`, `OLLAMA_URL`, `OLLAMA_MODEL`, `ASK_OLLAMA`, `DISCLOSURES` | not set | Error monitoring; local-model fallbacks; `DISCLOSURES=0` stops 8-K fetching |

`.env.example` and `render.yaml` list every variable the code reads. `render.yaml` sets
`CLAUDE_REPORTS` and `FEATURES_STRATEGIES` to `"0"`.

---

## 7. What has and has not been proven

**Run for real:**
- The pipeline, impact scoring, alerts and smart-money polls, on live data.
- v2 end to end on 2026-10-07 (build → backtest → save → signal → paper → key → `/v1` →
  `/mcp`) with the real engine. Not repeated against the code merged since.
- Ask through AIRouter with real Claude Haiku 4.5: one question, three tool calls, $0.0089.
- Two 30-case Ask eval runs (about $1.00 in total).
- Three Claude report-card calls ($0.018).
- One PDF report email delivered to Annas, from a phone hotspot.
- Local FinBERT on new stories; all 1,222 stored readings re-scored.
- One India poll: 59 filings read, 200 insider trades stored, 218 bulk deals for 2026-10-07.

**Never run for real:**
- Any hosting. Scheduled reports and the India poll only run while the app happens to be up.
- A report email sent by the scheduler; the 15-minute jobs through a real morning or evening.
- The end-of-day report's "closed" and "skip" outcomes, and an actual evening send.
- Google/GitHub sign-in end to end on the new sessions.
- The daily brief and the alert narrative through AIRouter.
- Vector news search and embeddings (no `HF_API_TOKEN`, no pgvector).
- Ask's strategy tools and the strategy-draft tool against the real engine (stand-in only).
- The Ollama fallbacks against a real local model.
- A full browser click-through of v1 or v2 on any tag from `v1.2` onwards.
- An India alert from live NSE data.
- Email through Resend; bounce and complaint handling.

---

## 8. Known limits and gotchas

**Data depth.** Sentiment history is only as long as the app has been recording, in practice
a week or two, so the "90-day normal" rests on that and SenIQ-factor backtests show very low
coverage. Hosting and a sentiment backfill would fix it; both are parked by Annas.

**Sentiment.**
- There is **no accuracy figure** for FinBERT against the word list. Nobody has hand-labelled
  stories. Do not quote an accuracy number in the report. Offered, not started: hand-label
  about 100 stored stories and score both methods.
- FinBERT reads the tone of the whole text, not per company (a market wrap that names a bank
  reads negative for the bank when the market fell). **Partly fixed for new stories
  (2026-10-08, pull request #8, merged):** `newsRelevance.subjectTickers` stores the reading only
  against the companies a story is about. A roundup headline ("market wrap", "top gainers
  and losers", "stocks to watch" — `NEWS_RELEVANCE.ROUNDUP_PHRASES`) is about none of the
  companies it lists; a broad-market headline (Sensex, Nifty, Wall Street — not sector
  indices such as Nifty IT) keeps only the companies the headline names. A story that
  named tracked companies but is about none of them stays in the feed as a market story
  (`classifyArticle`'s `aboutMarket`), "stocks to watch" lists included — Annas asked for
  this.
  - Stored stories keep their old tags: a dry run of `scripts/retag_roundups.js` found 65
    company tags on 37 stories (of 848). `--write` has not been run.
- **Per-company reading (2026-10-08, pull request #8, merged; `services/targetedSentiment.js`).** A new
  story naming two or more companies is read once per company. Step 1: FinBERT reads each
  company from the sentences and clauses that name it (clauses end at "while", "but"… —
  `TARGETED.CLAUSE_BREAKS`); when every company sits in the same units the whole-text
  reading stays. Step 2: a language model is asked about a clause that names two or more
  companies, and may answer "not about" (the tag is dropped). Step 2 is **off** unless
  `COMPANY_SENTIMENT_LLM=1` and a model key are set; capped at `TARGETED.LLM.MAX_CALLS_PER_DAY`
  and logged to `claude_calls` as `company_sentiment`. Tests: `test/targetedSentiment.test.js`.
  - **Measured once (2026-10-08)** on 100 (story, company) pairs Annas labelled by hand
    (`samples/sentiment-labels-2026-10-08.csv`; 65 from multi-company stories, 35 from
    single-company; 18 labelled "not about"). Pairs matching his label: whole text 54,
    subjects only 53, step 1 55, step 1 + model **70**. On the 65 multi-company pairs: 32,
    32, 34, **49**. Readings in the opposite direction to the label: 11, 11, 8, **3**. The
    model caught 8 of the 18 "not about" pairs; nothing else caught any. 28 model calls,
    about $0.016. So: the roundup rule and step 1 show no measurable gain on their own;
    the model step is what helps. One labeller, one run, 100 pairs — say that when quoting.
    Re-run: `COMPANY_SENTIMENT_LLM=1 node scripts/score_sentiment_labels.js <file>`.
  - **Local model tried (2026-10-08):** `COMPANY_SENTIMENT_LLM=ollama` asks a local Ollama
    model instead (`TARGETED.LLM.OLLAMA_MODEL`, default `qwen2.5:7b-instruct-q4_0`; free,
    not logged). Same 100 pairs, same prompt: **66** match (Claude Haiku 70), 45 of the 65
    multi-company pairs (Haiku 49), 3 in the opposite direction (Haiku 3), 3 of the 18 "not
    about" caught (Haiku 8) — it tends to answer "neutral" for a passing mention. About
    1.5 s a call on the M4. A 4-pair gap on 100 is within noise. Needs `ollama serve`
    running, so it is a local-machine option, not one for a small cloud server.
  - **Settled (2026-10-08): the local model, and no Claude for this.** Annas chose
    `COMPANY_SENTIMENT_LLM=ollama` (set in `.env`). Two things were then tried on the same
    labels and the design left there:
    - A local-model "not about" no longer removes the tag; it is stored as neutral
      (`TARGETED.LLM.REMOVE_NOT_ABOUT`). Its removals were wrong too often (3 right of 8 on
      the labels; a dry run would have dropped TCS from "Infosys, TCS and other IT stocks
      jump"). Result: 65 of 100 match, 3 in the opposite direction; of the 18 "not about"
      pairs, 11 now read neutral and 7 still read positive or negative (16 before).
    - Asking the model about more (`TARGETED.LLM.SCOPE`): every company of a multi-company
      story scored 64; single-company stories too scored 60 (17 of 35 single-company pairs
      against FinBERT's 21 — it answers "neutral" too readily — though 0 in the opposite
      direction). Neither beat `shared`, which stays the default.
    The 100 pairs are a third of the store (article id divisible by 3) kept out of
    rule-tuning, but they have now been used to choose between these, so they flatter the
    choice a little; fresh labels would be needed for a clean figure. No further tuning is
    planned.
  - Needs `ollama serve` running with `qwen2.5:7b-instruct-q4_0` pulled. **FinBERT is the
    fallback when it is not** *(checked 2026-10-08 with Ollama stopped)*: the call fails at
    once, one warning is logged, and every company keeps FinBERT's per-company reading. No
    tag is removed and the pipeline run carries on.
  - Single-company stories never reach the model: FinBERT alone matched 21–22 of 35 there.
  - **Stored stories re-read (2026-10-08):** `reread_companies.js --write` updated 257
    readings on 140 multi-company stories (226 by the local model, none removed). Old rows:
    `samples/company-readings-before-2026-10-08.json`. `retag_roundups.js --write` has
    **not** been run.
  - Not handled: a commodity's reading follows the story's tone, not the price direction
    ("stocks retreat as oil rebounds" reads negative for oil).
- A story read as neutral just below the middle (0.46) is still worded "Reads negative" on the
  news row (`impactScoring.dirLabel` has no neutral band).
- Alerts, cached briefs and `event_outcomes` made before the re-score keep the old readings.

**Entity resolution.**
- A commodity word inside a company name ("Senco Gold") no longer tags the commodity, using a
  short list (`COMMODITY_COMPANY_NAMES`) plus capital-letter clues. A Title Case headline
  gives no such clue, so an unlisted name there still tags the commodity; add it to the list
  when seen. Gas utilities are not on the list.
- A story is tagged once, when stored. After any change to the resolver rules, old tags stay
  until a clean-up script is run.
- `classifyEventType` is crude ("to buy " → M&A); analyst notes are mostly typed "other".

**Prices.** Yahoo is unofficial, can throttle, and NSE/BSE quotes are about 15 minutes late.
The price service has no backoff. Several quick restarts exhaust Finnhub and CoinGecko limits.

**India smart money.**
- NSE refuses a client that identifies itself as SenIQ. Annas set a browser-style
  `NSE_USER_AGENT` in his own `.env` for a local demo to his professors and runs the poll
  himself. NSE's routes are unofficial and its terms on automated access are unchecked. This
  is **not acceptable for a hosted product** as it stands.
- The deal files hold one day only: a day the poll does not run is a day of deals never seen.
  Insider filings stay on NSE's list for months and are caught up later.
- A deal is matched to an investor by a phrase in the exchange's free-text client name; a fund
  trading under another name is missed.
- Large caps rarely see bulk deals or qualifying insider trades, so the India table in the
  reports is often absent.

**Dates.** `pg` returns a Postgres `DATE` as a JS Date at local midnight, which prints a day
early east of GMT. **Rule: a `DATE` column that goes to the browser or to Ask must be selected
as text** (`col::text` or `to_char`). A global type parser was rejected because the
paper-trading code relies on Date objects.

**Time zones.** On the two days a year clocks change, a daily limit can reset an hour off.
There is no holiday calendar: a shut market just has an older last session. Annas asked to
keep a per-exchange calendar in mind.

**Ask quality** (from the two eval runs). Guardrails are solid: scope refusals 5/5, right
tools 19/19, no advice, concise. The weak spot is factual precision by Haiku 4.5: wrong
ranking, wrong trade direction, saying results were "released" when only previews exist,
adding its own interpretation. Prompt wording did not move it. The tools now return
rankings and tallies ready-made, which is **not yet measured**. The LLM judge is strict (it
fails a whole line for one loose phrase) and has not been checked against a human read.

**Email.** The usual network blocks outgoing mail ports (25/465/587); sending worked from a
phone hotspot. Gmail is for demos only. Real email at launch needs a domain and Resend.

**Security, left from the hardening pass.** The global $/day Claude ceiling can be overshot by
a few calls when several users ask at once. `safeFetch` has a DNS-rebinding gap (documented in
the file). The CSP still allows inline scripts. 25 moderate `npm audit` advisories need
`node-cron` 4.

**Smart money (US).** 13F amendments are skipped. Outside the 100 mapped US names, a holding
keeps its issuer name with no ticker and cannot match a portfolio.

**Strategy engine.** One backtest is capped at 5 years of daily bars. The dropped-entry fix of
2026-10-07 changed every preset backtest number, and SenIQ-factor backtests run from this
machine before the date fix that day had lookahead; do not reuse older figures.

### Reddit and X

- **X** is pay-per-use and stays deferred.
- **Reddit:** self-service API access is closed. Annas filed Reddit's Data Access Request on
  2026-10-08 (account `Sweaty_Style_1166`, described truthfully as a student project) and is
  waiting for a reply. No scraping around it.
- **The request made commitments the code does not meet yet.** Before Reddit is switched on:
  - keep only posts that name a company in the curated list (today every fetched post is
    stored);
  - delete stored Reddit items after 90 days (no clean-up job exists);
  - read the five subreddits named in the request: r/stocks, r/wallstreetbets,
    r/CryptoCurrency, r/IndianStreetBets, r/IndiaInvestments (the code has the first three);
  - stay read-only, store no usernames, comments, votes or profile data, link each item back
    to its thread, never train on or redistribute the content (all true today).
- Today a Reddit post would flow through the news pipeline unchanged and could create an
  event, a report card and an alert by itself. Proposed, not yet agreed: Reddit may attach to
  a story a news source already reported but never create one; an intake filter; a separate
  "retail chatter" reading per holding; enforce the Plus/Pro-only rule.
- A paid launch needs Reddit's commercial agreement.

---

## 9. Dev-database changes and backups

Changes made by hand to the dev database on 2026-10-08, with backups in `samples/`
(untracked):

| Change | Backup |
|---|---|
| 1,222 stored sentiment readings re-scored with FinBERT | `sentiment-before-finbert-2026-10-08.json` |
| 41 of 128 stored commodity tags removed | `removed-commodity-tags-2026-10-08.json` |
| 17 wrong ticker tags removed | `removed-ticker-tags-2026-10-08.json` |
| 5 `event_outcomes` rows for Indian tickers had a pre-fix `price_at_event` blanked | none |
| Account 36 rebalanced; marked verified by hand | none |

`samples/` also holds a sample report PDF built from account 36.

---

## 10. Open work

**Decisions for Annas**
- Which SEC contact email is right: `render.yaml` says `affiliates@arnifi.com`, `config.js`
  defaults to `admin@xynthis.com`.
- Whether to buy a domain (needed for real email and for OAuth and billing callbacks).
- Whether the Dashboard should say Positive/Negative like Analytics instead of Bullish/Bearish.
- A privacy page (the landing footer has no Privacy link until one exists).
- Whether to gitignore `samples/`.
- Whether to hand-label about 100 stories to measure FinBERT against the word list.

**Parked by Annas**
- Hosting (Render + Neon; steps in `DEPLOY.md`, `render.yaml` is ready). If a Render service
  is ever connected to `main`, a merge deploys and applies every migration.
- Sentiment backfill.
- Real billing (Stripe for the US, Razorpay for India).
- Quiet hours for alerts (dropped).

**Build queue, roughly by value**
1. Ask precision: measure the tool changes; try another answer model for the eval only; stop
   the automatic grounding check counting a general explanation as ungrounded; have Annas
   read about 10 judged answers.
2. Alerts: a sensitivity dial and per-stock mute; price-move confirmation before emailing; a
   feedback loop from opens, dismissals and outcomes. Thresholds were calibrated on one day
   of data and ten test portfolios.
3. Reports: "the week ahead" (no calendar source yet), a per-user choice of hour for the
   evening report, a per-exchange holiday calendar.
4. Email at launch: domain + Resend, and read bounces and complaints from its webhook.
5. India: licensed or permitted data source; quarterly shareholding pattern; mutual-fund
   monthly portfolios; a BSE fallback.
6. Indian prices through Upstox (ticker → instrument-key lookup) for launch.
7. Vector news search: `HF_API_TOKEN`, `NEWS_EMBEDDINGS=1`, pgvector.
8. Reddit intake rules (§8), if access is granted.
9. Engine v2 scope in `ENGINE_PLAN.md`: a relevance model trained on the logged outcomes,
   deeper company links, universe expansion. Not started.

**Upkeep**
- **Noel Tata retires as Trent chairman in November 2026.** Update `executives.json` then.
- Re-run `refresh_executives.js` now and then (US only; India is by hand).
- Re-run `retag_commodities.js` after any change to the commodity rules.

**Small**
- Dark-mode toggle (colours are already CSS variables).
- The company card shows "US · US" (exchange and country).
- Ask's prompt still says "Today (UTC)".
- Commit the CI workflow (§11).
- Delete throwaway user 44.

---

## 11. Git and releases

- **Push only with the `Annas-Shariff` gh account** (`gh auth switch --user Annas-Shariff`,
  push, switch back). `annas05shariff` is pull-only.
- **Flow:** fetch first → branch → `npm test` → push the branch → open a pull request → merge
  with a **merge commit** (never rebase or squash: tagged commits must keep their hashes) →
  tag → delete the branch. Annas runs the merge himself, for example
  `gh pr merge <N> --merge --delete-branch`.
- **Tagging rule:** one commit, two annotated tags. `v1.N` is the commit run with strategies
  off; `v2.N` is the same commit with `FEATURES_STRATEGIES=1`.
- **`.github/workflows/ci.yml` is uncommitted on purpose.** A push that contains a workflow
  file is rejected until the token has the `workflow` scope
  (`gh auth refresh -h github.com -s workflow`, interactive).
- `strategy-service/`, `.env`, `eval/ask/runs/` and `.claude/` are gitignored.

### Tags

| Tags | Commit | Adds |
|---|---|---|
| `v1.0` | `24148b2` | v1 on the old dark theme (presentation fallback) |
| `v1.1` / `v2.1` | `673791a` | Light theme, sliding nav |
| `v1.2` / `v2.2` | `537612d` | Google/GitHub sign-in, password reset, alert emails (Shreyas) |
| `v1.3` / `v2.3` | `cbf1115` | Pull requests #1 and #2: knowledge base, Ask grounding and retrieval, alert quality, hardening, server-side sessions, report emails, INR prices, Analytics page, feed ranking, India smart money |
| `v1.4` / `v2.4` | `308b1bc` | #3: user time zones, Pro end-of-day report |
| `v1.5` / `v2.5` | `f5d2605` | #4: India deals and insider trades in the reports and the brief |
| `v1.6` / `v2.6` | `7af294a` | #5: local FinBERT, re-score script |
| `v1.7` / `v2.7` | `898314c` | #7: commodity word inside a company name; commodity re-tag script |

Pull request #6 was closed by GitHub when its base branch was deleted; #7 replaced it.

**Pull request #8** (`per-company-sentiment`) was merged on 2026-10-08 as `d13a560`, at
Annas's request from a session, and the branch deleted: roundups as market stories,
per-company sentiment, the local-model step and the labelling scripts. **Not tagged** — the
next pair would be `v1.8` / `v2.8` on `d13a560`.

---

## 12. Other documents

| File | What it is | Current? |
|---|---|---|
| `PLAN.md` | Original phased product plan | Phase order superseded by the roadmap |
| `SenIQ_Roadmap.pdf` | Re-sequenced roadmap (deploy first, then OAuth and billing). Rebuild: `python3 scripts/build_roadmap_pdf.py` | Yes, for ordering |
| `ENGINE_PLAN.md` | Engine phases E1–E6 (all done) and the v2 engine scope | v2 scope is open |
| `STRATEGY_PLAN.md` | Strategy service, Builder schema, MCP design | Built |
| `RAG_PLAN.md` | Ask, retrieval and signals plan (agreed 2026-10-07); India filings spike notes | Partly built |
| `IPO_PLAN.md` | Sentiment for IPOs and small/mid-caps, where 13F and congress data are blind | Plan only, nothing built |
| `DEPLOY.md` | Render + Neon + Cloudflare steps | Ready, not executed |
| `README.md` | — | Garbled on `main`; needs restoring |
