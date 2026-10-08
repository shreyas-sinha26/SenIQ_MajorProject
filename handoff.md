# Handoff — SenIQ (updated 2026-10-08)

**Current state in one paragraph:** v1 (Dashboard → Portfolio → Intelligence → Analytics →
AI Workspace) and v2 (+ Strategy Builder, Your Strategies, Backtest, Paper Trade, MCP, public
API) run from **one codebase** on `main`, split by a feature switch. Tags `v1.0`–`v2.2` mark
the state up to `a66a164`. **The 2026-10-07/08 work is merged into `main`** (pull request #1,
merge commit `ac88e2a`, six commits, not yet tagged). It covers the company knowledge base,
alert quality and email safeguards, the v2/MCP round, and the Ask, retrieval and signals work
in `RAG_PLAN.md`; the matching engine edits live only in the gitignored `strategy-service/`.
Every commit passes `npm test` on its own. Nothing in the merge has run with a real model
key, real embeddings, or the real strategy engine behind the app.

**Where things stand (end of 2026-10-08):** three commits sit on the local branch
`hardening-email-reports`, **not pushed**: `be98ba8` (hardening pass, Gmail sending, PDF report
emails, Claude through AIRouter), `b5e47f3` (handoff), `2187d91` (Ask: stated rankings in tool
results, stricter grounding rules, eval runner through the router, verification-button UI).
`npm test` is green (354 checks). `origin/main` has one newer commit from Shreyas (`ffa4fde`,
README only — no overlap). `.github/workflows/ci.yml` is still left out of commits (needs the
`workflow` token scope). The dev database is on migration 0025.

**Running right now:** the app, at http://localhost:3010, started from the Claude Code preview
(`seniq-main`). `.env` has `AIROUTER_API_KEY` + `CLAUDE_REPORTS=1`, so **the app can spend
credits by itself** (see "Standing instruction" below). Stop it when not in use.

**Standing instruction from Annas (2026-10-08): make no Claude API calls until he says so.**
That holds the eval rerun and any trial of another model. The app itself still calls Claude
while `CLAUDE_REPORTS=1`: Ask and the brief when he uses them, the 05:30 brief job, and a Pro
alert narrative when a realtime alert fires for a verified Pro account. `CLAUDE_REPORTS=0` +
restart turns all of that off (and Ask with it).

**Next, in order:**
1. Push: `git fetch`, merge `origin/main` into the branch (merge, not rebase), `npm test`,
   push with the `Annas-Shariff` gh account, open a pull request (§8). Not yet asked for.
2. When Annas allows model calls again: rerun the 30-case eval (~$0.50) to measure the tool
   change in `2187d91`; then, if wanted, one run with another answer model via
   `AIROUTER_MODEL` (eval only). He should also read ~10 judged answers — the judge is strict
   and has not been checked against a human.
3. Email: outgoing mail ports were blocked on the network used on 2026-10-08, so nothing sent
   that day after the first test. Retry on another connection: one alert email and one PDF
   report to his account (id 36 — Pro, verified by hand, five demo holdings). The PDF version
   of the report has been reviewed as a file but never emailed.
4. Decisions still open: which SEC contact email is right (`render.yaml` says
   `affiliates@arnifi.com`, `config.js` defaults to `admin@xynthis.com`); whether to buy a
   domain (needed for real email at launch — Gmail is for demos, and many hosts block mail
   ports too).

**Still switched off or never run for real:** Indian prices (Upstox), news embeddings (Ask's
news search runs in keyword mode), hosting — so sentiment history is only a few weeks and
SenIQ-factor backtests mean little — the strategy engine behind the app in this round, the
Pro end-of-day report, and the daily brief / alert narrative through the router (only Ask and
one brief have gone through it).

### Hardening pass (2026-10-08, in `be98ba8`)
A read-through of the whole Node app, then fixes. Nothing here changes a feature.
- **Crashes:** every router is built with `server/middleware/asyncRouter.js`, so an error in an
  `async` handler is a 500 for that request. Before, it ended the process (Express 4 ignores
  rejected promises) — e.g. a non-string `text` to `/api/news/analyze`, or a bad `:id`.
- **Checkout stub** (`routes/billing.js`) refuses in production unless the caller is an admin.
- **User-supplied URLs** (analyze-a-link, webhooks) go through `services/safeFetch.js`: public
  addresses only, re-checked on each redirect, capped body. Webhooks: Pro to register, max 5.
- **Sign-in:** linking Google/GitHub to an account whose email was never verified removes that
  account's password. A password change or reset ends all older sessions (migration `0024`,
  `users.password_changed_at`). The OAuth token returns in the URL fragment. Passwords are 8–72
  characters. `authMiddleware` now reads the user row (deleted users and OAuth state tokens are
  refused) and hands it to the tier middleware, so it is still one query per request.
- **Ask quota** is reserved under a per-user lock before Claude is called (`reserveQuestion` in
  `qa.js`); parallel requests can no longer all pass the check. The daily-brief quota counts
  briefs only.
- **`CLAUDE_REPORTS` is now an env var** (`CLAUDE_REPORTS=1`), still off by default.
- **Limits:** per-user rate limits on Ask, analyze, live sentiment routes and web backtests
  (`middleware/rateLimit.js`); `POST /api/smart-money/poll` is admin-only.
- **Input/output:** tickers and exchanges are validated on add; the frontend escape helper is
  safe inside attributes and feed links must be http(s).
- **Headers:** CORS only on `/v1` and `/mcp`; a Content-Security-Policy on every response
  (still allows inline scripts — the pages use `onclick`).
- **Deploy files:** `.dockerignore` excludes `strategy-service/`, `eval/`, `.claude/`;
  `render.yaml` lists every env var the code reads; `.env.example` matches the code.
- **Cleanup:** one strategy-engine client (`services/strategyClient.js`, incl. `replayPaper`)
  used by the web routes, `/v1` and `/mcp`; `public/logo-test.html` removed; `npm audit fix`
  (critical + high advisories gone; 25 moderate remain, the rest need `node-cron` 4).
- **Tests:** `test/hardening.test.js` (12 checks) added to `npm test`.
- **Not done / to decide:** the app was not started against the database in this pass — do
  that once (it applies `0024`) and click through sign-in, portfolio add, Ask and a backtest.
  The global $/day Claude ceiling can still be overshot by a few calls when several users ask
  at the same moment. The SEC contact email differs between `render.yaml` and `config.js`.
  Two migrations are numbered `0016`; harmless, and renaming an applied one would re-run it.

### Email sending + report emails (2026-10-08, in `be98ba8`)
- **Sending without a domain:** `emailService.js` sends through Resend when `RESEND_API_KEY` is
  set, otherwise through SMTP (`SMTP_HOST/PORT/USER/PASS`, nodemailer) — a Gmail app password,
  ~500 emails/day, sent from that address. Moving to a domain later is an `.env` change only.
  **Status: working. One sample daily report (the first, HTML-body version) was sent to
  Annas's own address on 2026-10-08 and Gmail accepted it. The PDF version has been rendered
  and reviewed as files but not yet emailed.** `.env` now has `SMTP_*`, `EMAIL_FROM` and
  `APP_URL=http://localhost:3010` (the dev port).
- **Report emails** (`services/reportEmails.js`, migration `0025`, cron every 15 min): Free gets
  a weekly summary Sunday 18:00, Plus/Pro the daily brief weekdays 08:30 — in the local time of
  the user's market (`users.home_market`, else worked out from the portfolio: India or US).
  Only to verified addresses with `users.email_reports` on. Each report is claimed in
  `report_sends` before sending, so it goes out once per local day. The daily email is the
  in-app brief (same writer and Claude guardrails). Own unsubscribe link (`?list=reports`).
  Profile has the switch and the market choice. Not built: the Pro end-of-day wrap.
- **The report is a PDF attachment** (`services/reportPdf.js`, pdfkit + embedded Inter so ₹
  prints): header, most important event, figures strip, what changed, events table, holdings
  with exposure bars, smart money, disclaimer + page numbers. The email body is one line
  ("Here is your SenIQ daily brief for …, attached as a PDF") plus the stop link — Annas asked
  for this after seeing the first HTML version. `sendEmail` takes `attachments` on both
  transports. Alert emails are unchanged (still HTML).
- Fixed on the way: the header profile button never loaded the email settings.
- Tests: `test/reportEmails.test.js` (15 checks). Migrations 0020–0025 are applied on the dev DB.
- **To finish:** email the PDF version to Annas once (he was asked, no answer yet) → sign up
  in the app with a real address → verify it (the first real verification email) → check one
  alert email and one scheduled report arrive. No dev account uses a real address yet, so
  nothing is sent on its own until then. Scheduled reports need the server running at send
  time, so they are hit-and-miss until it is hosted.
- New dependencies: `nodemailer`, `pdfkit`, `@expo-google-fonts/inter` (the embedded font).

### Claude through AIRouter (2026-10-08, in `be98ba8`)
- Annas bought credits on AIRouter (airouter.in — OpenAI-compatible only, `POST
  https://api.airouter.in/v1/chat/completions`, models named `provider/model`).
- `services/llmClient.js`: when `AIROUTER_API_KEY` is set, the brief, Ask (incl. its tool loop)
  and the alert narrative go through a client that keeps the Anthropic `messages.create()`
  shape and translates to/from chat-completions. Without it, `ANTHROPIC_API_KEY` works as
  before. Model: `AIROUTER_MODEL`, default `anthropic/claude-haiku-4.5` ($1/$5 per M tokens,
  same as direct). The router's reported `total_cost` is what gets logged to `claude_calls`.
- Still needs `CLAUDE_REPORTS=1`. All quotas and the $5/day ceiling apply unchanged.
- Tests: `test/llmClient.test.js` (7 checks, scripted router).
- **First real call (2026-10-08): the router accepted the key but refused Claude Haiku 4.5 with
  403 `plan_restricted` — "This model requires a paid plan. Add credits to unlock all models."**
  Ask fell back to the data summary and gave the question back to the quota, as designed. So
  the credits are not on the account this key belongs to (or had not landed yet). The same
  question through `airouter/free` got a reply, but that model called no tools and invented a
  headline — it proves the connection only, and is not usable for Ask. Tool calling against
  real Claude on the router is still unproven. `.env` has `AIROUTER_API_KEY` + `CLAUDE_REPORTS=1`.
- **Working (2026-10-08, after the credits landed):** one Ask question through the running
  app as the demo Pro account → real Claude Haiku 4.5 via the router (served by Bedrock),
  three tool calls (`get_top_events`, `get_attribution`, `get_portfolio_overview`), 10 s,
  6,700 in / 445 out tokens, **$0.0089** logged from the router's own figure, quota counted.
  Daily brief and alert narrative via the router are not yet exercised.
- Three things seen in that first answer, fixed the same day: markdown is stripped from Ask
  answers (`toPlainText` in `qa.js`, the app shows plain text); the prompt now sets a hard
  length (≤ 6 sentences, ~120 words) and forbids markdown; and word-like tickers (NEAR, COST,
  LINK, COIN…) only count when written as symbols, so "near-term" no longer trips the
  grounding check. **The new length rule has not been checked against a live answer yet.**
- Note: shells started from Claude Code carry their own `ANTHROPIC_BASE_URL`; it is not in
  `.env` and does not matter while the router key is set.

### First Ask eval run (2026-10-08) — `eval/ask/runs/2026-10-08T06-49-53/` (gitignored)
- 30 cases × 1 rep, answers by Haiku 4.5 and judge Sonnet 5.5, both through AIRouter.
  `eval/ask/run.js` uses the router when `AIROUTER_API_KEY` is set (in `2187d91`).
  Judge self-test passed first. Spent $0.48 ($0.20 answers, $0.29 judge). No infra errors.
- **Automatic checks: 26/30.** Right tools 19/19, scope refusals 5/5, no data leak 6/6, no
  advice 28/28, concise 28/28, no markdown. Grounded 24/28 — of the four misses, `edu-02` is a
  general 13F explanation (the checker should not count it), `move-01`/`smart-02` are figures
  the model computed or reformatted, `news-05` has two dates not in the evidence.
- **Judge: 2/28 pass every line**; per line: no-advice 27/28, concise 27/28, case-specific
  36/51, honest-gaps 8/20, grounded 4/27. The judge is strict and not yet checked against a
  human read. What it keeps finding: news answers give dates but not source names; causal
  claims the tools never made ("market-wide sell-off"); unpriced TCS/RELIANCE and truncated
  tool results not flagged; smart-money rows without each disclosure date; `followup-02`
  invents where to add a holding. `news-04` ("last month") only had one day of events — a
  data-depth limit, not the model.
- One rep only; the runner's own noise floor is 0.18, so do not read small differences.
- Gotcha: a freshly created fixture user has no impact rows until the pipeline runs — run
  `recomputeImpactsForUser(<id>)` first (done by hand this time; the runner should do it).
- **Second run, same day** (`runs/2026-10-08T07-05-09`, $0.48) after tightening the prompt on
  those five points (sources + dates per story, no asserted causes, flag missing data, dates
  on every smart-money trade, "Add Asset on the Portfolio page") and making `ensureFixture`
  compute impacts: **no real change overall.** Automatic 26/30 → 26/30; judge full-pass 2/28 →
  2/28; honest-gaps 8/20 → 12/19 (better); grounded 4/27 → 2/28, no-advice 27 → 25, concise
  27 → 24, case lines 36/51 → 37/50 (all inside the 0.18 noise floor). `followup-02` now points
  to the Portfolio page. What is left is factual slips by Haiku 4.5, not missing rules: calls
  the third-largest holding "largest", gets a congressional trade's direction wrong, says
  results were "released" when only previews exist, adds its own interpretation.
- **Conclusion so far:** guardrails (scope, tools, no advice, length) are solid; precision on
  facts is the weak spot and prompt wording alone does not move it. Options, none run yet:
  try a different answer model through the router for the eval only (`AIROUTER_MODEL`), give
  tools pre-ranked fields so the model does not rank by itself, and have Annas read ~10 judged
  answers — the judge fails a whole line for one loose phrase and has not been checked
  against a human. Eval spend today ≈ $1.00.
- Annas's account (id 36) was marked verified by hand at his request.
- **Tools now state the comparisons** (no model call needed to build this; not yet re-evaluated):
  `get_portfolio_overview` returns holdings largest-first with `rank`, `largest`,
  `order_by_exposure` and `unpriced`; `get_attribution` adds `biggest_drag`, `biggest_lift`,
  both totals and `offsetting`; `get_top_events` adds `rank`; `get_smart_money` adds a tally
  per action ("4 rows: 3 sell, 1 buy"). Aimed at the ranking and buy/sell slips above.
- **Annas has asked for no Claude API calls until he says so (2026-10-08).** The rerun to
  measure the tool change, and any trial of another answer model, wait for his go-ahead.
  Note the running app can still call Claude by itself while `CLAUDE_REPORTS=1`: Ask and the
  brief when he uses them, the 05:30 brief job, and a Pro alert narrative when a realtime
  alert fires for a verified Pro account (his is one).
- Profile: the "Send verification link" button now shows "Sending…" greyed out, then a 30 s
  "Send again in Ns" countdown.
- Also seen today: this network blocks outgoing mail ports, so the verification email to
  Annas's new account (id 36, now Pro, five demo holdings) failed three times — not a code bug.

### The 2026-10-07 session at a glance (details in §3; merged in pull request #1)
| Area | What changed | Migration |
|---|---|---|
| Company knowledge base | 129 → 186 companies; 17 → 192 executives, all dated; refresh script; tighter news matching | `0017` |
| v2 strategies + MCP | first end-to-end run; 8 SenIQ data tools on MCP and `/v1`; walk-forward; buy-and-hold benchmark; write-permission keys + 3 write tools; `sentiment_acute` factor | `0018` |
| Strategy engine (local-only) | dropped-entry fix (changes every preset backtest number), benchmark, walk-forward endpoint, new factor | — |
| Alert quality | market news grouped into stories and scored per user; holdings threshold 0.35 → 0.10; event-type weight; caps | — |
| Email safeguards | verified-address check, unsubscribe + preference, send log, resend-verification | `0019` |
| Ask | scope pre-check no longer refuses "F&O", "PM", "Series C"; ignores commodities; golden case `scope-04` → Paytm | — |

**How it was committed (2026-10-08, pull request #1, merged with a merge commit):** six
whole-file commits in dependency order, because many files carry changes from more than one
theme — (1) config, (2) knowledge base and data coverage, (3) alerts and email, (4) Ask,
retrieval, filings, grounding, strategy tools and eval, (5) v2 API surface, (6) frontend and
docs. Authored as Annas Shariff, no AI attribution.
**The engine stays private:** `strategy-service/` is gitignored, so a clone of this repository
has no strategy engine at all. With it missing, every strategy route answers "engine offline";
the new SenIQ factors, walk-forward and the benchmark exist only in the local engine copy.
**`.github/workflows/ci.yml` is deliberately left uncommitted** — a push that contains a
workflow file is rejected until the token has the `workflow` scope (see §8).

---

## 1. Versions & tags (all on GitHub)

| Tag | Commit | What it is | How to run |
|---|---|---|---|
| `v1.0` | `24148b2` | v1 on the old dark theme (presentation fallback) | `npm start` |
| `v1.1` | `673791a` | v1 on the light theme + sliding nav | `npm start` |
| `v2.1` | `673791a` | same code, strategies on | `FEATURES_STRATEGIES=1 PORT=3030 npm start` + strategy engine |
| `v1.2` | `537612d` | v1.1 + Google/GitHub sign-in, password reset, alert emails | `npm start` |
| `v2.2` | `537612d` | same code as v1.2, strategies on | `FEATURES_STRATEGIES=1 PORT=3030 npm start` + strategy engine |

History since the July push (`ac6d217`), newest first:
```
537612d Merge origin/main: Google/GitHub sign-in + alert emails        (v1.2, v2.2)
ff9fe88 Add alert notification and narrative services with tests       (Shreyas)
9121338 Google Auth added                                              (Shreyas)
5b04cbe Ask eval set: 30 golden cases (eval/ask/cases.json)
406f7d4 Handoff: current state
673791a Light theme on the brand palette + sliding nav indicator      (v1.1, v2.1)
24148b2 v1/v2 split: STRATEGIES feature switch (off by default)       (v1.0)
d08fe98 Ask v2 — tool-calling agent, news search (RAG), saved conversations
```
Still local only: `.github/` (CI workflow — see §8), `strategy-service/` (gitignored), and the whole
2026-10-07 session (merged in pull request #1 — see the table above).
`v1.2`/`v2.2` pass `npm test` but have **not been clicked through in the browser** yet.

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
- From Claude's preview pane the launch names are `seniq-main` (v1, :3010) and `seniq-v2` (:3030);
  they live in `~/.claude/launch.json`. The pane **cannot** start the engine (macOS blocks it from
  reading the venv in Downloads) — start it from a shell with absolute paths:
  `STRATEGY_SERVICE_SECRET="$(grep '^STRATEGY_SERVICE_SECRET=' .env | cut -d= -f2-)" strategy-service/venv/bin/uvicorn app:app --port 8100 --app-dir strategy-service`
- Every app boot runs the news pipeline; several restarts in a row hit Finnhub/CoinGecko 429s and
  prices come back null until it clears.
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
- **`explain_sentiment` (2026-10-07, merged in pull request #1):** ninth Ask tool, also on MCP and
  `/v1/tickers/:ticker/sentiment/drivers`. Returns the stories behind a ticker's acute score with
  each one's exact share of the z-score. Plan for Ask/retrieval/signals work: `RAG_PLAN.md`.
- **Story-level hybrid search (2026-10-07, merged in pull request #1):** migration `0020_article_search` adds a
  full-text column; `search_news` now returns story cards (full-text + vector fused per story,
  re-ranked by the user's impact) and `get_story_detail` expands one. **0020 has not been applied
  to the dev database yet — it runs on the next app start.** Vector half still never run.
- **Grounding check, thread digest, local-model tier (2026-10-07, merged in pull request #1):**
  `answerCheck.js` audits each model-written answer against its evidence and stores the result
  (migration `0021_ask_grounding`, applied 2026-10-08; `GET /api/admin/ask-grounding`). Older
  turns reach the model as a code-built digest. `ASK_OLLAMA=1` adds a local-model tier between
  Claude and the data summary — never run against a real model.
- **Strategy tools in Ask (2026-10-07, merged in pull request #1, v2 mode only):** `strategyTools.js` adds four
  read-only tools (my strategies, paper performance, explain a signal, preset catalog) and a
  prompt addendum. Tested with a stand-in engine only — not yet against `strategy-service`.
- **Eval code + three data fixes (2026-10-07, merged in pull request #1):** `eval/ask/lib.js` + `run.js`
  (`--check` is free and offline; `--run --yes-spend --max-usd N [--judge]` is the paid run,
  never executed). GDELT now covers all 57 Indian universe names (12 per run, rotating); all 25
  universe coins have a CoinGecko price ID and resolve as crypto; commodities are matched on the
  headline only. Stored articles keep their old commodity tags until re-resolved.
- **Smart-money factors (2026-10-07, merged in pull request #1; engine edits local-only, engine tests 37 → 48):**
  CUSIP map now covers all 100 US universe names (OpenFIGI-verified) with an automatic ticker
  backfill on stored 13F rows (runs on next app start); new engine factors `congress_buys`,
  `congress_sells`, `congress_buyers`, `politician` param, `funds_holding`, `funds_net_adds`,
  `funds_new_positions`; four SenIQ presets (`server/data/seniqPresets.json`); with/without-SenIQ
  comparison on `/api/strategies/compare`, `/v1` and MCP. **Fixed: dates sent to the engine were
  one day early east of GMT (lookahead) — earlier SenIQ-factor backtests from this machine were
  affected.** The Node code needs the local engine copy for the new factors.
- **Company filings (2026-10-07, merged in pull request #1):** migration `0022_disclosures` (applied on the dev database 2026-10-08),
  `services/disclosures.js`, Ask/MCP/`/v1` tool `get_disclosures`. SEC 8-Ks for held US-listed
  stocks, fetched lazily after the smart-money poll (4 tickers per poll; `DISCLOSURES=0`
  disables). Live-checked against EDGAR on a scratch DB. India (NSE/BSE) was only spiked — all
  routes reachable, findings in `RAG_PLAN.md` — nothing built.
- **Plain English → strategy draft (2026-10-07, merged in pull request #1, v2 only):** Ask tool
  `draft_strategy` validates a Builder spec the agent writes (`services/strategySpec.js`, plus
  the engine when reachable) and returns it as `draft` on the ask response; stored on the turn
  (migration `0023_ask_drafts`, applied 2026-10-08). Saves nothing. Tested with a scripted model
  only.
- **UI pass (2026-10-08, merged in pull request #1):** "Basic coverage" label and click-a-score sentiment
  drivers on the Portfolio table; grounding badge and strategy-draft card with "Open in Strategy
  Builder" in the AI Workspace; new congress/fund factors and SenIQ templates in the Builder;
  "Compare without SenIQ signals" on Backtest results. Checked in a browser on a scratch DB copy;
  the two strategy pages only against a stand-in engine. **Fixed: engine returns are fractions —
  the paper-performance tool and the comparison were reporting them as percentages.**
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

### Merged from Shreyas (Aug 2026) — tags v1.2 / v2.2
- **Sign-in (Phase 5):** Google + GitHub OAuth (`server/routes/oauth.js`), forgot/reset
  password + email verification (`authTokens.js`, `emailService.js` via Resend), per-IP rate
  limits on login/reset (`AUTH_LIMITS`). Migration `0016_oauth_accounts` (nullable
  `password_hash`, OAuth identity columns, `auth_tokens`). Buttons show only for providers
  whose ID + SECRET are set (`/api/config` → `oauth`).
- **Alert emails:** `alertNotifier.js` emails realtime alerts (Free: none, Plus: standard,
  Pro: + a 150–250-word narrative from `alertNarrative.js`: Claude → Ollama → template
  fallback, 5 narratives/user/day). Needs `RESEND_API_KEY` to actually send.
- **Merge notes:** `/api/config` returns both `features.strategies` and `oauth`; two
  migrations share the `0016` prefix (`ask_threads`, `oauth_accounts`) — fine, the runner
  keys on the full filename and they touch different tables.

### Company knowledge base refresh (2026-10-07, merged in pull request #1)
- **Universe 129 → 186:** US 54 → 100, India 50 → 57 (added TRENT, BEL, ETERNAL, JIOFIN, INDIGO,
  MAXHEALTH; TATAMOTORS → TMPV + TMCV, LTIM → LTM — the old tickers are kept in the DB as
  `is_active = false`), crypto 25, plus XAU/XAG/WTI/NG as commodities.
- **Executives 17 → 192**, now in `server/data/executives.json` (merged into `universe.js`).
  Every stock has a current top executive. Each entry can carry `aliases` (headline surnames),
  `asOf` + `source` (last checked), `until` (former — still resolves). Migration
  `0017_executive_tenure` adds the matching columns. 100 US CEOs checked against FMP, 80 others
  against Yahoo Finance's officer list, 12 chairs/founders by web search.
- **Refresh:** `node scripts/refresh_executives.js` (dry run) / `--write`. US only — FMP's free
  tier has no NSE symbols, so India is by hand. ~100 of FMP's 250 calls/day.
- **Resolver:** longest match wins ("Tech Mahindra" no longer tags M&M, "HDFC Life" no longer
  tags HDFC Bank); executive names match whole-phrase; bare symbols T/C/F/V/PM/CAT/RTX/ACN are
  ignored; curated tickers skip the loose held-holding match ("Gold" vs "Goldman"). The seed now
  deletes executives removed from the file and deactivates dropped tickers.
- Ask's scope pre-check ignores commodities. The company card shows "checked <date>".
- Existing articles are not re-resolved — only new ones use the new matching, so stored tags from
  before 2026-10-07 can still be wrong (e.g. "HDFC Securities" tagged as HDFC Bank).

### v2 strategies + MCP round (2026-10-07, merged in pull request #1)
First real end-to-end run of v2 (engine + app, throwaway Pro user, since deleted): build → backtest
(US / NSE / crypto / gold) → save → live signal → paper → API key → `/v1` → `/mcp` all work.
- **MCP / `/v1` data tools:** Ask's 8 read tools are exposed to keys through one catalog
  (`server/services/dataTools.js`): portfolio overview, attribution, top events, ticker news,
  sentiment, smart money, market news, news search. With a ticker they accept any holding **or any
  active universe ticker**; without one they cover the user's holdings. Light limiter.
- **Benchmark:** every backtest report now carries a buy-and-hold benchmark of the same symbol
  (the engine's old Nifty default was never computed). Backtest page shows "Buy & hold" and
  "vs buy & hold" tiles and a dashed line.
- **Walk-forward:** engine `POST /api/walk-forward`; app `POST /api/strategies/walk-forward` (Plus),
  `POST /v1/walk-forward`, MCP `run_walk_forward` (heavy). Backtest page: "Robustness check".
- **Write tools:** `api_keys.can_write` (migration `0018`, default false; checkbox in Profile → API
  Access). Write keys get MCP `save_strategy`, `start_paper_deployment`, `stop_paper_deployment` and
  `POST /v1/strategies/saved`, `/v1/paper`, `/v1/paper/:id/stop`. Read-only keys are not shown the
  tools and get 403 on the routes. No delete over the API. Save/deploy/stop logic now lives in
  `server/services/strategyStore.js`, used by the web routes too.
- **`sentiment_acute` factor:** the dashboard's Acute score at daily resolution (72h window, 7-day
  half-life, source credibility × confidence). `signalHistory.js` sends per-day weight sums;
  the engine applies the decay. `sentiment_avg` is unchanged.
- **Engine edits are local-only** (`strategy-service/` is gitignored): `app.py`,
  `service/backtest_runner.py`, `service/seniq_factors.py`, `engine/strategy/schema_strategy.py`,
  tests. The Node changes above depend on them.
- **Fixed:** primary buttons on the strategy pages had lost their styling (missing `btn` class).
- **Known limits:** sentiment history is ~16 days, so SenIQ-factor backtests show very low
  coverage; one backtest is capped at 5 years of daily bars; each app boot runs the news pipeline
  and several restarts in a row hit Finnhub/CoinGecko 429s (prices come back null until it clears);
  the preview tool can't start the engine (macOS blocks the venv) — start it from a terminal.
- **Test pass (2026-10-07):** all 19 migrations + seed applied to a brand-new database; isolation,
  permission, tier, cap and rate-limit checks (39), three end-to-end scripts, v1 mode (v2 routes
  404). Two regressions from this round found and fixed: Ask's scope pre-check refused questions
  containing "F&O", "PM", "Series C" (it now shares the resolver's ambiguous lists), and
  `sentiment_acute` could report tomorrow's date.
- **Engine fix — dropped entries (local-only, `strategy-service/`):** preset strategies size an
  entry at all available cash on the signal bar's close but fill at the next open plus slippage
  and charges; when that cost more than the cash the broker rejected the order silently, so about
  half of all entries vanished at the default 100k. The broker now buys what the cash covers
  (`_affordable_long_entry`), protective stop/target legs shrink to the shares actually held, and
  the backtest response carries `orders: {reduced, unaffordable}` (shown in the results header).
  EMACrossover NVDA 2023–26 at 100k: 10 trades / −5.2% before, 17 trades / +76.8% after. **Every
  preset backtest number changes.** `broker.rejected` still holds the by-design drops (a repeat
  signal while the first order is pending) and is not reported.
- **Eval case `scope-04`** now asks about Paytm (Zomato is in the universe as ETERNAL); all 30
  cases route as expected.
- **Executives:** all 192 dated (100 FMP, 80 Yahoo, 12 web). Reed Hastings left the Netflix board in
  June 2026 (now "Co-founder"); Deepinder Goyal is Vice Chairman; **Noel Tata retires as Trent
  chairman in November 2026 — update then.**
- **Parked with the data work:** daily recording/hosting, sentiment backfill, fund factor (needs
  CUSIP → ticker: only 1.5% of 13F holdings have one), event-type factor.

### Alert quality (2026-10-07, merged in pull request #1)
History since the June budget: 477 of 513 alerts were general market/world news, 5 were about a
user's holdings, one RBI decision produced 7+ alerts, and some days reached 10 real-time alerts
against a limit of 5. Changes, all in `server/services/materiality.js` + `config.js`:
- **Holdings threshold 0.35 → 0.10** and the score is multiplied by an event-type factor
  (`TYPE_BASE` + `EVENT_TYPES.SEVERITY`). 0.35 needed a ~60% position. A holdings alert whose
  sentiment confidence is under 0.4 is recorded but never pushed.
- **Market/world news is grouped into stories** (`groupStories`: same market + 2 shared key
  words). One alert per story per user per day; later headlines on a story the user was already
  told about create no row. It pushes in real time only with ≥3 reports **and** ≥10% of the
  user's portfolio in that market (IN / US / GLOBAL, from `regionOf` + `regionExposure`).
- **Caps:** `MAX_BROAD_REALTIME_PER_DAY: 2` inside the overall 5. Smart-money alerts now share
  the 5 (`deliveryForDiscreteAlert`) — they were the reason for the 10.
- **Resolver:** a bank's short name followed by "securities / institutional / AMC…" is its
  brokerage arm, not the bank ("HDFC Securities bullish on…").
- **Replay of the last day** (`generateAlerts({dryRun: true, ignoreExisting: true})`, writes
  nothing): 25 market events → 11 stories; per user 16 market alerts → 0–1 real-time; real-time
  total avg 1.0, max 2, half of them about holdings.
- **Not done:** user sensitivity dial / mute / unsubscribe, time zones + quiet hours, price-move
  confirmation, feedback loop from opens and outcomes, emailing the daily brief. Alert emails
  still need `RESEND_API_KEY` and have never been sent for real.

### Email — status as of 2026-10-07 (superseded by the 2026-10-08 section near the top)
**Built:** one sender (`server/services/emailService.js`, Resend over HTTPS, no SDK) used by
verification, password reset and alert emails (`alertNotifier.js`: Free none, Plus standard, Pro
with a short narrative). Without a key every send returns `delivered:false` and nothing breaks.
**Never sent for real** — `RESEND_API_KEY` is not set anywhere.
**Needed from Annas to switch it on:**
1. A Resend account + API key → `RESEND_API_KEY` in `.env` (and on the host later).
2. A sending domain verified in Resend (DNS records at the registrar) → `EMAIL_FROM`, e.g.
   `SenIQ <alerts@yourdomain>`. Without it the default `onboarding@resend.dev` only delivers to the
   Resend account's own address — fine for a first test, useless for other users.
3. `APP_URL` set to the real address once hosted; locally links point at `localhost`.
**Safeguards built 2026-10-07 (merged in pull request #1; migration `0019_email_safeguards`):**
- **Verified addresses only.** `alertNotifier.recipientBlock` refuses an unverified or unsubscribed
  recipient. All 10 local users are unverified (they signed up with no provider), so
  `POST /api/auth/resend-verification` was added, with a "Send verification link" button in Profile.
- **Unsubscribe.** `users.email_alerts` (default on). Every alert email has a footer link plus
  `List-Unsubscribe` / `List-Unsubscribe-Post` headers. The link is a signed, stateless token
  (`emailService.unsubscribeToken`, HMAC over the user id with `JWT_SECRET`): GET shows a
  confirmation page and changes nothing (mail scanners prefetch links), POST switches it off, and
  there is a resubscribe. Routes in `server/routes/email.js`; toggle in Profile → Account Details.
  Changing `JWT_SECRET` invalidates links in emails already sent.
- **Send log.** `email_log` records every send and failure (with the provider's message id) for
  alert, verify and reset mail, and every alert skipped as `unverified` / `unsubscribed`. A missing
  provider is not logged.
- Tested end to end against the running app with the provider faked in-process (25 checks);
  **still never sent through real Resend.**
**Still not built:**
- The daily brief is not emailed (in-app only); no weekly summary for Free.
- No time zone per user, so quiet hours are off and "morning" has no meaning yet.
- Bounces and complaints are not read back from Resend (needs their webhook).
- Pro narrative needs `ANTHROPIC_API_KEY` + `CLAUDE_REPORTS`; otherwise it falls back to a template.

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
| `AIROUTER_API_KEY` (or `ANTHROPIC_API_KEY`) | **set** (AIRouter, with `CLAUDE_REPORTS=1`) | Claude brief + Ask + alert narrative (also needs `CLAUDE_REPORTS=1`) |
| `HF_API_TOKEN` (+ `FINBERT_CLASSIFY=1`, `NEWS_EMBEDDINGS=1`) | not set | FinBERT sentiment, RAG embeddings |
| `FEATURES_STRATEGIES` | unset = v1 | `1` = v2 |
| `CONGRESS_TRADES_URL` | not set locally | live congress data (set on the deploy host); local uses sample |
| `REDDIT_CLIENT_ID/SECRET`, `SENTRY_DSN` | not set | Reddit ingest, error monitoring |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | not set | OAuth sign-in buttons (hidden until set) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | **set** (Gmail app password) | all email while there is no domain; ~500/day, sent from that Gmail address |
| `RESEND_API_KEY` | not set | takes over from SMTP when set; needs a domain verified in Resend for `EMAIL_FROM` |
| `JWT_SECRET` | set | sessions **and** unsubscribe-link signatures — changing it breaks links in emails already sent |
| `APP_URL` | **set** (`http://localhost:3010`) | OAuth callback + email links; must be the public URL once hosted |
| `OLLAMA_URL`, `OLLAMA_MODEL` | not set | local fallback for alert narratives |

Full API inventory: price (Finnhub, FMP, CoinGecko, Upstox planned) · news (Finnhub news,
GDELT, RSS: ET/Mint/Moneycontrol/Business Standard, Reddit) · smart money (SEC EDGAR, FMP
congress) · AI (Claude Haiku 4.5, HF FinBERT + MiniLM, optional local Ollama) · infra
(Postgres/Neon, Render, Sentry, Docker) · v2 (FastAPI + yfinance strategy service, MCP, `/v1`).

## 5. Tests & evaluation
- `npm test` — offline, no DB/API calls, all passing: resolver 49 · engine/alerts logic 50 ·
  reports 23 · Ask 83 · eval 15 · strategy signals 12 · filings 10 · strategy drafts 14 · MCP/keys/data tools 19 · auth 9 · alert email 30 ·
  request safety 12 · report emails + PDF 15 · model router + answer hygiene 10 (354 checks in all).
- Engine: `cd strategy-service && ./venv/bin/python -m pytest -q` → 37 passing (local-only).
- **Clean-database check (2026-10-07):** all 19 migrations + the seed applied twice to a
  brand-new database, then dropped.
- **End-to-end (2026-10-07, throwaway users, since deleted):** build → backtest (US / NSE /
  crypto / gold) → save → signal → paper → key → `/v1` → `/mcp` (25); data tools (22); benchmark,
  walk-forward, write keys and tools (30); isolation, permissions, tiers, caps, rate limits (39);
  email safeguards with the provider faked in-process (25); v1 mode returns 404 on every v2 route.
  The scripts lived in the session scratchpad and are **not** in the repo.
- **Ask eval set** `eval/ask/cases.json`: 30 cases over a fixture portfolio (AAPL, NVDA, BTC,
  XAU, RELIANCE, TCS). All 30 route as expected through the scope pre-check (`scope-04` now asks
  about Paytm). **Run twice on 2026-10-08 with the judge — results in the section near the top.** Earlier plan was: grader + runner +
  a small paid pilot (ask before any paid run).

## 6. Open items (priority order)
The immediate queue is the "Next, in order" list at the top. Behind it:
1. **Tag after the next merge** (`v1.3` / `v2.3`); start the strategy engine and check the
   strategy pages and Ask's strategy tools against it (not exercised in the 2026-10-08 round).
   If a Render service is connected to `main`, a merge deploys there and applies migrations
   up to 0025 — check its dashboard, and note `render.yaml` sets `CLAUDE_REPORTS` and
   `FEATURES_STRATEGIES` to "0".
2. **Ask quality** (from the two eval runs): factual slips by Haiku 4.5 are the weak spot —
   ranking, trade direction, "released" vs previewed, added interpretation. Tools now state
   rankings and tallies (unmeasured). Also: the automatic grounding check should not count a
   general explanation (e.g. what a 13F is) as ungrounded; the judge's grounded line fails a
   whole answer for one loose phrase; "last month" questions only have ~7 days of events.
3. **Email at launch:** a verified domain + `RESEND_API_KEY` (HTTPS, so not blockable like
   mail ports). Read bounces/complaints from the provider's webhook.
4. **Reports, remaining:** the Pro end-of-day wrap; per-user time zone beyond the India/US
   market choice; quiet hours. Scheduled reports need the server running at send time.
5. **Alerts, remaining:** sensitivity dial (critical / balanced / everything) and per-stock mute;
   price-move confirmation before emailing; feedback loop from opens/dismissals and outcomes
   (0 of 72 tracked alerts were followed by a 3% move). Thresholds were calibrated on one day
   of data and ten test portfolios — revisit. Analyst notes are mostly typed "other", so the
   type weight doesn't demote them enough.
6. **Security, remaining from the hardening pass:** the global $/day Claude ceiling can be
   overshot by a few calls under concurrency; `safeFetch` has a DNS-rebinding gap (documented
   in the file); the CSP still allows inline scripts; 25 moderate `npm audit` advisories need
   `node-cron` 4; two migrations are numbered `0016` (harmless — do not rename).
7. **Data foundation (parked by Annas):** hosting / daily recording, sentiment backfill, CUSIP →
   ticker for 13F holdings → fund factor, event-type factor.
8. **Indian prices via Upstox:** the Analytics Token is in `.env` (`UPSTOX_ANALYTICS_TOKEN`) but
   nothing reads it yet; build the NSE ticker → instrument key lookup. TCS/RELIANCE show no
   live price until then, so weights skew to whatever is priced.
9. **RAG embeddings:** `HF_API_TOKEN` + `NEWS_EMBEDDINGS=1` + pgvector. Never run.
10. **Knowledge base upkeep:** Noel Tata retires as Trent chairman in November 2026; re-run
    `node scripts/refresh_executives.js` now and then (US only, ~100 FMP calls).
11. Smaller: dark-mode toggle; realistic demo portfolio quantities; browser check of the
    OAuth sign-in page; price service has no cache or backoff; the company card shows
    "US · US" (exchange and country); the CI workflow is still uncommitted (§8).

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
| Sign-in / email / alerts (Shreyas) | `server/routes/oauth.js`, `auth.js`, `server/services/authTokens.js`, `emailService.js`, `alertNotifier.js`, `alertNarrative.js` |
| Company knowledge base | `server/data/universe.js`, `server/data/executives.json`, `server/services/entityResolver.js`, `scripts/refresh_executives.js` |
| Alert scoring, stories, budgets | `server/services/materiality.js`, `server/config.js` (`MATERIALITY`, `ALERT_BUDGET`); smart-money alerts in `server/services/smartMoney/index.js` |
| Email: sender, log, unsubscribe | `server/services/emailService.js`, `server/routes/email.js`, `alertNotifier.js`; resend-verification in `server/routes/auth.js` |
| MCP + public API | `server/routes/mcp.js`, `v1.js`, `server/services/dataTools.js` (data tools), `strategyStore.js` (save / deploy / stop), `apiKeyGate.js`, `signalHistory.js` |
| Strategy engine (local-only) | `strategy-service/app.py`, `service/backtest_runner.py`, `service/seniq_factors.py`, `engine/brokers/simulated.py`, `tests/` |
| Request safety (2026-10-08) | `server/middleware/asyncRouter.js`, `rateLimit.js`, `server/services/safeFetch.js`; session checks in `server/routes/auth.js` |
| Report emails + PDF | `server/services/reportEmails.js`, `reportPdf.js`, `emailService.js` (Resend or SMTP, attachments), `server/routes/email.js` (preferences, unsubscribe), `config.js` (`REPORT_EMAIL`) |
| Model access (Anthropic direct or AIRouter) | `server/services/llmClient.js`, `config.js` (`LLM`); cost guards in `reports.js`, `qa.js` |
| Tests / eval | `test/*.test.js` (14 files, run by `npm test`), `eval/ask/cases.json`, `eval/ask/run.js` (`--check` free; `--run --yes-spend --max-usd N [--judge]` paid), runs in `eval/ask/runs/` (gitignored) |

## 8. Pushing to GitHub
- Repo `shreyas-sinha26/SenIQ_MajorProject` is **private**: only the `Annas-Shariff` gh account
  can fetch/push (`gh auth switch --user Annas-Shariff`, push, switch back).
- **Done 2026-09-26:** fetched Shreyas's 2 August commits, merged them (no rebase, so the
  tagged commits keep their hashes), pushed `main` + tags `v1.0`, `v1.1`, `v2.1`, `v1.2`, `v2.2`.
  Commits are authored as Annas Shariff with no AI attribution.
- **Done 2026-10-08:** pushed the branch `ask-retrieval-signals`, opened pull request #1 and merged it into `main` with a merge commit (`ac88e2a`); the branch was then deleted. No tag yet.
- **2026-10-08, later:** three commits on the local branch `hardening-email-reports`
  (`be98ba8`, `b5e47f3`, `2187d91`), **not pushed**. `git fetch` worked with the current gh
  account and showed `origin/main` one commit ahead (`ffa4fde`, README only).
- Next time: **fetch first**, merge (not rebase) if teammates pushed, run `npm test`, then
  push the branch and open a pull request, as was done for #1.
- `.github/workflows/ci.yml` still can't be pushed until the token has the `workflow` scope
  (`gh auth refresh -h github.com -s workflow`, interactive).
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
