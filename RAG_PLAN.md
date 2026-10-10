# SenIQ Ask, Retrieval and Signals Plan

Agreed 2026-10-07. Covers the Ask agent (AI Workspace), its retrieval layer ("RAG"), and how
SenIQ signals feed strategy building. Companion to `PLAN.md`, `ENGINE_PLAN.md` and
`STRATEGY_PLAN.md`; `handoff.md` stays the source of truth for current state.

## Working agreement
- Kickoff questions before each phase, then build (same rule as `PLAN.md`).
- No paid model call, embedding run, backfill or long job without an explicit yes.
- `strategy-service/` is local-only. Phases that touch it are marked **(engine)**.
- First audience is the major-project evaluators; real users come later.

## Positioning
Generic finance chatbots answer questions about any stock from a large corpus of filings and
news. SenIQ cannot win on corpus size, so it does not try. Its retrieval is the **evidence layer
for the engine's own numbers**: per-user exposure, impact scores, story clusters, typed events,
sentiment z-scores, smart money and strategy signals. Every answer should trace a number back to
the articles or disclosures that produced it.

Honest scope statement: 186 curated instruments (100 US, 57 India, 25 crypto, 4 commodities).
Tickers outside the universe can be held but get basic name/symbol matching only.

For the report: Ask is an **agent** with two kinds of lookup. **Tool calls** are exact queries
over tables (holdings, attribution, sentiment, strategies). **Retrieval (RAG)** is searching text
by meaning (`search_news`, later disclosures). Most facts come from tools; RAG is for what was
reported.

## Coverage today
| Holding | News fetched from | Matching | Result |
|---|---|---|---|
| In the universe | Finnhub per ticker (US); GDELT + RSS (India); aliases for crypto and commodities | Aliases, brands, executives, sector | Full |
| US stock outside the universe | Finnhub per-ticker feed | Symbol in capitals, or stored name (4+ chars) | Works, fewer stories |
| Indian stock outside the universe | General RSS feeds only | Same basic rule | Thin, often empty |
| Crypto or commodity outside the registry | Filed as an equity by default | Same basic rule | Effectively unsupported (not run to confirm) |

Once an article matches a holding, sentiment, clustering, impact and alerts are identical.

Uneven even inside the universe:
- Indian prices are not connected (Upstox open item), so no live price or attribution for them.
- Commodity prices need the FMP key; otherwise N/A.
- Sentiment history is about 16 days; sentiment backfill and hosting are parked by Annas.

## Decisions locked
| Topic | Decision |
|---|---|
| Scope wall | Holdings only. Watchlist is future scope. |
| Answer model | Claude Haiku 4.5 via API (est. $0.009 per question, not yet measured). About 500 questions for build, eval and demo is roughly $5; a $10 prepaid credit covers it. Chosen because Ask needs reliable multi-tool calling. |
| Local model | Ollama as offline fallback and as an eval comparison, not the main writer. The dev Mac (16 GB) fits 7–8B models at most. |
| Cloud-hosted open model | No: a rented GPU costs more than the API and answers worse. |
| Free API tiers (Gemini, Groq) | Considered, not verified; rejected because it means rewriting the agent loop to save about $5. |
| Embeddings | HF `all-MiniLM-L6-v2` (free) until the eval shows it is the bottleneck. |
| Extra corpus | Exchange disclosures, US and India, held tickers only. |
| Strategy suggestions | Templates and drafts to test. Never trades, never auto-deploy, no performance promises. Sentiment-based ones labelled experimental until history exists. |
| Build order | By what is visible in a demo; smart-money signals lead because they can be backtested today. |
| Git | New work builds on the uncommitted 2026-10-07 session; no commits without asking. |
| Historical analogues | Last; needs hosting and recorded history. |

## Out of scope
Annual-report RAG, web search, any-stock answers, graph RAG, a vector store of past chats,
running or deploying strategies from chat, buy/sell/hold advice.

## Budgets (the four constraints)
| Constraint | Today | Target |
|---|---|---|
| Guardrails | Scope pre-check; holdings allowlist in every tool; injection note | + deterministic post-check that every number and source in an answer appears in a tool result; abstain below the similarity floor; strategy drafts validated against the builder schema |
| Context window | Peak about 15% of 200k (estimate); tool results clamped to 4,000 chars | Compact story cards (about 80 tokens each) with IDs, expanded on demand |
| Memory | Last 3 Q&As from the server; 30-day purge | + rolling thread summary (about 150 tokens) past 3 turns; small user-editable profile |
| Tokens and cost | 4 tool rounds; 25k input per question; per-tier daily caps; $5/day global ceiling | Unchanged. Strategy tools load only in v2 mode |

## Phases

### R0. Switch on and measure — eval code DONE 2026-10-07 (uncommitted); paid run NOT done
Nothing else can be evaluated until this is done.
- **Built:** `eval/ask/lib.js` (case validation, free deterministic grader, judge prompt and
  schema, summary), `eval/ask/run.js` (runner), `test/eval.test.js` (15 offline checks, now in
  `npm test`). `answerQuestion` gained an opt-in `trace` so the runner records tool results,
  tokens, cost, served model and errors.
- **Free check:** `node eval/ask/run.js --check` validates the 30 cases, replays the scope
  pre-check (30/30 route as expected) and self-tests the grader on known-good and known-bad
  answers. No database, network or model.
- **Paid run (not run):** `node eval/ask/run.js --run --yes-spend --max-usd 2 [--judge]`.
  Refuses without `--yes-spend`; stops at the ceiling; creates the fixture user if missing;
  writes `eval/ask/runs/<time>/` (gitignored). Infra failures (API error, quota, kill-switch,
  wrong served model) go to `errors.jsonl` and are never scored as wrong answers.
- **Judge (not run):** `claude-sonnet-5-5`, a different model from the Haiku writer, one call
  per case returning a verdict per rubric line as structured output. `--judge-selftest` feeds it
  three answers that must fail. Estimated cost for a full 30-case run with judge: about $1–2
  (estimate from token sizes, not measured).
- **Plumbing checked** on a scratch DB with an invalid key: fixture created, the 401 was
  recorded as an infra error, the run stopped early, nothing spent.
- **Still open:** sign-off on the 30 cases (the fixture note still mentions Zomato; `scope-04`
  now asks about Paytm); the judge has not been calibrated against human labels; one rep of
  30 cases has a noise floor of about ±18 points, so small differences between runs mean nothing.

Original scope:
- Annas adds `ANTHROPIC_API_KEY`; flip `CLAUDE_REPORTS` (hard-coded `false` in `server/config.js`).
- `HF_API_TOKEN`, `NEWS_EMBEDDINGS=1`, pgvector; first embedding run.
- Sign off the 30 eval cases; build grader and runner; small paid pilot.
- **Kickoff Qs:** pilot budget; which cases to change before sign-off.
- **Done when:** a baseline score exists for the current Ask.

### R1. Explain the number (provenance) — backend DONE 2026-10-07 (uncommitted)
"Why did NVDA's z-score jump?" returns the exact articles that moved it.
- **Built:** `explainSentiment()` in `sentimentScoring.js` (shares its row cleaning and weights
  with `computeWindowedSentiment`); Ask tool `explain_sentiment`; same tool on MCP and
  `GET /v1/tickers/:ticker/sentiment/drivers`; 7 new offline checks in `test/qa.test.js`.
- **Checked on the local DB (read-only):** WTI contributions sum to −0.165 vs reported z −0.16;
  a 4-story result is about 2,000 chars, inside the 4,000-char tool clamp.
- **Seen in that check:** an RBI rate story was counted under WTI with score 0. Provenance makes
  upstream mis-tagging visible; worth a pass on commodity alias matching.
- **Not built:** the UI click-through; an eval case for this question type.

Original scope:
- Pure function that decomposes the Acute score and z-score into per-article contributions.
  The decomposition is exact: `z = Σ wᵢ(sᵢ − μ) / (W·σ)`, so contributions add up to z.
- Ask tool `explain_sentiment(ticker)`: top contributors with weight, direction, source, date.
- Optional UI: click a sentiment score to see its drivers.
- No embeddings, no model call. Offline unit tests.
- **Done when:** contributions sum to the reported z within rounding, on fixtures.

### R2. Story-level retrieval — full-text and ranking half DONE 2026-10-07 (uncommitted)
- **Built:** migration `0020_article_search` (generated `search_tsv` column + GIN index);
  `searchNews` now fuses full-text and vector rankings per story (reciprocal rank fusion) and
  re-ranks per user; story cards; new tool `get_story_detail` (Ask, MCP,
  `GET /v1/news/stories/:id`); 8 new offline checks.
- **Ranking:** `score = match × strength × (1 + 0.6·impact + 0.3·importance) × recency`.
  Strength = share of query terms hit (or cosine). Weights are defaults in
  `config.NEWS_SEARCH.RANK`, not tuned against the eval.
- **Fallbacks:** no embeddings → full-text only; migration not applied → old ILIKE search.
- **Checked on a scratch copy of the local DB (since dropped):** migration applies twice
  cleanly; "tech stocks rally" ranks differently for three portfolios; out-of-scope and
  malformed story ids are refused; largest 6-card result 2,935 chars (clamp is 4,000).
- **Not done:** the vector half has never run (needs `HF_API_TOKEN`, pgvector, an embedding
  run), so `hybrid` mode and the cosine side of `strength` are untested on real data. The
  "eval score does not drop" check waits on R0. Migration 0020 is NOT applied to the dev
  database; it applies on the next app start.
- **Limits seen:** 769 of 874 relevant articles have no durable event and most events have one
  source, so many "stories" are single articles; this is upstream clustering, not retrieval.
  Impact scores top out near 0.35, so the impact boost is at most about +21%. A two-word query
  needs both words to match.

Original scope:
- Retrieval unit becomes the event cluster, not the article.
- True hybrid: Postgres full-text (`tsvector`) fused with vector rank by reciprocal rank fusion.
- Portfolio-aware rerank: similarity × exposure × materiality × recency.
- Story cards plus `get_story_detail(id)`.
- **Kickoff Qs:** rerank weights; whether full-text ships as a migration or in code like pgvector.
- **Done when:** two demo portfolios get different rankings for the same question, and the eval
  score does not drop.

### R3. Grounding post-check and memory — DONE 2026-10-07 except the profile (uncommitted)
Kickoff answers: measure and flag (never block); digest built in code; profile deferred;
Ollama as a single prompt, no tool loop.
- **Grounding check** (`server/services/answerCheck.js`): after a model writes, every figure,
  date, URL and company name in the answer is looked up in what the model was shown (tool
  results, question, holdings line, earlier turns). Result is returned as `grounding` on
  `POST /api/reports/ask` and stored on the turn (migration `0021_ask_grounding`).
  `GET /api/admin/ask-grounding` gives the grounded answer rate per writer; answers with
  nothing checkable are excluded from the rate.
- **Known false positives:** figures the model derived (a sum of two tool values) and numbers
  in general finance explanations. Not checked: integers up to 10, spelled-out numbers, source
  names. This is why it flags instead of blocking.
- **Thread digest** (`askThreads.threadDigest`): turns older than the last 3 reach the model as
  one line of earlier questions (max 6, clipped) plus held tickers discussed, capped at 700
  chars. Answers are not replayed. No model call.
- **Local-model tier** (`ASK_OLLAMA=1`, default off): Claude → Ollama → data summary. One
  prompt with the user's data packet (clamped to 6,000 chars), 25 s timeout. No quota spent.
- **Checked on a scratch DB copy with a scripted fake model (no paid call, no local model
  loaded):** grounded answer → 6 of 6 claims supported; invented figure, date and an unheld
  company → all flagged; digest appears in the question turn; Claude failure → Ollama tier →
  data summary; results stored and the rate query works. 16 new offline checks.
- **Not done:** user profile (deferred); no UI badge for the check (API and admin route only);
  the local-model tier has never run against a real Ollama model; the Haiku vs local eval
  comparison needs R0 and your go-ahead; false-positive rate on real answers is unmeasured.
  Migrations 0020 and 0021 are NOT applied to the dev database; they apply on the next app start.

Original scope:
- Post-check on numbers and sources; measurable "grounded answer rate".
- Rolling thread summary; user profile.
- Ollama fallback for Ask; run the eval on Haiku and a local model for the report.

### R4. Strategies in Ask (v2 mode only) — DONE 2026-10-07 against a stand-in engine (uncommitted)
Kickoff answers: returns from paper deployments only; suggestions describe and point (no engine
run from chat); signal provenance by composition; verify with a fake engine.
- **Built** (`server/services/strategyTools.js`, loaded only when `FEATURES.STRATEGIES` is on):
  - `list_my_strategies`: saved strategies with rules in plain words, watchlists, SenIQ signals
    used, and paper deployments. "Running" = an active paper deployment.
  - `get_paper_performance`: each deployment's paper return since deploy, best first, with
    buy-and-hold, drawdown, trades and its dates. Max 10 replays, 3 at a time, 20 s each,
    cached 5 minutes.
  - `explain_strategy_signal`: rules, current state and last signal per symbol, and for SenIQ
    factors on held symbols the current sentiment drivers or congress disclosures.
  - `list_strategy_presets`: the engine's template catalog, for "describe and point".
- **Guardrails:** no tool writes, backtests or deploys; tier checks match the web routes (saved
  strategies Plus, paper Pro); every query scoped by user; prompt addendum requires "paper
  result" plus dates on any return, forbids profit claims and deploy advice, and ends
  suggestions with "Educational only, not investment advice."
- **Checked on a scratch DB copy with seeded strategies and a stand-in engine:** all four tools,
  another user's strategy refused, symbol outside watchlist and holdings refused, engine offline
  reported plainly, second performance call served from cache, largest result 1,783 chars.
  12 new offline checks.
- **Not done / limits:** never run against the real strategy engine (it was not running), so
  the engine's actual response fields are read from its source, not observed. Saved strategies
  that were never deployed have no return. Deployments cover different periods, so "best" is
  not like-for-like (the tool and prompt say so). Signal evidence is the current picture, not
  the factor values on a past signal date. The dev database has no saved strategies or
  deployments, so a demo needs some created first.

Original scope:
Example questions: "how many of my strategies are running?", "which gave the best return?",
"what does walk-forward mean?" (the last is general education, which Ask already allows).
- Read-only tools: my strategies, which are running, best by return (always stating period and
  whether backtest or paper), recent signals, paper positions. Reuse the MCP catalog.
- Signal provenance: a signal traced to its rule, factor value and the articles or disclosure
  behind it (builds on R1).
- Suggestions level 1: recommend from existing presets, each with its backtest vs buy-and-hold.
- System prompt carve-out for templates; fixed "educational, not advice" line.
- Caution: tools go from 9 to about 13, which makes tool choice harder and adds tokens per
  question, so the strategy tools load only when the v2 switch is on.
- Demo on a strategy known to have fired; SenIQ-factor signals are sparse on 16 days of history.

### R5. Smart-money factors **(engine)** — DONE 2026-10-07 except stock selection (uncommitted)
**Correction to the line below:** the loaded data does NOT hold years of history. Congress is
237 trades, all disclosed in 2026 (at most 7 per ticker). 13F is 10 funds with about 5 filings
each (Aug 2025 to Aug 2026). Fund factors have about a year to backtest on; congress factors
have months.
- **CUSIP map:** all 100 US universe names now have one common-stock CUSIP in
  `smartMoney/cusipMap.js`. 99 were confirmed by OpenFIGI (CUSIP → ticker, common stock); Exxon
  matched on issuer name only. Name matching alone was rejected: it would have filed 51 iShares
  ETFs under BLK and Strategy ETFs and notes under MSTR.
- **Backfill:** `backfillHoldingTickers()` runs at the start of the smart-money job and fills
  the ticker on stored rows whose CUSIP is mapped. On a scratch copy: 950 rows filled, tickers
  with 13F data 54 → 108, second run 0. NOT yet applied to the dev database (next app start).
- **Engine factors** (`strategy-service`, local-only; 37 → 48 tests): `congress_buys`,
  `congress_sells`, `congress_buyers` (distinct members), a `politician` parameter on every
  congress factor, and `funds_holding`, `funds_net_adds`, `funds_new_positions`. Fund factors
  move only on a filing's FILED date; a fund with no filing for 140 days counts as unknown.
- **Date bug fixed:** dates sent to the engine were one day EARLY east of GMT (a pg DATE read
  as local midnight, then printed in UTC), which gave every backtest one day of lookahead on
  congress and sentiment rows. They are now formatted in SQL. Earlier SenIQ-factor backtest
  numbers from this machine were affected.
- **Presets** (`server/data/seniqPresets.json`): trend with positive sentiment, congress cluster
  buying, follow a politician, fund accumulation trend. Each validated by the engine and carries
  a `data_depth` note.
- **With/without comparison** (`strategySignals.compareWithoutSeniq`): the same spec backtested
  as written and with every SenIQ condition removed; returns both, the difference, buy-and-hold,
  coverage and plain caveats. Refuses when no price-only version is left.
- **Surfaces:** `/api/strategies/seniq-presets`, `/api/strategies/compare`, the same under
  `/v1`, MCP `list_seniq_presets`, `get_seniq_preset`, `compare_without_seniq`; Ask's preset
  tool lists the SenIQ presets with their data depth. 12 new offline checks.
- **Checked on real data** (scratch copy, engine maths run directly in Python): fund series for
  NVDA, AAPL, XOM and GOOGL step on filing dates as expected.
- **Not done:** signal-driven stock selection (the engine still takes a fixed symbol); the
  followed-politicians filter (the `politician` parameter covers one named member; wiring it to
  a user's follow list is UI work); the Builder page does not list the new factors or presets
  (its factor list is hardcoded in `app.js`); nothing was run through the live engine service
  or a real backtest; congress history backfill.

Original scope:
Backtestable today, unlike sentiment, because the sources hold years of history.
- Congress: distinct politicians buying, followed-politicians filter, buy/sell split.
- Follow-a-person preset ("buy what politician X disclosed, N days after disclosure").
- SenIQ presets: 3–4 ready strategies combining price with SenIQ signals.
- Factors usable as a gate (filter) as well as a trigger; slow data like 13F is a gate.
- With/without comparison: same strategy with and without the SenIQ gate, side by side, plus
  the existing walk-forward check.
- Signal-driven stock selection ("run this on whatever congress bought in the last 30 days").
  Largest item: the engine takes a fixed symbol today. Do last within R5.
- CUSIP to ticker for the 100 US universe names, then 13F factors as gates (funds holding, net
  adds, new positions), dated by filing date. Call them "tracked funds" (there are 10), not
  institutions in general.
- **Kickoff Qs:** CUSIP route (issuer-name match vs lookup service); how far back congress data goes.

### R6. Disclosures corpus — SEC 8-K DONE 2026-10-07 (uncommitted); India spiked, not built
Kickoff answers: filing facts plus a text excerpt; own table and own Ask tool; small live
check allowed; India as a feasibility spike only.
- **Built:** migration `0022_disclosures` (`disclosures`, `disclosure_sync`);
  `server/services/disclosures.js`; Ask tool `get_disclosures` (also MCP and
  `GET /v1/disclosures`); a sync step after the smart-money poll. 10 new offline checks.
- **What is stored per 8-K:** form, filed date, event date, item codes turned into plain words
  ("Results of operations (earnings)", "Director or officer change…"), a link, and a cleaned
  excerpt (main document from the first Item up to the boilerplate, plus the EX-99 press
  release when there is one). Full-text searchable; no embeddings.
- **Kept apart from news:** filings do not feed sentiment, story clustering or alerts.
- **Lazy and bounded:** only held US-listed equities; 4 tickers per poll, 5 new filings per
  ticker, 180-day lookback, re-checked every 12 hours, requests spaced with the SEC
  User-Agent. `DISCLOSURES=0` turns fetching off.
- **Live check (scratch DB, 13 requests to EDGAR):** real 8-Ks for AAPL and NVDA were fetched,
  parsed and returned by the tool; a second sync fetched nothing; a ticker not held and a bad id
  were refused. Listing of two filings was 1,427 chars; one opened filing 2,817.
- **Not exercised live:** the press-release (EX-99) path, since neither fetched filing had one;
  it is covered by fixture tests only. No real Ask answer has used the tool.
- **Limits:** US-listed stocks only. A newly added US holding has no filings until the next
  poll. Only 8-K and 8-K/A (no 10-K/10-Q, no 6-K for foreign issuers such as Infosys' ADR).
  The universe treats INFY as Indian, so it gets no SEC filings. Migration 0022 is not applied
  to the dev database (next app start).

**India spike (2026-10-07, five test requests, nothing built):** all four routes answered from
this machine.
| Route | Result | Notes |
|---|---|---|
| NSE per-symbol JSON (`/api/corporate-announcements?symbol=`) | 200, 3,363 rows for RELIANCE | Keyed by NSE symbol, which is our ticker. Fields: date, category, short text, PDF link. Unofficial; answered without cookies today but is known to block scripted clients. |
| NSE archives RSS (`Online_announcements.xml`) | 200, 1,782 items | Whole-market feed: company name, subject, description. Fits the existing RSS ingester; needs name matching. |
| BSE JSON (`AnnSubCategoryGetData`) | 200 with browser-like headers; an HTML page with a plain script User-Agent | Needs a BSE scrip code per ticker (e.g. 500325), which the universe does not hold. |
| BSE RSS | 200, 15,258 items | Very large whole-market feed. |
Recommendation if India is built: NSE per-symbol JSON as the source with the NSE RSS as
fallback, storing category + short text + link (the detail is in PDFs, which would need a PDF
parser). Open before building: both NSE routes are unofficial, may behave differently from a
cloud host, and NSE's terms on automated access have not been checked.

Original scope:
- SEC 8-K first (EDGAR). Then a spike on NSE/BSE announcements before committing to India.
- Held tickers only, indexed lazily, same hybrid retrieval as R2.

### R7. Plain English to strategy draft — DONE 2026-10-07 with a scripted model (uncommitted)
Kickoff answers: a tool inside Ask; app validator plus the engine when it is up; SenIQ signals
allowed with an automatic data-depth note; draft delivered in the Ask response and thread.
- **Built:** Ask tool `draft_strategy` (v2 only, Plus and above) in `strategyTools.js`;
  `server/services/strategySpec.js` (app-side validator + fixed data-depth notes); migration
  `0023_ask_drafts` (a `draft` column on the assistant turn); `draft` on the
  `POST /api/reports/ask` response and in thread history. 14 new offline checks.
- **How it works:** the agent writes a Builder spec from the user's words and submits it. An
  invalid spec comes back as named errors and the agent fixes and resubmits, inside the usual
  4-round budget. An accepted draft returns its rules in plain words; the full spec travels to
  the client as data, not as text in the answer.
- **Guardrails:** nothing is saved, backtested or deployed (the only engine call is
  `/api/strategies/validate`); vocabulary is whitelisted; limits of 12 factors and 20
  conditions; the data-depth note for each SenIQ signal family is written in code so the model
  cannot drop or soften it; the prompt tells the model to ask for rules instead of inventing a
  strategy from a goal, to list its assumptions, never to promise profit, and to end with
  "Educational only, not investment advice." If the model path fails after drafting, the draft
  is dropped rather than shown under an answer that never mentions it.
- **Validator parity:** the app validator and the engine agreed on 24 of 24 valid and invalid
  specs (checked by running both). The app is slightly stricter on purpose (parameter names,
  MACD fast < slow, unused factors).
- **Checked on a scratch DB with a scripted fake model and the engine offline:** draft accepted
  on the app check alone (`validated_by: "app"`), answer passed the grounding audit, draft
  stored and read back intact, no draft on a normal answer or for a Free user.
- **Not done / limits:** no real model has written a draft, so how well Haiku follows the
  grammar is unmeasured; no "Open in Builder" button (the draft is in the API response only);
  the tool description adds about 1,700 characters to every v2 question (16 tools in v2); two
  validators can drift if the engine's vocabulary changes; no eval cases for drafting.

Original scope:
Suggestions level 2. Draft lands in the Strategy Builder, validated against allowed factors and
operators. The user runs the backtest and deploys.

### R8. Needs history (after hosting)
- Sentiment momentum and attention-spike factors, labelled experimental until then.
- Event-type factor.
- Historical analogues: similar past events joined to `outcomes`.

### R9. IPO Watch in Ask — DONE 2026-10-10 against a scripted model (uncommitted, branch `ipo-ask`)
Kickoff answers: compare, do not pick; Ask only (not MCP or `/v1`); India and the US together
when the question names no market.
- **Built** (`server/services/ipoTools.js`, loaded only when `FEATURES.IPO_WATCH` is on):
  - `get_ipo_calendar`: issue cards by stage with dates, price, size, subscription, premium
    and news tone; counts by stage; orderings by one figure each; whole issues dropped to fit
    the tool-result allowance, with the number left out.
  - `get_ipo_detail`: one issue by id or by the name the user wrote, with its news.
  - The first tools that read about companies the user does not hold. Neither takes a
    ticker, so the holdings check in `qaTools.js` is unchanged; a question with an IPO word
    in it skips the holdings pre-check and nothing else.
  - With no model, an IPO question gets a digest of the calendar.
- **Details and limits:** `IPO_PLAN.md`, Change 3 build status.
- **Open:** a paid run of the four `ipo-` eval cases.

## UI pass — DONE 2026-10-08 (uncommitted)
Six items, all seen working in a browser against a scratch database copy in v2 mode.
| Item | Where | Checked how |
|---|---|---|
| "Basic coverage" label on holdings outside the universe | Portfolio table (`GET /api/portfolio` now returns `coverage`) | Live: shown on SHOP only |
| Explain the number: click a score to see the stories behind it | Portfolio table (`GET /api/news/sentiment/:ticker/drivers`, Plus) | Live data: NVDA, 14 articles, parts sum to +0.15σ; second click closes |
| Grounding badge on AI answers | AI Workspace | Sample data through the app's own render function (Claude answers are off) |
| Strategy draft card + "Open in Strategy Builder" | AI Workspace | Sample draft; the button loaded it into the Builder and the Builder re-emitted an equivalent spec |
| New congress and fund factors, a text field for `politician`, SenIQ templates | Strategy Builder | Loaded two templates; required-input error shown; **engine was a stand-in** |
| "Compare without SenIQ signals" | Backtest results | Ran through the app to a **stand-in engine** with canned results; refusal shown for a SenIQ-only strategy; hidden for price-only strategies |
- The same run exercised the real boot path on the scratch copy: migrations 0020–0023 applied
  by the app's own runner, the 13F backfill filled 950 rows, and the filings sync fetched 14
  8-Ks for AAPL, NVDA and SHOP, two with a press-release excerpt (so that path is now seen live).
- **Bug found and fixed here:** the engine reports returns as fractions (`total_return_pct`
  0.0425 = 4.25%). The R4 paper-performance tool and the R5 comparison had passed them through
  as percentages; both now convert, and their tests feed fractions.
- **Limits:** the Builder shows one flat list of entry rules (all) and one of exit rules (any),
  so a draft or template with nested groups cannot be opened there (the user gets a message
  saying why). Nothing on the two strategy pages has run against the real engine. The Ask
  pieces have not been seen with a real model answer. No mobile-width pass.

## Fixes found during scoping
| Issue | Where | Fix |
|---|---|---|
| GDELT queries only 11 hardcoded Indian tickers, not the 57 in the universe | `server/services/ingest/gdelt.js` | **FIXED 2026-10-07:** list derived from the universe; at most 12 held names per run, rotating. Query terms not verified live (two test calls to GDELT timed out). |
| Non-universe holdings look empty with no explanation | UI | **DONE 2026-10-08:** "Basic coverage" label on the Portfolio table |
| Asset registry lists CoinGecko IDs for 10 coins; universe has 25 | `server/services/assetRegistry.js`, `server/data/universe.js` | **FIXED 2026-10-07:** the other 15 had no price and were filed as equities when added. All 25 now carry a CoinGecko ID (each confirmed by one live price request) and resolve as crypto. |
| `ollama list` returned nothing on the dev machine | local | Pull a model before relying on the fallback |
| An RBI rate story was tagged to WTI crude (seen in the R1 check) | `server/services/entityResolver.js` | **FIXED 2026-10-07 for new articles:** commodities match on the headline only. Replayed over stored articles: WTI 41 → 18 tags, gold 51 → 37, silver 8 → 8. Rows already stored keep their old tags until re-resolved (a DB write, not done). |

## Demo notes
- Build demo portfolios from universe names; a small-cap outside the list makes retrieval look empty.
- Use Indian names from the 11 GDELT-covered tickers until the GDELT fix lands.
- Lead with smart-money factors and "explain the number"; label sentiment backtests experimental.
- Keep the Ollama fallback ready in case the room's network fails.

## Future scope
- Watchlist: followed-but-not-held tickers in scope for news and sentiment, capped per tier,
  universe only.
- Before real users in India: check whether strategy suggestions fall under SEBI
  investment-adviser rules.
