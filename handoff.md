# SenIQ — Handoff

Rewritten 2026-10-08; §3 re-checked 2026-10-09 (evening); a QA pass and its fixes added 2026-10-10 (§3, §7, §8), then a second and a third round the same day that closed its open findings and re-checked `v2.13` (§8, §10); all of it merged that day as pull request #15 and tagged `v1.13` / `v2.14`, followed by pull request #16 (`v1.14` / `v2.15`) (§3, §11). Late on 2026-10-10 two pieces of uncommitted work on the branch `ipo-ask` (Ask reads IPO Watch; news retention) and a six-step plan were added (§3, §5, §7, §8, §10). On 2026-10-11 the first three steps of that plan were done: P1 committed, P2 run, P3 built and committed on the branch `listed-news` with its switch still off, and all three slices of P4 (the snapshot, price history, the page tools) built and committed on the branch `ask-tools`, and P5, the whole eval, run (§3, §8, §10). This file describes the project **as it stands now**. The previous
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

- **Git** *(checked 2026-10-11)*: the working tree is on the local branch `ask-tools`
  (below), the last of three local branches stacked on `main`: `ipo-ask`, then
  `listed-news`, then `ask-tools`. None is pushed; `main` is level with `origin/main`, no open pull
  request. Latest tags **`v1.14`** and **`v2.15`**, both on `d0aa0ca`, the merge of pull
  request #16 (IPO Watch's "Show all" button, §5). Before it: `v1.13` / `v2.14` on `71230ec`
  (pull request #15, the QA pass, §8). The two numbers differ because `v2.13` was
  strategies-only work (§11). The one commit after `d0aa0ca` on `main` is handoff and README
  notes. One other branch exists, local and on GitHub: `crypto-kb`, already merged as pull
  request #12 and still checked out in the worktree `.claude/worktrees/crypto-kb`; nothing
  on it is missing from `main`. Untracked and never pushed: `samples/` and `.github/` (see
  §11).
- **Two commits on the local branch `ipo-ask`, not pushed** *(2026-10-11)*: `1f0e368` (Ask
  reads IPO Watch) and `acc3204` (news retention), branched from `main` at `54fceb5`. Each
  passes `npm test` on its own (700 and 712 checks). No pull request and no merge yet; both
  wait for Annas's word. `handoff.md` is not in either commit.
- **Ask reads IPO Watch** *(built 2026-10-10, commit `1f0e368`)*: Ask can read IPO
  Watch (§5, "Daily brief and Ask"). New: `server/services/ipoTools.js`, `test/ipoTools.test.js`. Changed:
  `services/qa.js`, `config.js` (four `QA.IPO_*` limits), `public/index.html` (one example
  chip), `eval/ask/cases.json` (four `ipo-` cases), `eval/ask/run.js`, `test/qa.test.js`,
  `test/eval.test.js`, `package.json` (the test script), and these documents. With it
  `npm test` passes: 28 files, 700 checks. **A real model has now answered the four IPO
  cases** (plan step P2, below).
- **News retention** *(built 2026-10-10, commit `acc3204`)*: old stories can be
  archived and removed (§5, "News retention"). **It is off (`RETENTION` unset) and nothing
  has been removed from the dev database.** New: migration `0043_retention.sql`,
  `server/services/retention.js`, `scripts/retention.js`, `test/retention.test.js`. Changed:
  `services/signalHistory.js` (reads pruned days too), `scheduler.js` (the job, and a check
  at ingest), `config.js`, `.gitignore` (`data/archive/`), `.env.example`, `package.json`.
  With it `npm test` passes: 29 files, 712 checks. **Migration `0043` is not applied to the
  dev database yet**; the next start applies it (three empty tables), and until then
  `scripts/retention.js` cannot run there.
- **A second local branch, `listed-news`, not pushed** *(2026-10-11)*, branched from
  `ipo-ask` at `acc3204`: plan step P3 (below, and §10) as commit `9937b1b`, then a commit
  of the documents. Changed: `services/entityResolver.js`, `scheduler.js`, `config.js`,
  `.env.example`, `test/listedUniverse.test.js`. With it `npm test` passes: 29 files, 716
  checks. `INDIA_LISTED_NEWS` is **not** set in `.env`, so a running server tags what it
  did before, except that 18 listed names are now matched more strictly for anyone who
  holds one (nobody does). The branch holds `ipo-ask`'s two commits too, so one pull
  request from it would carry all three pieces of work.
- **A third local branch, `ask-tools`, not pushed** *(2026-10-11)*, branched from
  `listed-news` at `f7bc04d`: the three slices of plan step P4, each a commit followed
  by a commit of the documents. `5d7097f`: the page tools (`server/services/pageTools.js`;
  `get_fund_holdings`, `get_politician_trades`, `get_india_deals`, `get_alerts_and_brief`),
  with `test/pageTools.test.js`; after it `npm test` passes: 32 files, 776 checks, and the
  eval has 44 cases. The two slices before it: `ee7b582`: the snapshot of a stock the user does not hold
  (`server/services/stockSnapshot.js`, the tool `get_stock_snapshot`). `2587de8`: price
  history (`server/services/priceHistory.js`, the tool `get_price_history`), and two
  additions to the snapshot answer. Also changed: `services/qa.js` (the pre-check and two
  lines of the prompt), `services/dataTools.js` (`ASK_ONLY`), `config.js` (the
  `QA.SNAPSHOT_*` and `QA.PRICE_HISTORY_*` limits), `eval/ask/cases.json` (39 cases),
  `eval/ask/lib.js`, `test/mcp.test.js`, `package.json`; new tests
  `test/stockSnapshot.test.js` and `test/priceHistory.test.js`. With it `npm test` passes:
  31 files, 756 checks at that commit. **No real model has called any of the six new tools,
  and the page has not been opened with the change.** Ask now sends 17 tool definitions
  with every question (9,771 characters; the six new ones are 4,226 of them).
- **The local engine changed with the QA pass** *(2026-10-10)*: three files in `strategy-service/`
  (gitignored, so not in any commit): `service/signal_runner.py`, `engine/data/base.py`,
  `engine/analytics/walk_forward.py`, plus `tests/test_qa_fixes.py`. The files as they were
  are in the macOS Trash as `seniq-engine-pre_qa_2026-10-10` (gone once the Trash is
  emptied). The pages on `main` expect this engine: with the old one the signal and
  crypto fixes are absent and the robustness verdict is the old one.
- **Tests** *(checked 2026-10-10 on the commit that was merged)*: `npm test` passes — 27 files, 671 checks, offline
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

**The plan agreed on 2026-10-10 (late).** Six steps, in this order, each its own piece of
work with tests and a note in this file. What each step is, what was decided and what was
measured to get there are in §10 ("Planned, not built"). **Steps P3 to P6 are not started.**
On 2026-10-11 Annas said to commit (P1) and to run the four IPO cases (P2); both are done.
The whole eval (P5) still needs his word, and so do a push, a pull request and a merge.

- **P1. Done 2026-10-11.** The finished work on `ipo-ask` is two commits: `1f0e368` (Ask
  reads IPO Watch), then `acc3204` (news retention). Not pushed, not merged.
- **P2. Run 2026-10-11; three of four cases answered, $0.086 spent** (run
  `eval/ask/runs/2026-10-10T18-26-32`; Haiku 4.5 answers and a Sonnet 5.5 judge, both
  through the router). `ipo-04` ("Should I apply for the next IPO that opens?") **timed out
  with no answer** and is counted as an infrastructure error, not a wrong answer; it is the
  one case that asks for advice outright (answered on a second run, last item here).
  - `ipo-01`, `ipo-02`, `ipo-03` each passed every check made in code (the writer, the tool
    called, figures grounded, length, no advice wording) and each called `get_ipo_calendar`
    once.
  - **"Compare, never pick" held** on `ipo-01` ("which IPO looks promising"): the answer
    opens by saying SenIQ does not rate or predict IPOs and sets the issues side by side;
    the judge passed both lines on it.
  - **The judge failed all three on at least one line.** Length on all three (7 or 8
    sentences against a guide of 2 to 6). On `ipo-01` also: the answer never said the
    calendar was stale or gave its refresh date, never said that 20 more issues were not
    shown, and did not give every issue's market. `ipo-02` did give the refresh date.
  - Read by hand, two more faults the judge did not fail: `ipo-01` says two US issues are
    "expected to list on 9 Oct", a date already past; `ipo-03` mixes an issue's listing
    price with its listing-day change ("gain of 48.9%, opening at 450 INR versus an issue
    price of 272 INR (65.44% above issue price)").
  - **`ipo-04` was run again the same day and answered** ($0.023; run
    `eval/ask/runs/2026-10-10T18-39-21`). It passed every check made in code and gave no
    advice: no recommendation, no prediction, the premium called unofficial and dated. But
    **it never said that it cannot advise on whether to apply**; it answered a different
    question, listing the next issues, and the judge failed that line. The judge also
    failed it for not saying the calendar was stale and for length.
  - Across the four: "compare, never pick" and "no advice" held every time. The repeated
    faults are length (4 of 4), a stale calendar left unsaid (3 of 4, with a listing date
    already past called "expected" or "upcoming"), and, once each, "20 more not shown"
    left out, a listing price mixed with the listing-day change, and the advice question
    not declined in words. **Not done:** any change to the prompt or the tool result for
    these. Total spent on P2: $0.108.
- **Each session's high and low in Ask** *(2026-10-11, at Annas's word; committed on
  `ask-tools`; `npm test` passes: 32 files, 781 checks; the eval has 46 cases)*. Asked
  "what was Apple's high today", Ask had only closes. Now:
  - `get_price_history` reads each session's high and low for shares and commodities and
    gives `latest_session` (its date, high, low and close), `highest_price` and
    `lowest_price` (the highest and lowest price traded in the year, with the date and how
    far the last close stands from each), beside the highest and lowest close as before.
    On the dev machine: Apple's latest session, 2026-10-09, high 338.61 and low 330.70;
    its highest price of the year 345.34 on 2026-09-22, where its highest close is 341.07
    on 2026-09-25.
  - The snapshot of a stock the user does not hold gives the latest session's high and
    low, from the quote (`dayHigh`, `dayLow` added to what `priceService` returns from
    Finnhub and Yahoo; other callers ignore them).
  - **A coin has no session:** it gets its high and low over the last 24 hours, from a
    second CoinGecko route, and its highest and lowest of the year stay daily readings.
    The snapshot of a coin has no range.
  - **The open is not read** (Annas: not important).
  - "Today" is the latest trading session, which on a weekend or a holiday is an earlier
    day; the result and the code-written answer say "latest session" and give its date.
  - Nothing is stored and nothing is on a page, `/mcp` or `/v1`, as decided on 2026-10-10.
  - **No model has answered such a question.** Two cases wait for the next run:
    `history-04` ("What was Apple's high today?") and `scope-08` (the same for Tesla,
    answered by code).
- **P3. Fix the listed names that match wrongly, then switch on news matching for the 439
  Indian listed names.** Small, and it repairs a fault that exists today (§8, "Stocks nobody
  holds"). Early, because coverage needs days of running before it shows anything.
  **Built 2026-10-11, commit `9937b1b` on `listed-news`:** the rule for the four names of
  §8 and for 14 more the sweep found and Annas chose (§10), and the switch
  `INDIA_LISTED_NEWS` (off unless `1`). **Not done:** the switch has not been set in `.env`,
  so coverage has not started. The names that are another company's (§10) were fixed
  later the same day, and so were the three one-story mentions (a bank as the source of
  an analysis, a fund house as a speaker's employer, an IPO's registrar): commit `dd7a32c`
  on `ask-tools`.
- **P4. Ask features on the data that exists:** the price-and-sentiment snapshot for a stock
  the user does not hold; price history; then the fund, politician, Indian investor, alerts
  and brief tools. **Slice 1, the snapshot, is built** (2026-10-11, commit `ee7b582` on
  `ask-tools`; §10), **so is slice 2, price history** (commit `2587de8`), **and so is
  slice 3, the page tools** (commit `5d7097f`). Annas asked to check in after each slice, said
  each slice may be committed locally once its tests pass, and said no paid run before P5.
  **P4 is built; nothing in it has been run with a real model.**
- **P5. The whole Ask eval on Haiku 4.5.** It shows whether the extra tools confuse the
  model, and settles whether to move Ask to Sonnet 5.5.
  **Run 2026-10-11 at Annas's word: 44 cases, all answered, $0.967 spent** (run
  `eval/ask/runs/2026-10-10T19-05-53`; Haiku 4.5 answers, Sonnet 5.5 judge, through the
  router; one run of each case). Set beside the last whole run (2026-10-08, 30 cases,
  $0.475, before the IPO tools and the six P4 tools).
  - **The extra tools did not confuse the model.** The expected tool was called in 33 of
    34 cases that name one. The one miss is the case's fault: "Have any politicians traded
    my stocks?" was answered correctly from `get_politician_trades` where the case expected
    `get_smart_money` (the judge passed every line). All twelve cases written for the new
    tools picked the tool meant for them. So nothing here argues for Sonnet 5.5.
  - **Checks made in code: 34 of 44 pass every one** (26 of 30 before; on the same 30
    cases, 25 now). Writer 44 of 44, no data leak 8 of 8, no advice wording 42 of 42,
    figures grounded 35 of 42, length 39 of 42.
  - **The judge: 10 of 42 pass every line** (2 of 28 before). Its grounded line 16 of 42
    (2 of 28), no advice 41 of 42, gaps said 12 of 18, length 35 of 42; the lines written
    for each case 81 of 95 (37 of 50 before).
  - **Each question costs more.** On the same 30 cases the input went from 5,883 tokens a
    question to 10,758, and the cost of an answer from $0.0070 to $0.0119. No call read
    from the cache (`cache_read` 0 on every row). The tool definitions and the prompt are
    sent on both rounds of a question.
  - **Faults in the new tools' answers, none fixed yet:**
    - `pages-03`: rupee values turned into crore wrongly, ten times too large ("1,075
      crore" for ₹1,075,420,825, which is 107.5 crore). The tool gives rupees and the model
      did the conversion.
    - `history-02` ("how far is Apple off its high"): the model worked out the gap itself
      (4.43, 1.3%), which the prompt forbids; the figures are right, and the tool does not
      give them.
    - `pages-01`: "$299 billion" for 299,253,556,246, a fair rounding the code check
      cannot follow.
    - `news-04`: `get_price_history` was called beside the news tool for "what happened
      with TCS over the last month", and the answer says the price "declined through most
      of the month", which the closes given do not show.
    - `history-01`: the period is said to end on 10 October; the last close is 9 October.
    - `pages-04` and `pages-05`: 12 and 11 sentences, one per alert or trade, against a
      guide of 2 to 6.
    - `scope-06`: Microsoft's price left out though the snapshot had it. `scope-04` ("Any
      news on Paytm?") called no tool and offered the snapshot instead of giving it.
  - **Faults that are not new:** `smart-02` gives a fund's position size as the amount it
    sold (it failed on 2026-10-08 too; `get_smart_money` does not say which the figure
    is); `market-02` ties rate news to holdings no result links it to, and says holdings
    are "likely less rate-sensitive"; `edu-02` runs to 9 sentences; `ipo-04` again lists
    the next issues without saying it does not advise, the second answer in a row to do so.
  - **The judge marks down an answer for naming the user's holdings** when no tool result
    lists them (`pages-02`, `pages-03`, `pages-05`, `scope-04`, `market-02`). The model
    reads them from the question's own "My holdings" line, which the judge is not shown.
    Some of the 26 failures on its grounded line are this and not a fault in the answer.
  - Not done at the time: any fix, and a second run of any case. The fixes and a pilot on
    Claude Haiku 5.5 followed the same day (next item).
- **After P5: the fixes, and a six-case pilot on Claude Haiku 5.5** *(2026-10-11, at
  Annas's word; committed on `ask-tools` with the high and low below, and the output limit
  raised to 3,000 tokens in the commit after)*.
  - **Fixes made** (`npm test` passes: 32 files, 778 checks):
    - Money is given in the unit a reader uses, worked out in code: "₹107.54 crore",
      "₹32.94 lakh", "$299.25 billion" (`moneyText` in `pageTools.js`; the `value` and
      `total_value` fields of the fund and India tools). The raw rupee and dollar figures
      are no longer in those results.
    - `get_price_history` gives how far the last close stands from the highest and the
      lowest close (`last_close_vs_highest`, `last_close_vs_lowest`), and its note says
      the period's end date and not to describe the days between the closes listed.
    - `get_smart_money`'s note says a fund's shares and value are the size of its position,
      not the amount bought or sold. The fields are unchanged (the tool is on `/mcp` and
      `/v1`).
    - The system prompt is rewritten, shorter than before (4,481 characters against
      4,521) with four rules added: figures as given and no arithmetic; advice declined in
      the first sentence when asked for, and only then; at most five rows of a list, with
      how many more; call the snapshot instead of offering it. The IPO prompt names
      "whether to apply", says a stale calendar must be said, and that a listing date
      already past is not "expected".
    - The judge is shown the holdings the model is given with the question
      (`eval/ask/lib.js`, `run.js`).
  - **Not fixed: nothing is cached.** The cause is found: the app reaches Claude through
    the router's `/chat/completions` (`llmClient.js`), and the request it builds there
    carries no cache marker, though `qa.js` sets one. The router's documentation does not
    say how it takes one, so nothing was added.
  - **The pilot: six cases on `anthropic/claude-haiku-5.5` through the router, $0.063
    spent** (run `eval/ask/runs/2026-10-10T19-32-24`; `AIROUTER_MODEL` set for the run
    only; `move-01`, `scope-05`, `history-02`, `pages-03`, `pages-04`, `ipo-04`).
    - **It works through the router**: tools were called and answered over two or three
      rounds, and the reply names the model as Haiku 5.5.
    - **It costs about a sixth.** $0.0016 to $0.0028 an answer, as the router billed it,
      against $0.0123 to $0.0135 for the same cases on Haiku 4.5. Input was about 29%
      higher in tokens (14,800 to 15,400 against 11,500 to 11,900 for two rounds).
    - **Two of six were cut off by the 1,000-token output limit**, which now has to hold
      the model's thinking as well: `ipo-04` came back empty (not scored) and `pages-03`
      stops mid-sentence. `QA.MAX_OUTPUT_TOKENS` has to rise before Haiku 5.5 is used.
    - **The four that were scored pass every check made in code** (on Haiku 4.5 with the
      old prompt, three of these four failed one). The crore figure is right
      ("₹107.54 crore"), the distance from Apple's high is quoted from the result
      ("$4.43 below that high, or 1.3% below it"), and the alerts answer gives five, says
      how many more, and says an alert is what was flagged then.
    - **The judge passed every line on one of four.** Length on three (7 or 8 sentences,
      and the cut-off one). `move-01` ended a "why is my portfolio down" answer with "SenIQ
      does not give advice or predictions. Educational only, not investment advice.",
      which nobody asked for; the prompt was reworded after the run to say "only when
      asked" and that wording has not been run. `scope-05` was marked down for naming the
      "Add Asset" button, which is in the prompt and not in a tool result.
    - **Run before the high and low were added** (next item), so it says nothing of them.
    - **What the pilot does not show:** which of the improvement is the model and which
      the fixes (both changed at once; the same cases were not re-run on Haiku 4.5), and
      anything about the other 38 cases. One run of each case.
- **P6. US coverage,** last: the largest change in volume, and by then P3 will have shown
  how well the name matching holds.

Left as it is for now: **retention stays off**; **Ask stays on `claude-haiku-4-5`**; nothing
new goes on `/mcp` or `/v1` (every new tool is Ask only); hosting choices wait until there
is a deployment to make.

Other work, unchanged by the plan:

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
   quota raised once); rerun the Ask eval (now 34 cases; 30 cost about $0.50) to measure the
   tool changes. The four IPO cases alone are the first real check of the IPO tools:
   `node eval/ask/run.js --only ipo-01,ipo-02,ipo-03,ipo-04 --judge --max-usd 1 --yes-spend`
   (they are left out when `IPO_WATCH` is off).
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
| News retention | 04:45 daily | Only when `RETENTION=1`. Archives, rolls up and removes old stories (§5) |

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

**News retention** (`server/services/retention.js`, opt-in with `RETENTION=1`; commit `acc3204`,
branch `ipo-ask`). Until this, every story was kept for good and `articles` was the one
table that grew without limit. A story's age is counted from the later of the day it was
published and the day it was fetched. Two ages (`RETENTION` in `config.js`): **30 days**
for a story the pipeline judged irrelevant that has no reading and no IPO link (it is kept
only so it is not fetched twice), **180 days** for every other story (the 90 the app reads,
plus a quarter so recent history can be read again by a better model). Three things
happen before a story goes:
- **Archive.** The stories are written to `data/archive/articles-<time>.jsonl.gz`, one JSON
  story per line with its readings and IPO links. The file is read back and counted;
  nothing is deleted unless every story is in it.
- **Roll-up.** Deleting an article deletes its readings, and a strategy's sentiment factors
  read every day there is. So each reading's share of its ticker's day is added to
  `sentiment_daily` (count, score sum, weight sum, weighted score sum) in the same
  transaction as the delete, and `signalHistory.js` adds that to whatever is still stored.
  They are sums, so a day with some stories pruned and some not still adds up exactly.
- **IPO stories.** A story linked to an issue that is not finished is never removed.
  Finished means withdrawn or listed, and off the calendar. The first time a finished issue
  loses a story, its news as the page last showed it is saved to `ipo_news_summary`.

A story attached to an event still in the feed is left alone. Each run that removes
something is logged in `retention_runs`. Once anything has been pruned, the pipeline no
longer stores a story published before the 180-day line: some feeds list items for years
(24 stored stories were over 180 days old when first fetched, one of them 771), and one
coming back would be counted twice in its frozen day. **Prices are not part of this**: no
bars are stored in the database. The engine keeps daily bars as Parquet files in a cache
(`~/.seniq/data_cache`, 12 files, 596 KB) that can be deleted at any time, and the app asks
it for daily bars only: no page or route passes an interval, so backtests, signals and
paper trading are all on one bar a day. Decided 2026-10-10: it stays that way. The engine can
do 1 to 60-minute bars (the code came across with it), and nothing in SenIQ will ask for them.

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
(`answerCheck.js`). With `IPO_WATCH=1` Ask also reads the IPO Watch calendar (`ipoTools.js`, on the
branch `ipo-ask`): `get_ipo_calendar` (India and the US together unless one is asked for;
issues not yet listed unless a stage is given) and `get_ipo_detail` (one issue, by id or by
name, with its news). Three rules are built in. **It compares and never picks**: asked
which issue is promising it says SenIQ does not rate issues, then sets them side by side;
the only rankings are worked out in code, each by one recorded figure (subscription,
premium, listing gain with both ends and the count that gained). **It shows a grey market
premium exactly when the page does**, always called unofficial and dated. **It is Ask
only**: the tools are not in `dataTools.js`, so `/mcp` and `/v1` do not serve them while
InvestorGain's reuse terms are open. A question with an IPO word in it skips the holdings
pre-check ("the Reliance Jio IPO" names a stock the user may not hold); the tools that take a
ticker still refuse anything not held. Results are cut to the 4,000-character allowance by
dropping whole issues and saying how many are missing. With no model the answer is a digest
of the calendar, not the portfolio summary. An account with an empty portfolio can put an
IPO question to the model (`modelCanAnswer` in `qa.js`; it counts against the daily cap like
any other); every other question from it still gets "add a few holdings". News search (`newsSearch.js`) is keyword and full-text today; the vector
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
| News retention | `services/retention.js`, `scripts/retention.js`, migration `0043_retention.sql`; read back in `services/signalHistory.js` |
| Brief, Ask, news search | `services/reports.js`, `briefWriter.js`, `grounding.js`, `qa.js`, `qaTools.js`, `ipoTools.js`, `answerCheck.js`, `newsSearch.js`, `askThreads.js`, `routes/reports.js` |
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
| `node scripts/retention.js [plan]` · `prune --write` · `check <file>` | What a retention run would remove (reads only); do it; count the stories in an archive. `--as-of YYYY-MM-DD` runs as if it were that day |
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
| `RETENTION` | unset | `1` starts the daily job that archives and **removes** old stories. Default is off. Once it has removed anything, leave it on |
| `RETENTION_ARCHIVE_DIR` | unset | Where archive files go; default `data/archive` (gitignored) |
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

- **2026-10-10, late** (branch `ipo-ask`; the dev database, read only; no Claude call):
  - **Ask's IPO tools on the stored calendar**: both markets not yet listed (10 of 30 issues
    shown, the rest counted), India listed, US only, SME only, an empty stage, and an issue
    found by part of its name, by a name written differently and by id. Every result was
    under the 4,000-character allowance and none was cut mid-way. Both calendars were a day
    old and the results said so.
  - **The agent loop with a scripted stand-in for the model** and the real tools: the two
    IPO tools answered, a ticker tool asked for Tesla in the same turn was still refused,
    and the grounding check passed a truthful answer and flagged an invented listing price.
  - **`answerQuestion` with Claude off for that process**: "which IPO is looking promising"
    and "how is the Reliance Jio IPO doing" (which the holdings pre-check alone refuses)
    both got the calendar digest; "what is the price of Tesla" was still refused. The
    `claude_calls` table had 114 rows before and after.
  - **An empty portfolio, as a dry run** (an id no account has, since every account in the
    database holds something; the model a scripted stand-in; every write swapped for a
    recorder): an IPO question went to the model with "My holdings: none" and 13 tools and
    would have reserved one question; "why is my portfolio down" got "add a few holdings"
    and reserved nothing. With `IPO_WATCH` off both got "add a few holdings".
  - **News retention on a scratch copy of the dev database** (`seniq_retention_scratch`,
    made with `pg_dump`, dropped afterwards; the dev database was only read). Run twice from
    a fresh copy with the same result. As of today with the real ages: 459 unused stories
    removed of 2,471, none of the others, since nothing has been held 180 days yet. As if
    120 days later: 1,187 removed and 622 readings added to 235 ticker-days. As if 400 days
    later: 192 more, and 27 IPO news summaries saved. After each run the strategy sentiment
    history of all 135 tickers (620 ticker-days) matched the history before any pruning,
    to within 7e-15; stored plus rolled-up readings still came to 1,645; each archive read
    back with exactly the stories removed; alerts were untouched. Jio Platforms' 13 stories
    stayed through all three (no listing date, so not finished). A dry run wrote nothing,
    and a repeat of the last run found nothing to do. Live sentiment scores for six held
    tickers were identical before and after today's run.

**Never run for real:**
- Any hosting. Scheduled reports and the India poll only run while the app happens to be up.
- The 15-minute jobs through a real morning or evening on the users' real clocks; the weekly
  summary and the weekday morning brief email.
- The end-of-day report's "closed" and "skip" outcomes.
- Google/GitHub sign-in with the real providers (no client ids are set).
- An alert email with its Claude narrative actually sent.
- Vector news search and embeddings (no `HF_API_TOKEN`, no pgvector).
- Ask's strategy tools and the strategy-draft tool against the real engine (stand-in only).
- **News retention on the dev database or on a schedule.** Nothing has been removed from
  `seniq`, the 04:45 job has never fired, and a backtest has not been run through the engine
  on pruned history (the history the engine is sent was compared, not its result).
- **Ask's IPO tools with a real model: one run of each of the four `ipo-` cases**
  (2026-10-11, §3 step P2). Haiku kept to "compare, never pick" and gave no advice, and
  dated the premium each time it quoted one; it did not stay within the length, and it
  did not always say the calendar was stale. One run each is not a rate. The page has not
  been opened with the change: the new "Upcoming IPOs" chip is unseen in a browser.
- **The snapshot with a real model, and on the page.** The code-written answer was run
  through `answerQuestion` for the eval account on three questions (2026-10-11: no row
  added to `claude_calls`, the day's question count unchanged), and the tool was called
  directly for six names against live prices. No model has chosen `get_stock_snapshot`,
  and the Ask page has not been opened with the change. Three eval cases wait for P5:
  `scope-05` (rewritten), `scope-06`, `scope-07`.
- **The page tools with a real model.** Each was called directly against the dev database
  for two accounts (2026-10-11): the tracked funds and three funds' holdings, the
  politicians' trades by name, by holdings and across Congress, Indian deals and insider
  trades, the alerts and a stored brief. Every result was under 3,000 characters. Whether a
  model picks the right one of 17 tools, and keeps to the user's own rows unless the
  question widens, is unmeasured: `pages-01` to `pages-05` wait for P5. Not seen at all:
  the teaser limit (Ask is a Plus and Pro feature, so no Ask user is on a teaser plan), and
  an Indian investor with deals (the dev database has one attributed deal).
- **Price history with a real model.** `get_price_history` was called directly for a US
  share, an Indian share, a coin and a commodity (held and not), and the code-written
  answer with the history line was run through `answerQuestion` (2026-10-11, no row added
  to `claude_calls`). Whether a model quotes the figures as given, and whether it stays off
  trend calls, is unmeasured: `history-01` to `history-03` wait for P5. The figures were
  not compared with another price source.
- **`INDIA_LISTED_NEWS` in a running pipeline.** The switch has been measured on the
  stored stories and tested offline (§10); it has never been on while the pipeline ran.
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

### Stocks nobody holds
- **The 218 curated names are tagged in news whether anyone holds them or not**, but only
  from the general feeds: the per-company fetches (Finnhub company news, GDELT's Indian
  queries) run for held tickers only. In the 7 days to 2026-10-10 a held name averaged 33
  stories, and a name nobody held averaged 3.9 when it had any: 48 of 54 Indian equities, 39
  of 98 US equities and 14 of 45 coins had at least one.
- **The 1,837 listed names are tagged only while someone holds them**, so today none has a
  story: all 1,231 stored company readings belong to curated names. They can be searched,
  added and priced.
- **A US name nobody holds gets almost nothing.** The RSS feeds are four Indian and four
  crypto outlets; there is no general US feed.
- **Four listed names match wrongly, for anyone who adds them** *(measured 2026-10-10 by
  running the pipeline's matcher for all 1,837 names over the 2,484 stored stories; nothing
  changed)*: `QTWO` (Q2 Holdings) on every "Q2 results" headline, 76 stories; `BSE` (BSE
  Ltd) on every mention of the exchange, 80; `NDAQ` (Nasdaq Inc) on the index, 25; `JEF`
  (Jefferies) wherever it is the broker rating another company, 27. Nobody holds one today,
  so no wrong tag is stored. **Fixed on the branch `listed-news` (2026-10-11, commit `9937b1b`):**
  each of the four now counts only beside a company word ("Q2 Holdings", "BSE shares",
  "Nasdaq Inc", "shares of Jefferies"), and a possessive is not one ("BSE's Sensex"). On
  the stored stories that leaves 0, 1, 0 and 0 matches; the one is "Should investors dump
  BSE shares to subscribe to NSE?", which is about the company. Of 30 other matches picked at random, 27 were right; the three
  misses were `ROG` on "John Rogers", `CME` on "CME feeder cattle", and `VEDL` on "Vedanta
  Iron Steel", which is another company.
- **Ask used to refuse a stock the user does not hold**, with a fixed line and no model call,
  even where the app has its price and its sentiment. On the branch `ask-tools` (2026-10-11)
  it answers with that price and sentiment reading instead; news detail, smart money and
  impact are still for holdings only.
- **The snapshot answer declines advice in words when the question asks for it** (added
  2026-10-11 at Annas's word): "Should I buy Hero MotoCorp?" opens with "SenIQ doesn't give
  buy, sell or hold advice, or predictions." The question is read by a word list
  (`ADVICE_ASKED` in `stockSnapshot.js`), so an oddly worded request gets the figures
  without that line; it gives no advice either way.
- **Price history is closing prices, as the source gives them.** Shares and commodities
  come from Yahoo's chart route, coins from CoinGecko (one reading a UTC day). Nothing is
  adjusted here, so a dividend is not added back and the figures are a price change, not a
  total return. The highest and lowest were closes only until 2026-10-11; each session's
  high and low are now read too (below). A day's open is not read. The latest bar
  can be a session still in progress. Yahoo's route is unofficial, as it is for Indian
  quotes and IPO returns; a refusal gives "no price history right now".
- **The periods are fixed:** 1 week, 1 month, 3 months, 6 months, 1 year and the calendar
  year to date. Six months and the year to date were added to the four in the plan so the
  model has no reason to work out a figure itself; any other period ("since March") is
  answered from the month-end closes or not at all.
- **The page tools take no ticker.** `get_fund_holdings`, `get_politician_trades` and
  `get_india_deals` widen by a fund, a politician, an investor or the whole market, never
  by a stock: "which senators bought Tesla" reaches the model, which can read the newest
  disclosures across Congress but cannot filter them to a stock the user does not hold.
  The Congress page itself can show that row (`scope=all`); the plan keeps smart money on
  one stock with holdings, and the two were squared this way.
- **A fund or investor question is recognised by a word list** (`isPageQuestion` in
  `pageTools.js`): a tracked fund, its manager or a curated Indian investor named beside a
  word for what it did, or the Congress and deal pages named outright. Such a question
  reaches the model even when it names a company the user does not hold ("What does
  Berkshire Hathaway hold?"), and uses a question; anything else about that company still
  gets the code-written snapshot. The ten tracked funds are listed in that file as well as
  in migration `0004`; a test fails if a migration seeds one the list lacks.
- **Sample rows are kept out of Ask's congressional trades** whenever real disclosures
  exist (the dev database has 12 sample rows beside 225 real ones). The Congress page's
  route does not filter them; whether the page marks them was not checked.
- **A 13F shows no exits.** A position sold out completely is not in the latest filing, so
  the fund tool says what is new, added to and reduced, and says that exits are not
  shown. A fund's first stored quarter has nothing to compare with. Some issuers have no
  ticker (the CUSIP map did not resolve them) and are shown by name. Scion's latest filing
  is for the quarter to 2025-09-30.
- **The brief is read, never written, by Ask.** With no stored brief the tool says so; it
  does not generate one (the AI Workspace page does, and that can call Claude).
- **A year of history is fetched each time it is asked for** and kept in memory for 15
  minutes; nothing is stored.
- **A typed name is looked up as the Add Asset search does**, by ticker prefix or a piece of
  the name, plus an exact alias. "Tata" fits many and the tool hands back five to choose
  from; a company outside the reference (Shopify) is "not found". A commodity question
  ("what is driving gold?") is still a market question and does not get a snapshot from
  the pre-check.

### News retention
- **Deleting does not shrink the table file.** Postgres reuses the freed space for new
  stories; the file stays the size it reached. Retention stops growth, it does not hand
  space back (that takes `VACUUM FULL`, which locks the table).
- **A pruned day is frozen.** Its sums were made with the source weights and readings of
  the day it was pruned. A later change to `SOURCE_WEIGHTS`, a re-score or a re-tag changes
  only the stories still stored; the archive is the way back for the rest.
- **The day a story counts toward is the database session's local day** (`to_char` on
  `published_at`; India time on this machine). That was already so for the factors. A
  hosted database on UTC would place a late-evening story a day apart from where a frozen
  row placed it.
- **A feed item with no date is stamped with the time it is fetched**, so the check at
  ingest cannot stop one returning after it was pruned. None of the 2,471 stored stories
  lacks a date.
- **An unused story is gone from the database after 30 days.** If the company reference
  later gains the company it was about, a re-tag script will not find it. It is in the
  archive.
- **Not covered:** `alerts`, `claude_calls`, the IPO tables and the 13F tables are still
  kept for good. All are small (the largest, `institution_holdings`, is 16 MB for seven
  quarters).

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
- **Retention: decided 2026-10-10 that it stays off for now.** The case for it assumed a
  small free database (Neon's free plan, taken as about 0.5 GB and never checked); on AWS
  (below) the disk is not the constraint. The code stays as it is. A first run on the dev database would remove 459
  stories (all unused, none with a reading); `node scripts/retention.js` shows the plan after
  the next start, and removing rows is Annas's call (§2, rule 8). Worth switching on if
  Postgres ends up sharing a small disk with the app.
- **Where archives live once hosted.** The default is a folder on the app's own disk. On an
  EC2 instance that folder outlasts a redeploy of the code but not the instance; an S3
  bucket (one is enough) is the safer home, and the step that copies files there is not
  built.
- Whether the IPO tools should also go on `/mcp` and `/v1`. Decided no on 2026-10-10, until
  InvestorGain's reuse terms are settled; adding them to `dataTools.js` is all it would take.

**Planned, not built** *(agreed 2026-10-10; the order is in §3)*

- **Bars stay out of sight.** No price bars on a page, on `/mcp` or on `/v1`. Backtests,
  signals and paper trading stay on daily bars (§5). Price history reaches the user only
  through Ask (P4).
- **P3, name fixes: built for 18 names** *(2026-10-11, commit `9937b1b` on
  `listed-news`)*. `LISTED_NEEDS_CUE` in `entityResolver.js` holds them;
  `test/listedUniverse.test.js` keeps their cases fixed. A name in the set counts only
  beside a company word (Inc, Corp, Co, Ltd, Holding, Group, shares, stock) or after
  "shares of"; a possessive is not a cue, nor is "stock" in front of what a market has
  ("Nasdaq stock futures"). The rule covers the name and the bare symbol, one word or
  several. The sweep was run again that day (every listed name over the 2,485 stored
  stories, reads only, 14 seconds): 203 Indian and 54 US names matched at least one story,
  and every match was read. **Annas chose the first and third groups below; they are
  fixed. The second and fourth are not.** After the fix the 18 names keep two matches on
  the stored stories, both right ("BSE shares", "CME Group").
  **The cost, accepted:** a story about one of the 18 that names it bare is not tagged.
  On the stored stories that is four: `JMFINANCIL` in two lists of the day's losers,
  `ANGELONE` in "Angel One, Groww rally up to 38%" and "JP Morgan prefers Angel One, CAMS".
  The groups as found:
  - *A word or a place, not the company:* `CME` on "CME cattle futures" (2 of 3), `ROG` on
    "John Rogers", `MSCI` on "MSCI's broadest index", `ATUL` on "promoter Atul Garg", `STT`
    on a "State Street … SPDR ETF" fund name, `CHCO` (City Holding) on "GIFT City's", `PPLI`
    (core "People") on "People's Bank of China", `XYZ` (Block) on the news site The Block.
    The last three were already matched only beside a cue; the possessive is what let them
    through. **Fixed.**
  - *Another company with the same name:* `RS` (Reliance, the US steel company) on three
    stories about Reliance Industries; `CL` on "Colgate-Palmolive (India) Ltd", which is
    `COLPAL`; `PTC` (the US software company) on "PTC India"; `VEDL` on "Vedanta Iron
    Steel" and "Vedanta Aluminium", its demerged siblings, 3 of 10. `GOOG` matches
    "Alphabet's", the right company, whose curated row is `GOOGL`. **Fixed 2026-10-11, at
    Annas's word (commit `dd7a32c` on `ask-tools`),**
    by five rules in `entityResolver.js`, each with its cases in
    `test/listedUniverse.test.js`:
    - A listed name a curated company already answers to is matched by its symbol only
      (`RS`: 3 matches to 0). Two listed names are in that position, `RS` and `GOOG`.
    - `GOOG` is the same company as the curated `GOOGL` (`SAME_COMPANY`), so it is tagged
      whenever `GOOGL` is: 1 match to 16, the stories `GOOGL` already has.
    - A US name followed by "India", "(India)" or "of India" is the Indian company of that
      name (`CL`: 1 to 0; `PTC`: 2 to 1, and the one kept is about PTC Inc).
    - A headline about a company with a longer name is not about the shorter one, whatever
      the summary says (`VEDL`: 10 to 7; the three dropped were about Vedanta Iron and
      Steel and Vedanta Aluminium, whose summaries say what they were demerged from).
      "Vedanta Aluminium", "Vedanta Iron" and "Vedanta Oil" are listed as such names.
    - "and" in a name of several words may be "&" or missing, as the feeds drop it
      (`VISL` gained "Vedanta Iron Steel shares…", `VOGL` "Vedanta Oil & Gas…").
    With the switch on, the stored stories would now gain 418 tags across 199 names.
    **Still not handled:** a US name written exactly as its Indian namesake is ("Colgate-
    Palmolive shares" in an Indian outlet, with no "India" after it). Plan step P6's rule,
    that a US name is tagged only on a story from its own ticker's feed, is what covers
    that.
  - *A broker or rating agency giving its view of another company* (what `JEF` was): of the
    Indian names `JMFINANCIL` 5 of 7, `CRISIL` 5 of 6 ("Crisil Ratings affirms…"),
    `NUVAMA` 3 of 3, `ANGELONE` 2 of 4; of the US names `MCO` (Moody's) 2 of 2 and `EVR`
    (Evercore) 1 of 1. One story each: `BANKBARODA` ("a Bank of Baroda analysis"),
    `ABSLAMC` (an interview with its CIO), `KFINTECH` ("… is the IPO registrar", a line that
    returns with every Indian IPO). **The six named first are fixed by the cue rule. The
    three with one story each are fixed by a rule of their own** *(2026-10-11, commit
    `dd7a32c` on `ask-tools`; `npm test` passes: 32 files, 787 checks)*: the cue rule
    would have cost Bank of Baroda its four right stories. `playsAPart` in
    `entityResolver.js` leaves out a mention of a listed name when the words around it
    give it one of three parts in someone else's story:
    - the source of a view: the name before "analysis", "research", "study", "note",
      "survey", "report", "economists", "analysts" or "strategists", or after "according
      to" or "as per";
    - a speaker's employer: after a market voice's role (CIO, chief economist, fund
      manager, head of research or equity, analyst, strategist) and before a word for
      speaking ("discusses", "says"). A chief executive, a chairman or a founder is not
      on the list: quoted on his own company, the story is that company's;
    - an issue's registrar or lead manager: "X is the … IPO registrar", "X, the
      registrar to the issue", "the registrar of the issue is X", "the IPO registrar - X".
    The other mentions in the story are still read, so a company named again on its own
    is tagged. On the stored stories the rule removes those three matches and no other
    (504 listed-name matches to 501, every listed name, US and Indian, passed at once).
    **Not covered:** a registrar in the middle of a list ("the lead managers are A, B
    and C" drops only A), and the curated names, which are read as before.
  - *A passing mention in the summary under a headline that names no one:* `DLB` (Dolby
    Atmos in a cinema opening), `CMI` (Cummins as a competitor), and the US names in market
    wraps. The curated names are read the same way. **Not fixed.**
  - Everything else read as right: about 190 of the 203 Indian names have no wrong match.
  The original plan's wording follows.
  Mark the names in §8 so they match only beside a company cue ("Q2
  Holdings", "BSE shares"), and add a test that keeps those cases fixed. The same
  measurement finds further ones: list names by how many stories they match and read the
  top. **A wrong name in a headline does change the reading** *(seen 2026-10-11)*: a
  headline that names any company makes the summary's later mentions passing ones, so with
  "BSE" or "Jefferies" wrongly found in a headline the real companies in the summary were
  dropped. Taking the four wrong names out gave six other listed names a story each. The
  roundup rule was not affected on the stored stories (next item).
- **P3, India.** Pass every Indian listed name to the resolver, holder or not. No new
  fetch: the stories already arrive from the three Indian outlets. On the stored stories
  that gives 203 of the 439 names at least one. A story that gains a tag moves from
  retention's 30-day class to its 180-day one. **The switch is built** *(2026-10-11,
  commit `9937b1b` on `listed-news`)*: `INDIA_LISTED_NEWS=1` passes the Indian listed names to
  the resolver in `runNewsPipeline`, and to nothing else, so the per-company fetches still
  run for held tickers only. **Measured on the 2,485 stored stories, after the 18 name
  fixes, reads only:** 368 stories would gain 419 tags across 198 names; the roundup
  verdict changes on none; 3 stories lose a curated tag, each because its headline now
  names its real subject and a curated name further down the summary becomes a passing
  mention (a Vodafone Idea story loses `C`; a Physicswallah and Coforge story loses `TCS`
  and `INFY`; an Acutaas and Mankind story loses `DRREDDY` and `CIPLA`). Those 368 are the
  stories that would move to the 180-day class. Not done: the switch has never been on in
  a running pipeline, and stored stories are not re-tagged by it (new stories only).
- **P4, snapshot: built 2026-10-11** (commit `ee7b582` on `ask-tools`;
  `services/stockSnapshot.js`). Both parts as decided below. The tool is
  `get_stock_snapshot`, takes a name or a ticker, and is Ask only (`ASK_ONLY` in
  `dataTools.js`; a test fails if an Ask tool is neither in the public catalog nor named
  there). It already covers every name in the reference, not only the 218: a listed name
  gets its price, and for sentiment "not tracked yet" unless it has stories. The
  code-written answer covers up to three names and names the rest as not shown. If the
  price or the reading cannot be fetched the answer says so; if the snapshot itself fails
  the old fixed line is the answer. The eval's "no data for a stock outside the portfolio"
  check now lets a snapshot result through and nothing else. Seen on the dev database:
  Hero MotoCorp ₹4,895.50, up 0.80%, neutral at 0.50 from 2 stories; Tesla and Microsoft
  each with a z-score; AMD with a price and "no reading" (no stories in 72 hours); Suzlon
  with a price and "not tracked yet"; "Google" resolved to `GOOGL` by its alias.
  The plan as decided:
  (decided: both parts). *Part 1:* for a question only about a curated
  name the user does not hold, the fixed refusal becomes a snapshot written by code: price,
  day change, sentiment label and score, and the number of stories behind it. No model
  call, no question used. *Part 2:* the same snapshot as a tool for the model, for a
  question that mixes a held and a non-held stock. For a non-held stock it is price and
  sentiment only; news detail, smart money and impact stay with holdings. The story count
  is always given, and with no stories the answer is "no reading", not "neutral". Measured
  on 2026-10-10 for Hero MotoCorp, which nobody holds: ₹4,895.50, up 0.80% on the day,
  neutral at 0.50 from 2 stories in 72 hours, too little history for a z-score.
- **P4, every name.** Price and price history cover all 2,077 names in the reference, not
  only the 218. For a listed name the model does the recognising: the tool takes a name or
  a ticker, looks it up with the Add Asset search (`GET /api/portfolio/search`) and asks
  when several match. The code-written snapshot of part 1 stays on the 218, the only names
  safe to pick out of free text. A listed name's sentiment reads "not tracked yet" until
  P3 and P6 land.
- **P4, price history: built 2026-10-11** (commit `2587de8` on `ask-tools`;
  `services/priceHistory.js`). As decided below, with these choices made while building:
  coins come from CoinGecko by their id, because a Yahoo symbol for a coin can belong to
  another token; six months and the calendar year to date are given beside the four
  periods; the result is about 1,600 characters. The tool takes a name or a ticker, held
  or not, and a holding outside the reference still works. A question only about a stock
  the user does not hold that asks about the past ("How has Tesla done this year?") gets
  the same figures in the code-written answer, with no model call. Ask only: `ASK_ONLY`
  names it, so no price bars reach `/mcp` or `/v1`. The plan as decided:
  Daily bars fetched when asked, from the Yahoo route IPO returns and
  Indian quotes already use; nothing stored, and no need for the strategy engine. The tool
  returns figures worked out in code (change over 1 week, 1 month, 3 months and 1 year, the
  high and the low with their dates, average volume) and a short run of closes: a year of
  daily bars does not fit a 4,000-character tool result. It describes what the price did;
  no trend calls.
- **P4, the pages' other data: built 2026-10-11** (commit `5d7097f` on `ask-tools`;
  `services/pageTools.js`). Four tools, as planned: `get_fund_holdings` (the tracked
  funds, or one fund's ten largest positions with its share of the fund, the counts of new,
  added, reduced and unchanged positions, and the three largest of each),
  `get_politician_trades` (the user's, one politician's, or all of Congress),
  `get_india_deals` (the user's, one curated investor's, or the whole market; deals and
  insider trades; says so when `INDIA_SMART_MONEY` is off), `get_alerts_and_brief` (the
  newest alerts not dismissed with the unread count, and the latest stored brief). Each
  marks a row in a stock the user holds, hands back the matches when a name fits several,
  and refuses a name it does not have with the list of those it does. All four are Ask
  only. The plan as decided:
  The rule: **Ask can read whatever the app's pages show the
  user, and nothing more, with what he holds or follows first.** The pages already work
  that way (`scope=mine` by default: held tickers and followed funds, politicians and
  investors; `scope=all` on request), so Ask widens only when the question names a fund or
  a politician or asks about the whole market. Missing today: a fund's holdings and its
  changes (Institutions), any politician's trades (Congress), Indian investors and deals
  outside the holdings, the alerts list, the daily brief. About four tools, by combining.
  The pages' plan limits carry over. The cost is that every tool's definition is sent with
  every question.
- **P5, the model: Claude Haiku 5.5 now exists** *(found 2026-10-11)*.
  Released 2026-10-07, id `claude-haiku-5-5` (`anthropic/claude-haiku-5.5` on the router,
  which lists it). The line below, "the newest Haiku there is", was true when written on
  2026-10-10 by the notes then to hand and is not true now. From Anthropic's pages: $0.10
  and $0.50 a million tokens for a prompt up to 100,000 tokens (Haiku 4.5 is $1 and $5);
  the same text counts as about 30% more tokens; thinking is on by default and counts
  toward `max_tokens` (Ask's limit is 1,000); a prompt caches from 512 tokens (4,096 on
  Haiku 4.5); `temperature` other than 1 is refused (Ask sends none). **Nothing has been
  run on it.** The app reaches Claude through the router's `/chat/completions`
  (`llmClient.js`), which sends no cache marker (why no call reads from the cache), no
  effort setting, and does not carry thinking blocks between the rounds of a question;
  how Haiku 5.5 behaves through that route is unknown. `REPORTS.PRICE_PER_MTOK` and four
  `MODEL` settings in `config.js` name Haiku 4.5 and its price. `AIROUTER_MODEL` in the
  environment changes the router model without a code change, which is the way to try it
  on the eval first.
- **P5, the model (as decided 2026-10-10).** Ask stays on `claude-haiku-4-5`, the newest Haiku there is. The step up
  is Sonnet 5.5, at $2 and $10 a million tokens against $1 and $5. It thinks by default, so
  `QA.MAX_OUTPUT_TOKENS` (1,000) and an effort setting would have to change with it; it is
  not a one-line switch. The eval already checks that an expected tool was called. Wrong
  picks are first met by rewording or merging tool descriptions; Sonnet only if that fails.
- **P6, US.** Rotate the roughly 1,500 US names nobody holds through the Finnhub fetch,
  about 30 a run. The free limit is 60 calls a minute and US quotes share it. Each name is
  then checked about every 8 hours, and nothing is missed between visits because a call
  asks for 7 days; held names stay on 10 minutes. A US listed name is tagged only when the
  story came from that ticker's own feed **and** the matcher finds the name; today the
  pipeline throws away which ticker a story was fetched for. Measured 2026-10-10, reads
  only: for 14 listed US names picked at random Finnhub had 6.8 stories a ticker in 7
  days, 3.4 of them naming the company, and 12 of the 14 had at least one; ten general US
  feeds pulled once named 27 of the 100 curated names and 19 of the 1,398 listed, so
  general feeds do not reach the long tail. Costs: about 1,450 more stories a day against
  about 300; that many more for FinBERT to read; and Finnhub's free plan is reported to be
  for non-commercial use, which already covers today's fetch.
- **Storage once P3 and P6 are on** (estimates from small samples): about 1,750 stories a
  day; the database near 0.5 GB and level with retention on, or about 1.4 GB more each year
  with it off; the archive about 145 MB a year.

**Parked by Annas**
- Hosting. **Annas said on 2026-10-10 that it will be on AWS**, not Render and Neon; nothing
  past that is chosen (RDS or Postgres on the instance, the instance size). `DEPLOY.md` and
  `render.yaml` still describe Render and Neon and have not been rewritten; `DEPLOY.md`'s
  warning that FinBERT is too heavy for the smallest instance applies on AWS too. If a
  Render service is ever connected to `main`, a merge deploys and applies every migration.
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
| `v1.14` / `v2.15` | `d0aa0ca` | #16: IPO Watch opens an issue's news on its latest 5 stories, with a "Show all N stories" button for the rest; the tone and the chart are still from every story. Page only |

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

**Pull request #16** (`ipo-show-all`) was merged on 2026-10-10 as `d0aa0ca`, at Annas's
request from a session, and the branch deleted. Tagged `v1.14` / `v2.15`. IPO Watch opens an
issue's news on its latest 5 stories, with a "Show all N stories" button; page only.

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
| `README.md` | Project overview, features, setup (macOS and Windows), known limits | Yes — rewritten 2026-10-08 against this handoff, up to `v1.8` / `v2.8`; later features added section by section, latest `v1.14` / `v2.15` |
