# SenIQ — Handoff

Rewritten 2026-10-08; §3 re-checked 2026-10-09 (evening); a QA pass and its fixes added 2026-10-10 (§3, §7, §8), then a second and a third round the same day that closed its open findings and re-checked `v2.13` (§8, §10); all of it merged that day as pull request #15 and tagged `v1.13` / `v2.14` (§3, §11). This file describes the project **as it stands now**. The previous
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

1. **A session makes no Claude API call of its own until Annas says so**; he approves those
   one at a time. The app's own calls are a separate switch, `CLAUDE_REPORTS` in `.env`. It
   is **`1`** *(checked 2026-10-10, evening; the file was last changed at 14:17 that day)*.
   It was `0` on 2026-10-09 and `1` late on 2026-10-08. At `1` a running
   server calls Claude for Ask, the daily brief, Pro alert explanations and report cards,
   inside the quotas and the $5/day ceiling.
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
8. **Merging into `main` and deleting database rows happen only when Annas asks for that
   specific action.** A session can do both (on 2026-10-08 it merged pull request #8 and
   removed 65 stored tags at his request; an earlier note here said it could not). Dry-run
   first, save a backup of any rows removed, and check the result before writing "done".

---

## 3. Current state

- **Git** *(checked 2026-10-10, evening)*: on `main`, level with `origin/main`, no open pull
  request. Latest tags **`v1.13`** and **`v2.14`**, both on `71230ec`, the merge of pull
  request #15 (the QA pass, §8). Before it: `v1.12` on `d9ec9df` and `v2.13` on `f3638fb`;
  `v2.13` was strategies-only work, which is why the two numbers differ (§11). The one
  commit after `71230ec` on `main` is handoff and README notes. One other branch exists,
  local and on GitHub: `crypto-kb`, already merged as pull request #12 and still checked out
  in the worktree `.claude/worktrees/crypto-kb`; nothing on it is missing from `main`.
  Untracked and never pushed: `samples/` and `.github/` (see §11).
- **Branch `ipo-show-all`** *(2026-10-10)*: local commits on top of `main`, **not pushed, no
  pull request**. IPO Watch opens an issue's news on its latest 5 stories with a "Show all N
  stories" button (page only: `public/js/app.js`, one style rule, three offline checks).
  `npm test` there: 27 files, 671 checks. A change to the shared side, so its tags would be
  `v1.14` / `v2.15`.
- **The local engine changed with the QA pass** *(2026-10-10)*: three files in `strategy-service/`
  (gitignored, so not in any commit): `service/signal_runner.py`, `engine/data/base.py`,
  `engine/analytics/walk_forward.py`, plus `tests/test_qa_fixes.py`. The files as they were
  are in the macOS Trash as `seniq-engine-pre_qa_2026-10-10` (gone once the Trash is
  emptied). The pages on `main` expect this engine: with the old one the signal and
  crypto fixes are absent and the robustness verdict is the old one.
- **Tests** *(checked 2026-10-10 on the commit that was merged)*: `npm test` passes — 27 files, 668 checks, offline
  (no database or API calls). The local engine's own tests: 60 pass
  (`cd strategy-service && ./venv/bin/python -m pytest -q`).
- **Dev database** *(checked 2026-10-09, evening)*: Postgres `seniq`, 42 of the 43 migration
  files applied (latest `0041_ipo_graduation`). **`0042_paper_ledger` is not applied yet**; the
  next start applies it, with strategies on or off. 2,280 articles, 524 events. No paper
  deployments, so the paper ledger has nothing to record there yet. On 2026-10-10 two stored
  Tesla tags were removed from it (§9). The QA copy `seniq_qa` was dropped the same day.
- **Nothing is running** *(checked 2026-10-10, evening)*: no dev server, no strategy engine, no
  `ollama serve`. Nothing is hosted. **`.env` has `CLAUDE_REPORTS=1`** (it read `0` here
  until 2026-10-10), so the next plain `npm start` **can make the app's own Claude calls**:
  briefs at each Pro account's 05:30, Ask, alert explanations and report cards, inside the
  quotas and the $5/day ceiling. Set it to `0` first if that is not wanted.
- **Local `.env` switches that differ from the defaults** *(checked 2026-10-09)*: `IPO_WATCH=1`, `INDIA_SMART_MONEY=1`, `FINBERT_CLASSIFY=1`, `COMPANY_SENTIMENT_LLM=ollama` (the local
  model reads multi-company stories, §8; it needs `ollama serve`, which is **not** running),
  plus Annas's own `NSE_USER_AGENT`.

### Next, in order

0. **IPO Watch: let it run.** `IPO_WATCH=1` is in the local `.env` since 2026-10-09. The 09:15
   IST poll has not yet fired on its own, and the GMP trend, the 1-week and later returns and
   graduation have only been seen on their first day. The "+ Portfolio" button has not been
   clicked. See `IPO_PLAN.md` for the open items.
1. **Paper ledger: see it work on a real deployment** (`v2.13`, §5). Start the engine and
   the app with `FEATURES_STRATEGIES=1` (§4), deploy a saved strategy on the Paper Trade page,
   and leave both up past 01:15 UTC (06:45 IST), or run `node scripts/paper_mark.js --write`
   the next day. Still unproven: a fill email actually sent, and the scheduled run firing on
   its own (§7). A deployment made today has no completed day until tomorrow, so its ledger
   starts empty.
1a. **Tell Shreyas that `main` moved** (still to do; Annas sends it). Sign-in is now
   server-side sessions, so part of his
   OAuth callback (`server/routes/oauth.js`) was rewritten and everyone must sign in again.
   Since then `v1.8` / `v2.8` added per-company sentiment: nothing for him to change, and the
   new `COMPANY_SENTIMENT_LLM` switch is off unless set.
   `README.md` was garbled by his commit `ffa4fde` (316 bytes of random characters) and was
   restored on 2026-10-08 from the last good version (`9121338`), then brought up to date;
   ask him not to re-apply that commit.
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
   GDELT, four Indian RSS feeds (ET, Mint, Moneycontrol, Business Standard) and four crypto ones
   (CoinDesk, Cointelegraph, Decrypt, The Block). Reddit returns
   nothing without credentials; X is a stub.
2. **Resolve entities** (`entityResolver.js`): which companies, executives, sectors or
   commodities a headline names, against a curated universe of 218 instruments (100 US, 57
   India, 46 crypto, 15 commodities) and 192 dated executives. A second, **listed** tier
   (1,837 more companies: 1,398 US, 439 India) is matched only for names someone holds — see "Company
   reference: two tiers" in §8.
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
| IPO Watch poll | daily 09:15 IST | Only when `IPO_WATCH=1`; never on boot. Calendar, GMP, subscription, outcomes, tickers, returns, graduation |
| Daily brief | checked every 15 min | Written when each user's clock passes 05:30 |
| Report emails | checked every 15 min | Schedule below |
| Ask thread purge | 04:15 daily | Threads older than 30 days |

### Features

**Portfolio and prices** (`priceService.js`, `portfolioService.js`). Crypto from CoinGecko, US
stocks from Finnhub (Yahoo as fallback), Indian stocks from Yahoo (`.NS` then `.BO`, in INR),
commodities from Yahoo futures with FMP as fallback. Every holding is converted to USD before
weights are computed. Adding a holding returns a company brief and backfills impact silently.

**IPO Watch** (`server/services/ipoWatch/`, opt-in with `IPO_WATCH=1`; merged in
pull request #13). A calendar of Indian and US public issues with its own sidebar tab.
India comes from InvestorGain (two pages a day: calendar and grey market premium, and
subscription by investor class); the US from Finnhub's IPO calendar. The `ipos` table stands
in for the company reference while a company has no ticker: stored stories are linked to an
issue by name and read for tone as news about it (`ipo_articles`). After listing the issue
gets its ticker, its outcome is logged (`ipo_outcomes`: listing gain, then listing-day,
1-week, 1-month and 3-month closes from Yahoo), and once a price confirms the ticker the
company graduates into `companies` in a tier of its own, `ipo`. A listed issue stays on the
calendar 100 days (`RECENT_LISTED_DAYS`; at 90 it left the day before its 3-month return could
be shown), and the page says when the calendar was last refreshed, with a warning past 30
hours (`STALE_AFTER_HOURS`) — the poll is daily and never runs on start. With the switch on, the news
pipeline also fetches company news for up to 10 newly filed or priced US issues and links
IPO stories at the end of each pass. A click on an issue opens its tone, a tone-by-day chart
and its stories: the latest 5, with "Show all N stories" for the rest (`IPO_STORIES_SHOWN` in
`public/js/app.js`). **`IPO_PLAN.md` is the full record**: decisions, build
status, limits. Before any hosting, InvestorGain's reuse terms must be settled (the same open
item as NSE's); BSE and NSE refuse automated requests and are not worked around.

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
logged with its cost in `claude_calls`. The daily brief's allowance is the plan's
(`TIERS[tier].claudeReportsPerDay`: Free 0, Plus 1, Pro 2); until 2026-10-10 it was a flat 1,
so the scheduler paid for a Claude brief for every Free account, which cannot open it. A
Refresh that may not use Claude keeps a Claude-written brief instead of replacing it.

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
caller is an admin. No payment provider is wired. A move to a plan whose holdings limit is
below what the account holds is refused (409, "remove N first") — Annas's choice, 2026-10-10.
The limit and the duplicate check run under a per-user lock, so parallel adds cannot pass it.

**v2: strategies, MCP and the public API.** A separate FastAPI engine (`strategy-service/`,
port 8100, lifted from Zeuniq; backtest and paper trading only). The Builder mixes technical
factors (EMA, RSI, MACD) with SenIQ factors (sentiment, smart money). Backtests carry a
buy-and-hold benchmark and a walk-forward robustness check. `/mcp` and `/v1` expose the same
data tools and strategy actions to API keys (Pro), with one shared rate budget per key; write
actions need a key created with write access. A clone of the repository has no engine, so
every strategy route answers "engine offline".

**Paper ledger (pull request #14, `v2.13`).** The Paper Trade page replays a deployment
each time it is opened and keeps nothing. A daily job (`services/paperLedger.js`) now also
stores each deployment's fills and its closing value per completed day (`paper_fills`,
`paper_equity`, migration `0042`), so a fill can be emailed and a later price revision cannot
rewrite the record. It runs at 01:15 UTC and once 20 seconds after start, only with
`FEATURES_STRATEGIES=1`, and needs the engine. Rules: completed days only (a bar dated today
UTC waits); append-only; one mark per deployment per UTC day, and a failed attempt leaves it
due; a stopped deployment is recorded through its stop date once. Fills at most 3 days old
when first recorded are emailed, one message per user (Pro, verified, alert emails on); the
first pass over an older deployment is history and is not emailed. Read at
`/api/paper/:id/ledger`, `/v1/paper/:id/ledger`, the MCP tool `get_paper_ledger`, and the
"Recorded ledger" section of each Paper Trade card. Settings: `PAPER` in `server/config.js`.
The job reads a `fills` list from the engine's replay answer; that is a **local change in
`strategy-service/`** (`engine/analytics/trades.py`, `service/backtest_runner.py`, `app.py`,
one new test), not in the repository like the rest of the engine.

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
| v2 | `routes/strategies.js`, `paper.js`, `mcp.js`, `v1.js`, `apiKeys.js`; `services/strategyClient.js`, `strategyStore.js`, `strategyTools.js`, `strategySpec.js`, `signalHistory.js`, `dataTools.js`, `apiKeyGate.js`, `paperLedger.js` |
| Strategy engine (local-only) | `strategy-service/app.py`, `service/`, `engine/`, `tests/` |
| Frontend | `public/index.html`, `js/app.js`, `css/style.css`; landing: `landing.html`, `js/landing.js`, `css/landing.css`; `docs.html` (v2) |
| Migrations | `server/migrations/` (run on boot) |
| Tests and eval | `test/*.test.js`, `eval/ask/` (`cases.json`, `run.js`; runs are gitignored) |

Two migrations share the number `0016`. This is harmless; do not rename an applied one.

### Scripts

| Command | What it does |
|---|---|
| `node scripts/india_smart_money.js poll` | One India poll (deals + up to 60 insider filings) |
| `node scripts/ipo_watch.js poll \| link \| alias \| symbols \| returns \| retone \| graduate` | IPO Watch jobs by hand (see the file's header) |
| `node scripts/paper_mark.js [--write] [--force] [--no-email]` | The paper ledger job by hand (v2; needs the engine). Without `--write` it lists what is due |
| `node scripts/india_smart_money.js history SYMBOL` | Pre-May-2026 insider trades for a symbol |
| `node scripts/india_smart_money.js import <csv> [--dry-run]` | Load a deal file downloaded by hand |
| `node scripts/rescore_sentiment.js [--write]` | Re-score stored word-list readings with FinBERT |
| `node scripts/build_listed_universe.js [--check]` | Rebuild `server/data/listed.json` from the constituent lists in `server/data/sources/` |
| `node scripts/retag_commodities.js [--write --backup <file>]` | Remove stored commodity tags the resolver would no longer give |
| `node scripts/retag_executives.js [--write --backup <file>]` | Remove stored company tags that came only from an executive's other venture (SpaceX stories on Tesla) |
| `node scripts/retag_roundups.js [--write --backup <file>]` | Remove stored company tags from roundup stories and re-grade them |
| `node scripts/reread_companies.js [--tuning] [--write --backup <file>]` | Re-read stored multi-company stories per company (needs `FINBERT_CLASSIFY=1`) |
| `node scripts/sentiment_label_sheet.js <file> [--exclude <earlier.csv>] [--whole-store]` | Write a sheet of (story, company) pairs to hand-label |
| `.venv/bin/python training/train_target_sentiment.py [--base <folder>]` | Fine-tune FinBERT on SEntFiN to read for one company (experimental; needs `training/data/SEntFiN.csv`) |
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
| `CLAUDE_REPORTS` | **`1`** (checked 2026-10-10; `0` on 2026-10-09, `1` late on 2026-10-08) | `1` lets the app call Claude: brief, Ask, alert narrative, report cards |
| `COMPANY_SENTIMENT_LLM` | **`ollama`** | A language model reads multi-company clauses: `ollama` (local, free) or `1` (Haiku). Default is off |
| `FINBERT_CLASSIFY` | **`1`** | Local FinBERT scores new stories. Default is off. `FINBERT_MODE=hosted` uses the Hugging Face API instead |
| `INDIA_SMART_MONEY`, `NSE_USER_AGENT` | **`1`**, set | India deals and insider trades. Default is off |
| `IPO_WATCH` | **`1`** (since 2026-10-09) | `1` shows the IPO Watch tab and runs its daily poll. The US side also needs `FINNHUB_API_KEY`. Default is off |
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
- The paper ledger job on 2026-10-09, against a scratch database (since dropped) and the real
  engine: three backdated deployments (AAPL, RELIANCE on NSE, a stopped MSFT) recorded 28 fills
  and 471 days on the run after start; each one's last recorded value matched the live replay;
  the stopped one was closed; the Paper Trade page showed the ledger.

- **2026-10-10, QA pass** (branch `v1-qa-fixes`, a copy of the dev database, 15 Claude calls,
  $0.106):
  - Ask through AIRouter from the page and the API: 9 questions (tools, a follow-up in a
    thread, a refusal with no model call, an advice probe, a prompt-injection attempt, a
    general explanation, smart money). Every answer came back grounded.
  - The daily brief through AIRouter, on request and **written by the scheduler on its own**
    at 15:00 IST for the three Pro accounts whose New York clock had reached 05:30; the six
    Free accounts on that clock got the code-written brief and cost nothing.
  - One alert explanation and one set of report cards through AIRouter (called directly, no
    email): 4 of 6 cards rewritten, one rewrite rejected by its check, one line left out.
  - **Two real emails to Annas**: a password reset, and an end-of-day PDF report (outcome
    `full`) **sent by the scheduler's own 14:45 run**. The copy's account was put on Sydney
    time so its 20:00 window was open. SMTP worked from the usual network that day.
  - **The IPO poll through the scheduler** (its time moved to five minutes ahead by a start
    wrapper, nothing else changed): 3 sources, 108 issues, 4 GMP and 44 subscription
    readings, 3 new outcomes; then 5 of 20 tickers found, 8 of 9 returns updated, 6
    companies graduated. No error.
  - "+ Portfolio" on IPO Watch clicked (an Indian issue: NSE, priced in rupees).
  - A browser click-through of every v1 page, and of Strategy Builder, Backtest, Your
    Strategies and Paper Trade with the engine.
  - Google and GitHub sign-in **against simulated providers** (the real routes, sessions and
    database; only the providers' HTTP endpoints stood in): 38 checks, including the state
    and nonce refusals and both account-linking rules.

- **2026-10-10, second round** (branch `v1-qa-fixes`, the QA copy `seniq_qa`, the real engine
  with its fixes, **no Claude call and no email**: the app was started with both switched off):
  - A saved EMA 20/50 strategy read **LONG, BUY 2026-04-20** for AAPL on Your Strategies, at
    `/v1/signals` and through `get_signals`; its one-year backtest entered on 2026-04-21.
  - BTC and ETH backtests and signals with the range ending today. At that moment Yahoo's
    bar for the day had BTC's last price (82,813.23) above its published high (82,799.65),
    the case that used to fail.
  - The robustness check on that strategy over one year: "insufficient data, 0 traded" on the
    page, at the route and through `run_walk_forward`; a faster strategy over three years:
    "robust", 4 of 4 windows traded.
  - A starting capital of `1e30`, `0`, a negative, text and an empty box: a message on the
    Backtest page, a 400 from the page's route and `/v1/backtest`, an error from `run_backtest`.
  - Strategy Builder in the browser: a period of 0 and an empty period stay as typed and are
    named in the box; loading a template removes the box; a template went on to a backtest.
  - **The paper ledger on real deployments**: AAPL and BTC deployed from the page's route,
    backdated to 2026-04-01 in the copy, `paper_mark.js --write --no-email` recorded 4 fills
    and 325 days, a second run recorded nothing, and the Paper Trade page showed both ledgers.

- **2026-10-10, third round** (same branch; the QA copy, since dropped):
  - **Two Claude calls, $0.012, with Annas's go-ahead.** One Ask question through AIRouter on
    an account with two unquantified holdings: the answer gave Apple as 25.9% of the
    portfolio, the page's figure, where the priced-only weight is 34.5%; grounded, 2 tool
    calls. One daily brief: no engine score in the text. It also showed two faults, both
    fixed afterwards and **not yet seen fixed in a Claude reply** (§8).
  - Through the API with the real engine: an id that no record can have is a 404 on every
    paper, saved-strategy, key and `/v1` route (six kinds of id on ten routes) and "deployment
    not found" from the MCP tools; a preset that does not exist, a setting out of bounds, a
    misspelt market and a sixth symbol are refused on save; an unknown market, a symbol with
    no price data and a commodity the engine does not price are refused on deploy, each with
    the reason, and nothing was stored.
  - An account moved off Pro in the copy: its deployments listed, the ledger read, stop and
    delete worked, deploy and the live state answered 402, and the daily job no longer
    listed its deployment.
  - In the browser: that account's Paper Trade page; a card that said "The strategy engine
    is offline" filled in on the next visit once the engine was back, with no reload; the
    deploy form's own messages; Your Strategies showing a strategy saved through the API.
- **2026-10-10, before the release** (a second throwaway copy, since dropped):
  - **One more Claude call, $0.0035, with Annas's go-ahead**: a daily brief for the demo
    account's holdings, after the fixes of the third round. Claude again put HEADLINE on a
    line of its own and it was read as the marker ("TCS hit by H-1B crackdown and earnings
    risks, broader FII selloff spreads", 12 words). No engine score, no money amount, and
    every percentage given as a share of the portfolio.
  - **v1 mode** (strategies off, Claude and email off): every strategies route answered 404
    and its pages were absent from the menu; Dashboard, Portfolio, Intelligence, Analytics
    and AI Workspace loaded with no console error; a holding was added; the code-written
    brief and Ask's code-written answer came back for a Pro account.

**Never run for real:**
- Any hosting. Scheduled reports and the India poll only run while the app happens to be up.
- The 15-minute jobs through a real morning or evening on the users' real clocks; the weekly
  summary and the weekday morning brief email.
- The end-of-day report's "closed" and "skip" outcomes.
- Google/GitHub sign-in with the real providers (no client ids are set).
- An alert email with its Claude narrative actually sent.
- Vector news search and embeddings (no `HF_API_TOKEN`, no pgvector).
- Ask's strategy tools and the strategy-draft tool against the real engine (stand-in only).
- The Ollama fallbacks against a real local model.
- The MCP server and `/v1` from a real client since 2026-10-07 (the QA pass called them with
  a test key only).
- An India alert from live NSE data.
- Email through Resend; bounce and complaint handling.
- A paper fill email actually sent (offline tests only), the 01:15 UTC ledger job firing on
  its own, and the "replay no longer matches" note on real revised prices.

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
  - Stored stories were brought in line on 2026-10-08: `scripts/retag_roundups.js --write`
    removed 65 company tags from 37 roundup stories and re-graded them (32 market, 2 world,
    3 still holding news for a company their headline is about). Backup in §9.
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
  - **Final refinement pass (2026-10-09) and the fresh test — read this before quoting any
    figure.** Four ideas were tried on sheet 1 (now the tuning set), then everything was
    scored once on a second sheet Annas labelled afterwards
    (`samples/sentiment-labels-2-2026-10-08.csv`, 101 pairs from stories never printed
    during development):

    | Reading | Sheet 1 match / opposite / confidence on matches | Sheet 2 (fresh) |
    |---|---|---|
    | Whole text | 54 / 11 / 56% | 66 / 5 / 67% |
    | FinBERT per company | 56 / 8 / 57% | 69 / 5 / 69% |
    | + local model, shared clauses only (the design before this pass) | 65 / 3 / 67% | 66 / 3 / 67% |
    | **+ local model on every story, agreement = confidence (shipped)** | 66 / 3 / 72% | 66 / 3 / 74% |
    | … with "not about" removing the tag | 72 / 3 / 75% | 70 / 3 / 76% |
    | Fine-tuned FinBERT + local model | 69 / 1 / 75% | 62 / 2 / 69% |

    - **The 54 → 65 gain in matches did not repeat.** On fresh stories nothing matched
      clearly more labels than the whole-text reading. What repeated on both sheets: fewer
      opposite-direction readings, and more confidence (a reading's weight in the ticker
      score) on matching readings.
    - **Shipped:** the local model is asked about every company of every new story
      (`TARGETED.LLM.SCOPE.ollama = 'all'`) and `targetedSentiment.combine` turns its
      agreement with FinBERT into confidence (`TARGETED.AGREE`: both agree 0.9, one neutral
      0.5, opposite directions → neutral at 0.3). In a shared clause the model's label
      stands; elsewhere FinBERT's. "Not about" → neutral at 0.3, tag kept (its "not about"
      was right 8 of 12 times on sheet 1, about 4 of 6 on sheet 2).
    - **Tried and dropped:** worked examples in the model's prompt (more "not about"
      answers, no more accurate, 2.5× slower); a wider neutral band for FinBERT (fewer
      matches); `Xenova/distilroberta-finetuned-financial-news-sentiment-analysis` as the
      base model (59 against 56 on sheet 1 — within noise, not tried on sheet 2).
    - **Fine-tuned FinBERT: built, not adopted.** `training/train_target_sentiment.py`
      trains ProsusAI/finbert on SEntFiN (`"<company> | <headline>"` → that company's
      label; 14,371 pairs). Held-out SEntFiN accuracy 65% → 88% (multi-entity headlines
      56% → 88%). On Annas's stories it helped on sheet 1 and hurt on sheet 2, so
      `FINBERT_TARGET_MODEL` is **unset**. The app can load it (`finbertClassifier.
      classifyTargets`, FinBERT as its fallback). The model is on disk in `models/`
      (gitignored, about 1.4 GB with the base weights) and the Python environment in
      `.venv/` (259 MB); both can be deleted.
    - Stored readings were written under the earlier design; only new stories get the
      agreement confidence. `reread_companies.js` would bring stored ones in line (about
      900 local-model calls). Not run.
    - No more tuning is planned. Both sheets are now used; any further change needs new
      labels.
  - **Who reads what, and the fallbacks.** FinBERT reads every new story, multi-company
    ones included, and is the default reading for everything; the word list stands in only
    if FinBERT is off or fails. In a multi-company story FinBERT also gives each company its
    own reading. The local model's label replaces FinBERT's only for companies that share
    a clause; everywhere else it only sets the confidence, and only when it answers.
  - Needs `ollama serve` running with `qwen2.5:7b-instruct-q4_0` pulled. **FinBERT is the
    fallback when it is not** *(checked 2026-10-08 with Ollama stopped)*: the call fails at
    once, one warning is logged, and every company keeps FinBERT's per-company reading. No
    tag is removed and the pipeline run carries on.
  - **Stored stories re-read (2026-10-08):** `reread_companies.js --write` updated 257
    readings on 140 multi-company stories (226 by the local model, none removed). Old rows:
    `samples/company-readings-before-2026-10-08.json`. The roundup clean-up was run after it (above).
  - Not handled: a commodity's reading follows the story's tone, not the price direction
    ("stocks retreat as oil rebounds" reads negative for oil).
- A story read as neutral just below the middle (0.46) is still worded "Reads negative" on the
  news row (`impactScoring.dirLabel` has no neutral band).
- Alerts, cached briefs and `event_outcomes` made before the re-score keep the old readings.

**QA pass (2026-10-10, branch `v1-qa-fixes`, merged as pull request #15).** `v1.12` was tested through the API and the
browser, the defects fixed, and the branch re-checked the same way (91 API probes, all pages).
What changed in behaviour:
- **Bad input is a 400 or 404, never a 500**: malformed JSON (400), a body over 100 KB (413),
  a route id that is not a plain positive number (`middleware/idParam.js`, 404), a plan or
  provider name such as `__proto__` (`tier.isTier`). An unknown `/api` path is a 404 in JSON
  and a path naming a file that is not in `public/` is a 404, not the app's page.
- **Logs no longer carry secrets**: a refused request body is not logged, and a database
  error prints without its `detail` / `where` (`db.hideRowData`) — a failed write to `users`
  used to print the row, password hash included.
- **Portfolio**: quantity and cost are capped at 1e12; a symbol in no company list with no
  price is still added but the answer carries a `warning` the page shows; the Portfolio
  table shows the same exposure figure as every other page (`exposure_pct`, marked `≈` when
  the holding has no quantity or price); "added" is said only after the server accepts it;
  the table keeps its sentiment columns through a redraw; prices re-read every five minutes.
- **The header's "Live"** turns to "Offline" when the server cannot be reached, and the
  page says so in words instead of the browser's "Failed to fetch".
- **IPO Watch**: the header's switches wrap instead of overlapping (they covered the US
  button on a phone); an issue's news wraps inside the visible width; rows open from the
  keyboard; an unknown issue id is a 404.
- **News matching**: a commodity word describing something else is not the commodity ("gold
  grills", "gold medal", "silver lining", "palm oil" — `describesSomethingElse` in
  `entityResolver.js`). Stored tags are unchanged.
- **Sign-in**: the address is trimmed at sign-in and reset; a new password equal to the old
  one is refused; in production the reset email is sent after the answer, so a registered
  address no longer answers seconds slower than an unknown one.
- The headline analyzer reads with FinBERT when it is on and says which reader it used.

**Second round (2026-10-10, same branch).** Eight findings the first round left open were
closed, three on the v1 side and five on the strategies side, and `v2.13` was run through
once more (§7). What changed in behaviour:
- **Ask gives a holding's size as the exposure figure**, the one every page shows. Its tools
  no longer hand the model a bare `weight_pct`: the overview carries `exposure_pct` (with
  `exposure_estimated` when the holding has no price or no quantity) and the attribution rows
  carry `exposure_pct` beside `priced_weight_pct`, named as the multiplier behind a
  contribution. The prompt says which is which. Seen in a Claude-written answer in the third
  round (§7): 25.9%, the page's figure, for a position whose priced-only weight is 34.5%.
- **An executive's other venture is not their listed company.** A story that names SpaceX,
  Starlink, Starship, xAI, Grok, Neuralink, the Boring Company, Twitter or X Corp beside Musk
  and does not name Tesla is no longer tagged to Tesla (`OTHER_VENTURES` in
  `entityResolver.js`; one executive so far). The stored tags made the old way were removed
  from the dev database in the third round (2 of Tesla's 11, §9) with
  `scripts/retag_executives.js`.
- **The Claude brief cannot quote the engine's scores, and its headline is a headline.**
  Claude is shown the packet through `packetForWriter()` (`briefWriter.js`): events in rank
  order with their share of the portfolio, sentiment as a label and as "above / near / below
  its usual level"; impact score, sentiment score and z-score are left out. The prompt asks
  for a headline of 12 words at most, and `tidyHeadline()` cuts a longer one to its first
  clause or to 14 words. One Claude-written brief was run in the third round: no score in
  it, and two more faults found and fixed (below). The code-written brief and Ask's
  code-written answer still say "(impact 0.17)".
- **A live signal reads two years back** after the indicator warm-up (it read about 130 bars,
  so an entry older than that was invisible and the strategy read "FLAT, no signal yet").
  With no signal in that history the chip says "no signal since" and the date. Local engine.
- **The bar still forming is repaired, not refused**: when the latest bar is dated today or
  yesterday and its open or close lies outside its high and low, the range is widened to hold
  them. A completed bar that is inconsistent is still an error. Local engine.
- **The robustness check judges only the unseen windows that held a position**
  (`n_traded_folds`, and `oos_traded` on each fold). Fewer than two is "insufficient data"
  with the reason in words; a window sat out shows "no trade". Local engine, and the page.
- **Strategy Builder keeps what was typed and says what is wrong with it**: a period that is
  0, empty, fractional or over 500, a sizing of 0, a stop or target outside 0–100 and an empty
  comparison number are listed by row in the "Fix these" box (`sbCheckUi`) before the engine
  is asked. Loading a template, an Ask draft or Reset removes the box.
- **Starting capital is checked in one place** (`parseCapital` in `strategyClient.js`): 1,000
  to 100,000,000, the paper-trade bounds, on the page's route, `/v1/backtest`, `run_backtest`
  and the comparison. Outside that is a 400 with the reason; absent is still 100,000. The
  Backtest form no longer uses the browser's own validation (its message did not show in an
  embedded browser, so the button looked dead); `btCheckInputs` names the field in a toast.

**Third round (2026-10-10, same branch).** The rest of the `v2.13` findings, the two Claude
calls and the clean-up. What changed in behaviour:
- **What is saved or deployed is checked first** (`strategyStore.js`). A built-in strategy
  must be one the engine lists and each setting one it has, of the right kind and inside its
  bounds (`presetProblem`, against the engine's catalog). A watchlist entry must be a symbol
  on a known market, five at most (`checkSymbols`); nothing is dropped or cut short silently.
  A deployment is **replayed once before it is stored**, so a symbol with no price data, an
  unknown market or a strategy that cannot run is refused with the reason. Deploying
  therefore needs the engine: offline is a 503 and nothing is created.
- **An id that no record can have is a 404**, not a 500, on the paper, saved-strategy, key
  and `/v1` routes (`idParam`), in `deployPaper` / `stopPaper`, and from the MCP paper tools.
  The preset routes take `:presetId`, a name.
- **The engine's refusals reach the user in plain words** (`plainEngineError` in
  `strategyClient.js`): a range longer than five years, an end date before the start, a
  symbol with no data, an unknown market, a commodity it does not price, an unknown
  strategy, a faulty bar. A refusal it does not recognise is passed on unchanged.
- **"Offline" means unreachable.** An engine that answers with a failure of its own is a
  **502** with its own sentence (`engineFailure`); it used to be reported as offline too.
- **An account that leaves Pro keeps the handle on what it started**: listing its
  deployments, reading a recorded ledger, stopping and deleting are open to any signed-in
  account; deploying and the live replay stay Pro. The list carries `can_deploy`, and the
  page shows the deployments with a note in place of the form. **The daily job replays Pro
  accounts' deployments only**; back on Pro, the days missed are recorded then.
- **Paper Trade recovers on its own**: a card whose live state failed has a retry button and
  asks again on the next visit to the page. The deploy form names what is wrong itself.
- **Your Strategies reads its list on every visit** and redraws when it changed.
- **A fill email waits when no provider is configured** (it was marked skipped for good) and
  lapses after three days like any other. `paper_mark.js --no-email` is now an explicit
  "record and settle as skipped".
- **The paper ledger places a fill by its date, not its instant** (`planLedger`). See the
  note below on what this does and does not fix.
- **The brief's HEADLINE marker is read in the forms Claude writes it** (on a line of its
  own, or in `** **`), and **a headline with a money amount no story states is replaced** by
  the code-written one (`headlineGrounded`). Both came out of the one brief that was run:
  the reply put the word HEADLINE on its own line, which the parser took for the first
  sentence, and it turned "25.9% of your portfolio" into "your $25.9B Apple and Bitcoin
  stakes". The prompt now says a share is never money and asks for no figures in the
  headline. The parser and the guard are tested against that reply, and a second brief, run
  before the release, came back with the headline read correctly and no money figure (§7).

**The "engine's clock" finding does not reproduce.** The first round recorded that a paper
deployment's last fill would be stored twice if the engine ran on a host in another time
zone. The engine stamps every daily bar at midnight `+05:30` from a constant, not from the
host: fills and curve came out identical with the engine run under IST, UTC and US Pacific
time (2026-10-10). The ledger now compares dates all the same, so a later change to the
engine's stamping cannot duplicate fills.

Seen in the first pass and **still not changed** (v1):
- A report card can rest on a weak link (a rupee story shown for Reliance as "same sector").
- The sign-in limiter counts successful sign-ins and is one bucket per address for sign-up,
  sign-in and reset together (20 in 10 minutes).
- The pipeline's log line says "read by the word list" when a run stored no new story.

**Front end.**
- Do not use the browser's `confirm()`, `alert()` or `prompt()`. Embedded browsers (the
  Claude desktop pane among them) suppress them and answer "no", so the button looks dead.
  Use `confirmAction(message, label)` in `public/js/app.js`, which returns a promise.

**Company reference: two tiers (2026-10-09, pull request #11).**
- `companies.tier` is `curated` or `listed` (migration `0030`). **Curated** = the hand-written
  `server/data/universe.js` (218: aliases, brands, executives). **Listed** = everything else a
  user may hold, built from published constituent lists into `server/data/listed.json` by
  `scripts/build_listed_universe.js`: symbol, name, name without its corporate tail (`core`),
  sector, and `plain` when the name is a single ordinary English word.
- **US is in: 1,398 listed companies** (1,400 until Sui and PancakeSwap took SUI and CAKE) = the S&P 1500 (Wikipedia's S&P 500 / 400 / 600 lists,
  CC BY-SA, taken 2026-10-09) less the 100 already curated.
- **India is in: 439 listed companies** = the Nifty 500 (file downloaded by Annas from
  niftyindices.com on 2026-10-09, kept as `server/data/sources/nifty500.csv`, gitignored) less
  the 57 curated and placeholder rows ("Dummy HEG"). To refresh either market: replace the
  source file(s), `node scripts/build_listed_universe.js`, restart. A session does not fetch
  from NSE's sites; one plain request was refused and none was disguised.
- **What a listed company gets:** it shows in the add-holding search
  (`GET /api/portfolio/search`, which the box calls after its built-in list), takes its name
  and, for India, its exchange from the reference when added, is priced like any stock, and
  has a sector for sector-wide news. Its badge still reads "Basic coverage".
- **What it does not get:** aliases, brands, executives. In news it is matched only while
  held, and strictly (`entityResolver.namesHolding`): its name as whole words with its
  capitals; a one-word ordinary name ("Gap", "Block") only beside a company cue ("Gap Inc",
  "Gap shares"); its symbol bare only at 5+ letters (US) or 4+ (India), else in exchange
  notation ("NYSE: THO", "$THO"). An Indian symbol that is not an ordinary word is flagged
  `brand` and matches in any capitals ("Paytm", "Nykaa"); CLEAN, AMBER, IDEA do not. A name
  inside a longer known name belongs to the longer one ("Bank of India" is not matched in
  "Reserve Bank of India" or "Union Bank of India"). The same function now also matches
  holdings typed in by hand, which fixed a substring match there ("Trent" inside "current").
- **Listed names also protect the curated tier:** a curated name or symbol inside a listed
  company's longer name is no longer tagged — "ITC Hotels" is not ITC, "Adani Power" is not
  Adani Enterprises, "Reliance Power" is not Reliance, "SBI Cards" is not SBI, "Apple
  Hospitality REIT" is not Apple. Stories stored before this keep their old tags (no
  clean-up script was written for it).
- Everything that means "the universe" still reads the curated tier only: the resolver's
  index, Ask's other-stock check, the data tools' ticker list, India insider-trade tracking,
  the "full coverage" badge.
- **Commodities: 15** (were 4). Added copper, platinum, palladium, aluminium, wheat, corn,
  soybeans, sugar, coffee, cotton, cocoa, priced from Yahoo futures. Grains, sugar, coffee
  and cotton are quoted in US cents there and converted to dollars (`priceService.fetchYahoo`).
  Each price is per the contract's own unit (pound, bushel, tonne…), so a quantity means that
  unit. The eleven new names are everyday words: they count only in a headline that also
  talks about a commodity as one (`COMMODITY_CONTEXT`: price, futures, crop, exports…).
  Brent stays read together with WTI.
- **Checked 2026-10-09** on a local run with Claude calls off: migration applied, 197 + 1,400
  seeded (then 1,839 with India, seeded directly; resolving a story takes about 1 ms), search returns listed names, the add-holding box shows them, live prices come back
  for listed stocks and the new commodities. **Not checked:** adding a listed holding end to
  end (it would have changed Annas's own portfolio) and a held listed name being matched in a
  real pipeline run.
- Known limits: an Indian company whose formal name is long and whose symbol is a word or
  an abbreviation gets little news ("Home First Finance Company India", symbol HOMEFIRST);
  Vedanta, Bosch and GAIL count as ordinary words and need a cue or their symbol — moving
  such names into the curated tier is the fix; a listed company with a one-word ordinary
  name gets less news than it should; multi-word names in an ALL-CAPS headline are missed; the commodity reading still
  follows the story's tone, not the price direction.

**Crypto: 46 curated coins and a crypto news source (2026-10-09, branch `crypto-kb`).**
- **News.** The feed had no crypto source: in 2,088 stored stories Bitcoin was in 33
  headlines, Ethereum and Solana in 4 each, most curated coins in none. Four crypto outlets
  now come in through the existing RSS reader (`INGEST.RSS_FEEDS`): CoinDesk, Cointelegraph,
  Decrypt, The Block. One live read gave 112 crypto stories, 68 naming a curated coin
  (Bitcoin 34, Ethereum 17, Solana 11). Finnhub's `news?category=crypto` works on the free
  key but is CoinDesk and Cointelegraph again, so it is not used. No key was bought.
- **Coins: 46** (were 25). Added Zcash, Hyperliquid, Monero, Hedera, Quant, Bittensor, Ethena,
  Aave, Ondo, Worldcoin, Internet Computer, Pepe, Jupiter, Algorand, Render, Filecoin,
  Aerodrome Finance, Injective, Raydium, Sui, PancakeSwap: CoinGecko's top 100 on 2026-10-09 less stablecoins,
  wrapped / staked / bridged copies, tokenised funds and gold, and exchange tokens, trading
  $50M+ a day. Hyperliquid is 1.9 years old and was let in by Annas. Each price key was
  confirmed by one live CoinGecko request.
- **Sui took the symbol SUI from Sun Communities, and PancakeSwap took CAKE from The
  Cheesecake Factory**, at Annas's word: a symbol can belong to one thing, so `listed.json`
  was rebuilt and those two stocks left it (1,837 listed, 1,398 US). PancakeSwap was added
  after the pipeline run below, so no story is tagged with it yet.
- **Everyday-word coins** (`CRYPTO_NEEDS_CONTEXT` in `entityResolver.js`): seventeen of the new
  coins have a name or a symbol that is a word, a place or a person (Jupiter, Render, Quant,
  Pepe, Ondo, Sui; HYPE, RAY, ICP, FIL, CAKE…). They count only when the story also talks about crypto
  (`CRYPTO_CONTEXT`: token, blockchain, DeFi, Bitcoin, Solana… or the coin's own distinctive
  name), anywhere in the headline or summary. The seven word-names also need their capital.
  The older word-coins (Avalanche, Cosmos, Polygon; symbols NEAR, LINK, DOT, UNI, ETC) are
  not under this rule and still match on the capital or the bare symbol alone.
- **One pipeline run, 2026-10-09** (from the `crypto-kb` worktree, local database, email
  off): 132 new stories stored, all read by FinBERT (Ollama was not running; GDELT returned
  nothing). Coin readings in the database went from 73 to 228. New coins named: Sui 5,
  Zcash 5, Monero 3, Render 2, Hyperliquid 2, Pepe 2; the other fourteen, none yet.
- **The 21 new coins are inactive in the dev database until this branch is on the checkout
  the server runs from.** Every boot seeds the universe from that checkout's own file and
  switches off curated rows it does not list; a server started from `ipo-watch` did so
  seconds after the run. Stored stories keep their tags. Sun Communities and The Cheesecake Factory are off too once seeded from this branch.
- **Not done:** the rest of the top 100 as a listed tier (the listed tier is for companies
  today). The new coins' sentiment has not been looked at.
- CoinGecko now calls Toncoin "Gram (prev. Toncoin)", symbol GRAM. The curated entry is
  left as TON / Toncoin: holdings are keyed by symbol, and "Gram" is an everyday word. The
  price key (`the-open-network`) still works.

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
| 257 readings on 140 multi-company stories re-read per company (226 by the local model); none removed | `company-readings-before-2026-10-08.json` |
| Migration `0030` (company tier); 1,839 listed companies and 11 commodities seeded (2026-10-09) | none needed (re-seeded from files) |
| 65 company tags removed from 37 roundup stories; 28 `__MARKET__` readings added; those stories re-graded | `roundup-tags-before-2026-10-08.json` |
| 5 `event_outcomes` rows for Indian tickers had a pre-fix `price_at_event` blanked | none |
| Account 36 rebalanced; marked verified by hand | none |
| 2 of 11 stored Tesla tags removed: stories about SpaceX and Starlink, tagged through Elon Musk (2026-10-10, `scripts/retag_executives.js --write`) | `removed-executive-tags-2026-10-10.json` |

`samples/` also holds a sample report PDF built from account 36, and
`sentiment-labels-2026-10-08.csv` and `sentiment-labels-2-2026-10-08.csv`: the two
hand-labelled sheets of (story, company) pairs (§8).

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

**The 2026-10-10 QA pass of `v2.13`: closed.** Every finding was fixed in the second and
third rounds (§8), except one that did not reproduce (the engine's clock, §8). Known limits
that remain, none of them a defect waiting for a fix:
- A signal's state is the last entry or exit **in the history read** (two years after
  warm-up, 1,500 days at most). A slow strategy whose entry is older than that reads "FLAT,
  no signal since" and the date, where a longer backtest would show it long.
- A rule between two settings of a built-in strategy (a fast average shorter than the slow
  one) is not in the engine's catalog, so it is caught when the strategy first runs — on
  deploy, or on the first signal — not when it is saved.
- A deployment made before the checks existed can still be one that cannot run; the daily
  job reports it with the reason and exits 1 until it is stopped or deleted. The dev
  database has none.
- The code-written brief and Ask's code-written answer still say "(impact 0.17)".
- The body of a Claude-written brief is not checked against the packet the way an Ask
  answer is. Of the two briefs run on 2026-10-10, the first tied a market-wide figure from a
  story's title to the reader's own position (the prompt now says not to; the second did
  not), and the second closed on a mild forecast ("suggests near-term volatility"). Only the
  headline has a guard.

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
- Re-run `retag_executives.js` after adding an executive to `OTHER_VENTURES`.

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
  off; `v2.N` is the same commit with `FEATURES_STRATEGIES=1`. **Exception (Annas, 2026-10-09):**
  a change that only touches the strategies side gets a `v2.N` tag alone. The two numbers can
  therefore differ; the next change to both sides takes the next free number of each.
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
| `v1.8` / `v2.8` | `d13a560` | #8: per-company sentiment (FinBERT per company, optional local or hosted language model), roundups as market stories, re-read and labelling scripts |
| `v1.9` / `v2.9` | `55c5fe3` | #9: in-page confirm dialog for the delete and stop buttons; README restored and brought up to date, with the hand-label sentiment results |
| `v1.10` / `v2.10` | `839df81` | #10: the local model reads every story and its agreement with FinBERT is the confidence; optional fine-tuned FinBERT (off); two-sheet scoring; README results corrected |
| `v1.11` / `v2.11` | `68ef315` | #11: two-tier company reference (1,839 listed companies: S&P 1500 and Nifty 500), strict matching for held listed names, listed names shielding curated ones, 15 commodities |
| `v1.12` / `v2.12` | `d9ec9df` | #13: IPO Watch (opt-in) — Indian and US IPO calendar, grey market premium and subscription, stories linked and read for tone, outcomes to the three-month close, graduation into the company reference as an `ipo` tier. Also #12: the curated coins and crypto news feeds |
| `v2.13` (no `v1.13`) | `f3638fb` | #14: the paper ledger — a daily job stores each paper deployment's fills and closing value from completed days, emails a new fill, and the record is read on the Paper Trade page, at `/v1/paper/:id/ledger` and through `get_paper_ledger` |
| `v1.13` / `v2.14` | `71230ec` | #15: the QA pass of 2026-10-10 — no new feature, no migration. v1: bad input is a 400 or 404, logs carry no bodies or failed rows, Ask's holding size is the exposure figure, an executive's other venture is not their company, the brief's writer sees no engine scores and its headline is checked. v2: saves and deployments are checked first, bad ids are 404s, engine refusals in plain words, starting capital bounded, the Builder keeps what was typed, the robustness check counts traded windows, an account off Pro keeps the handle on its deployments |

Pull request #6 was closed by GitHub when its base branch was deleted; #7 replaced it.

**Pull request #8** (`per-company-sentiment`) was merged on 2026-10-08 as `d13a560`, at
Annas's request from a session, and the branch deleted: roundups as market stories,
per-company sentiment, the local-model step and the labelling scripts. Tagged `v1.8` / `v2.8`.

**Pull request #9** (`in-page-confirm`) was merged on 2026-10-08 as `55c5fe3`, at Annas's
request, and the branch deleted. Tagged `v1.9` / `v2.9`. The five buttons that asked "are you sure?"
with the browser's `confirm()` (delete an Ask conversation, delete a strategy, stop or delete
a paper deployment, revoke an API key) now use an in-page dialog, `confirmAction()` in
`public/js/app.js`.

**Pull request #10** (`sentiment-agreement`) was merged on 2026-10-09 as `839df81`, at Annas's
request, and the branch deleted. Tagged `v1.10` / `v2.10`. The local model reads every new story and
its agreement with FinBERT is the reading's confidence; an optional fine-tuned FinBERT is
wired but off; the README's results section now carries both label sheets (§8).

**Pull request #11** (`listed-universe`) was merged on 2026-10-09 as `68ef315`, at Annas's
request, and the branch deleted. Tagged `v1.11` / `v2.11`. The company reference has two tiers (§8):
1,839 listed companies (S&P 1500 and Nifty 500) can be searched, held and priced, and are
matched in news strictly and only while held; commodities go from 4 to 15.

**Pull request #13** (`ipo-watch`) was merged by Annas on 2026-10-09 as `d9ec9df`. Tagged
`v1.12` / `v2.12`, and the branch deleted. IPO Watch (§5) is behind `IPO_WATCH=1`: eleven
migrations (`0031`–`0041`), `server/services/ipoWatch/`, a tab with an India / US switch, and
two touches on the news pipeline (company news for newly filed or priced US issues; linking
and reading IPO stories at the end of each pass). `IPO_PLAN.md` is the full record.

**Pull request #15** (`v1-qa-fixes`) was merged on 2026-10-10 as `71230ec`, at Annas's
request from a session, and the branch deleted. Tagged `v1.13` / `v2.14`: both sides
changed, so each took its next free number. It holds the QA fixes of §8 (all three rounds),
20 commits. The engine's part of the second round is in `strategy-service/` and in no
commit.

**Pull request #14** (`paper-ledger`) was merged by Annas on 2026-10-09 as `f3638fb`. Tagged
**`v2.13` only**, and the branch deleted. The paper ledger (§5): migration `0042`,
`server/services/paperLedger.js`, a scheduler job, three read paths and `scripts/paper_mark.js`.

---

## 12. Other documents

| File | What it is | Current? |
|---|---|---|
| `PLAN.md` | Original phased product plan | Phase order superseded by the roadmap |
| `SenIQ_Roadmap.pdf` | Re-sequenced roadmap (deploy first, then OAuth and billing). Rebuild: `python3 scripts/build_roadmap_pdf.py` | Yes, for ordering |
| `ENGINE_PLAN.md` | Engine phases E1–E6 (all done) and the v2 engine scope | v2 scope is open |
| `STRATEGY_PLAN.md` | Strategy service, Builder schema, MCP design, paper ledger | Built |
| `RAG_PLAN.md` | Ask, retrieval and signals plan (agreed 2026-10-07); India filings spike notes | Partly built |
| `IPO_PLAN.md` | Sentiment for IPOs and small/mid-caps, where 13F and congress data are blind | Change 3 (IPO Watch) and Change 4 (graduation) built, pull request #13; Changes 1, 2 and 5 are plan only |
| `DEPLOY.md` | Render + Neon + Cloudflare steps | Ready, not executed |
| `README.md` | Project overview, features, setup (macOS and Windows), known limits | Yes — rewritten 2026-10-08 against this handoff, up to `v1.8` / `v2.8`; later features added section by section, latest `v1.13` / `v2.14` |
