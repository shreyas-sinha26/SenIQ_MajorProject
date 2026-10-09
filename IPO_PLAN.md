# SenIQ — IPO & Small/Mid-Cap Sentiment Optimization (plan)

## The thesis
Sentiment has the **most predictive power on small, new, and recently-listed companies** — they
have little analyst coverage, thin liquidity, sparse history, and heavy retail participation, so
price moves on *expectations* (news, hype, demand) far more than on fundamentals. IPOs are the
extreme case: no earnings history, so price ≈ sentiment at first.

**Why this fits SenIQ:** the existing edge (13F + congress tracking) is a **large-cap** game —
institutions and politicians trade big names. That coverage is *blind* to small-caps and IPOs.
SenIQ's **sentiment engine** is exactly the tool for that blind spot. So the positioning becomes:
**big-money signals for the giants, sentiment + IPO intelligence for the small and new ones.**

> Status: **plan only.** Nothing below is built yet. Ordered by leverage (cheap/reuses-data first).
> Last updated 2026-10-09: Change 3 rescoped as IPO Watch v1 (India first, GMP included).

---

## Change 1 — Size-aware sentiment  *(highest leverage; reuses existing data)*
Today the impact score treats a sentiment delta the same for Reliance and a ₹2,000cr small-cap.
Add a **sentiment-sensitivity multiplier** so the same sentiment moves the score *more* for
small/uncovered/new names:
- inputs: market cap (smaller → higher), liquidity / avg volume (thinner → higher), news/analyst
  coverage density (lower → higher), age since listing (newer → higher).
- mechanically: one new factor in `impactScoring.js` (6-factor → add a `sensitivity` term). No new
  data needed.
- **Effect:** SenIQ now "knows" a hype spike on a tiny name matters more than on a mega-cap — the
  core research finding, implemented directly.

## Change 2 — Composite "Signal Score" (0–100)  *(reuses existing data)*
Blend SenIQ's existing pipelines into **one number per ticker** (e.g. "NVDA 84/100 bullish"):

| Signal | Have it? |
|---|---|
| News sentiment | ✅ engine |
| Social sentiment | ✅ Reddit (X later) |
| Institutional (13F) | ✅ EDGAR |
| Congress / insider | ✅ FMP |
| Analyst upgrades | ⚠️ needs a source (Finnhub has some) |
| Options activity | ❌ no source (skip v1) |

- **Size-adjusted weights:** up-weight news/social for small caps, down-weight for efficient
  large caps. Start with sensible fixed weights; make them **learnable later** (Change 5).
- Better than a generic blend because it includes **congress + 13F**, which most sentiment scores
  lack.
- Becomes a **first-class signal factor in the strategy builder** ("enter when Signal Score > 75")
  — this feature and the strategy engine reinforce each other.

## Change 3 — IPO Watch  *(the new, differentiated surface; new data)*
A dedicated section for **upcoming, open, and recently-listed** IPOs, tracked across the lifecycle
(announced → open for subscription → allotment → listing day → post-listing momentum).

> **Decided 2026-10-09:** India first. GMP is in v1. Named "IPO Watch" (was "IPO Radar").

### How IPO news is handled today (the starting point)
There is no IPO-specific handling, and most IPO news is dropped on purpose:
- `ipo` is excluded from `MARKET_KEYWORDS` in `server/config.js` — small-cap subscription updates
  were the bulk of the noise leaking into the Markets bucket. **That exclusion stays.**
- An unlisted company resolves to no ticker in `entityResolver.js`, so its news attaches to no
  portfolio. Only a listed parent catches it (Jio → RELIANCE).
- `ipo` / `listing` are holding topic words in `materiality.js`, so repeat headlines on one holding
  collapse into one story; a single unconfirmed IPO headline is recorded, never pushed.
- In `impactScoring.js` an IPO story reaching a holding only as market news is capped at macro
  severity.

So IPO Watch does **not** loosen the main feed. It **routes** the IPO headlines the feed discards
into their own surface.

### v1 scope (India only)
1. **Calendar + lifecycle.** Mainboard and SME issues: open/close/allotment/listing dates, price
   band, lot size, issue size, fresh issue vs offer-for-sale, and current lifecycle stage.
2. **Subscription ratios.** Retail / HNI (NII) / QIB and total, refreshed while the issue is open.
3. **GMP.** Grey Market Premium in ₹ and as % of the upper price band, kept as a time series so
   the trend is visible, not just the latest number.
4. **News + sentiment arc.** IPO headlines routed by name to the IPO, scored by the existing
   sentiment engine, shown as a curve from announcement to listing.
5. **Outcome logging from day one.** Every IPO's features plus actual listing-day / 1w / 1m
   returns (the dataset Change 5 trains on).

### Build status (2026-10-09, branch `ipo-watch`)
- **Built:** the `ipos` table (migration 0031), the calendar service with lifecycle stages
  computed on read (`server/services/ipoWatch`), `GET /api/ipo-watch/calendar`, the IPO Watch
  sidebar tab, and offline tests. All behind `IPO_WATCH=1`, off by default.
- **Source:** InvestorGain's live IPO table (`sources/investorgain.js`), one request a day at
  09:15 IST, never on boot; `node scripts/ipo_watch.js poll` runs it by hand. First poll on
  2026-10-09 stored 50 issues (18 mainboard, 32 SME). The page gives one price, stored as the
  top of the band; the bottom of the band, fresh issue / offer-for-sale split and the mainboard
  exchange are not on it. The same page carries GMP, the subscription multiple and the listing
  price, which the next steps can read without a second request.
- **Why not an exchange:** on 2026-10-09 BSE answered an identified request with "Access
  Denied" (403) and NSE timed out or refused 6 requests, including the two routes the
  smart-money poller uses. Neither is worked around with browser-imitating headers or cookies.
- **Before any hosting:** InvestorGain is a Chittorgarh.com site. Its robots.txt allows the
  page and its disclaimer page says nothing on automated reuse, but it is "All Rights
  Reserved" and no permission has been asked. Settle that, or find a licensed source — the
  same open item as NSE for India smart money.
- **GMP (built 2026-10-09):** read from the same page in the same request, so no extra
  traffic. Stored in `ipo_gmp` (migration 0032) as one reading per issue, per source, per
  market day; a second poll that day replaces the day's reading. Recorded only before
  listing. Shown on the calendar as ₹, as a share of the top price, and with an up/down mark
  against the previous reading; hidden once a reading is older than 36 hours or the issue has
  listed. Not used by alerts or the impact score. First run stored 3 readings — the page had
  no figure for the other 3 unlisted issues. The trend needs a few days of polls to exist.
- **Subscription (built 2026-10-09):** from InvestorGain's live subscription table, a second
  source and a second request per poll (1.5 s after the first). Total, QIB, NII (with the
  small/big HNI split) and retail, stored in `ipo_subscriptions` (migration 0033) as one
  reading per issue, per source, per day the figures are as of — so the final figure is
  stored once however often it is seen. Shown on the calendar as the total with the QIB / NII
  / retail split beneath, for open, closed and listed issues; always dated, never hidden.
  First run stored 45 readings. The daily 09:15 poll means an open issue shows the previous
  evening's figures, not live ones.
- **Calendar rules added with it:** an issue with a close date in the past is "closed" even
  when its open date is unknown; an issue closed more than 10 days with no listing date on
  record is left off the calendar (the source has lost track of it).
- **Outcome logging (built 2026-10-09):** `ipo_outcomes` (migrations 0034, 0035), one row per
  issue, written the first time a listed issue's result is seen and never rewritten: issue
  price, listing price, listing gain %. It holds the label only; features are joined at
  training time from `ipos`, `ipo_gmp` and `ipo_subscriptions`. First run logged 41 of 44
  listed issues (the other 3 listed that day and had no result yet).
  - The source's host rewrites a listing price with decimals as a "protected e-mail", so for
    35 of the 41 only the gain was readable. The gain is logged as given and the price worked
    back from the issue price, marked `price_derived`. The hidden value is not decoded.
  - The same page reports the premium on the open, close and listing days; those fill
    `ipo_gmp` for days we did not see (96 readings on the first run) and never replace a
    reading of our own.
  - **Missing:** 1-week and 1-month returns. They need the listed ticker (not on the source's
    page) and a price for it; the pre-listing registry's link-to-ticker step unlocks this.
- **Pre-listing registry (built 2026-10-09):** `server/services/ipoWatch/registry.js`,
  migration 0036. The `ipos` table is the registry; this adds what makes it one:
  - **Story linking.** Stored articles are matched to an issue by name and linked in
    `ipo_articles`. A full multi-word name matches on its own; a one-word name or a hand-added
    alias matches only in a story plainly about an IPO. Runs at the end of every news
    pipeline pass (last 2 days) and after each calendar poll (last 30 days, so a newly seen
    issue gets its earlier stories). An issue stops matching 30 days after listing. First run:
    42 links across 24 issues from 1,118 stories. All 42 headlines were read and none looked
    wrong; a few matched on the summary, which was not read.
  - **Aliases.** `node scripts/ipo_watch.js alias "Jio Platforms" Jio "Reliance Jio"` (set).
    Short forms the news uses ("EverestIMS", "Nityas Gems") are missed until an alias is added.
  - **Ticker on listing.** A listed issue is looked up on Yahoo's symbol search by name, at
    most once a day for 14 days after listing, 20 lookups a run. First run found 8 of 10
    mainboard issues before Yahoo timed out; Yahoo did not know the one SME issue tried by
    hand, so most SME issues will stay without a ticker.
  - The main feed is unchanged: `ipo` stays out of the market keywords, and a linked story is
    not made relevant to any portfolio.
- **Returns after listing (built 2026-10-09):** `server/services/ipoWatch/returns.js`,
  migration 0037. For a listed issue with a ticker, Yahoo's daily prices give the listing-day
  open and close, the close a week later and the close a month later (first trading day on or
  after listing + 7 / + 30, at most 5 days late), each stored on `ipo_outcomes` as a return
  over the issue price and written once. Runs after the daily poll: one request an issue, 20 a
  run, once a day, for 45 days after listing. First run: 20 issues have a ticker (13 mainboard,
  7 SME); 17 got a listing-day close and 6 a 1-week close. Yahoo's listing-day open agreed
  with every listing price that had been worked back from the gain (355.10 vs 355.09, 148.00
  vs 148.01), which also confirms those tickers are the right companies. Two issues had no
  price yet for their listing day and one none for its 1-week day; they are retried daily.
- **News + sentiment arc (built 2026-10-09):** `server/services/ipoWatch/arc.js`, migration
  0038, `GET /api/ipo-watch/:id/stories`. The main pipeline stores sentiment per ticker, which
  an unlisted company lacks, so 25 of the 34 linked stories had no reading at all and the rest
  were readings of another company (Reliance, for Jio Platforms). Each linked story is now
  read as news about the issue — FinBERT when on, else the word list — and the reading kept
  on the link. Runs at the end of each news pipeline pass, 60 stories a run. On the page, a
  click on an issue with stories opens its overall tone, a tone-by-day chart with the open /
  close / listing days marked, and the story list. First run: 30 stories read (17 positive,
  9 neutral, 4 negative), 12 left unread because they cover several issues.
  - **Subscription headlines are scored by rule, not by the model (2026-10-09).** FinBERT read
    "IPO subscribed 42%" and "subscribed 23%" as positive (0.83, 0.84): it reacts to the word,
    not the number. A headline that carries a subscription figure is now scored from the
    figure (`subscriptionTone` in `arc.js`, model `subscription-rule`): 1x is neutral (50),
    each tenfold adds 20 (10x → 70, 100x → 90, capped at 95); under 1x is negative only when
    the figure is final (the headline says so, or the story is from the closing day or later)
    and neutral before that. The figure in the headline is used rather than our stored
    subscription data, because the headline's figure is as of the story and ours is mostly
    the final one. `node scripts/ipo_watch.js retone` re-scores stories already read, with no
    model run; it changed 11 of the first 30 (the two above went from 83 / 84 to 50, both
    being day-one figures).
  - Still read by the model, and often too kindly: a "subscription status … should you
    subscribe?" explainer with no figure in the headline (read as 93), and GMP headlines.
  - A story naming two issues is treated as about one when only one of them is matched (the
    other needing an alias), so it is read when it should not be. Aliases "Nityas Gems" and
    "EverestIMS" were added for the two cases seen.
  - Most issues have 1–3 stories, so the "arc" is one or two points. It needs an issue with
    weeks of coverage to look like a curve.
- **US calendar (built 2026-10-09):** `sources/finnhub.js`, migration 0039. Decided the same
  day: SPACs are stored but hidden by default; filed issues are shown; one tab with an
  India / US switch, India first.
  - Finnhub's IPO calendar on the existing key, one request in the daily poll (30 days back,
    60 ahead). First run stored 60 issues: 37 filed, 12 priced, 3 expected, 8 withdrawn; 24 of
    them SPACs (a name with "Acquisition" in it).
  - `ipos` gained `market` ('IN' / 'US'); a row is unique on (market, name_key), and `board`
    is India-only. A US issue's stage is read from the source's status: filed → Filed,
    expected → Expected, priced → Priced. A company listed twice (filed, then withdrawn)
    keeps its latest event.
  - Finnhub dates nothing past the current week, so there is no forward calendar: "Expected"
    is this week's deals, and a filed issue shows its filing day.
  - The registry links stories to US issues too; none of the stored stories matched on the
    first run. Company suffixes (Inc, Corp, PLC, LLC) are now dropped from name keys.
  - **US outcomes and returns (built 2026-10-09):** migration 0040, `resolveUsOutcomes` in
    `returns.js`. Finnhub gives a priced deal's IPO price and ticker and nothing after, so the
    whole outcome comes from Yahoo's prices: the first day the feed has for the ticker (on or
    within 5 days after pricing, and with no prices before it) is stored as
    `first_trade_date`; that day's open is the listing price, and the listing-day, 1-week and
    1-month closes follow as for India, all against the IPO price. SPACs are skipped. A priced
    issue now shows as "Priced" until a first trading day is known, then "Trading". First run:
    5 of 6 priced companies resolved; Yahoo had no prices for ACCV; ROZE AI has no IPO price
    from Finnhub, so it has a listing price but no gain.
  - **News for US issues (built 2026-10-09):** the news pipeline now also asks Finnhub for the
    company news of up to 10 US issues with a ticker (expected and priced first, then the
    newest filings; `monitoredTickers`), so there are stories to link — this is Change 4 for
    the US. First pass: 13 new stories, 6 links. Two side effects: those stories go through
    the normal relevance step, and 3 of the 13 were kept as holding news because they also
    name a held company; and story linking now goes by when a story was fetched, not
    published, since a followed ticker's news arrives days old.
  - **Tone only when the headline names the issue (2026-10-09).** A "stocks moving
    pre-market" list that names an issue further down is linked and listed, marked as naming
    it in passing, and not read. `retone` also removes readings that fail this test and
    queues stories a new alias brings into the headline.
  - **All / Deals filter** on the US side: Deals leaves out filings and withdrawals.
  - **Still open for the US:** no forward calendar. Finnhub dates nothing past the week, and
    Nasdaq's IPO calendar did not answer an identified request (nor its robots.txt), so it is
    not used. US issues the news never names in a headline still get no tone.
- **IPO Watch v1 (India) is feature-complete as planned.** Open: the items marked above and the
  source's reuse terms before any hosting.

### Pre-listing entity registry
An IPO has no ticker until it lists, so v1 needs a small registry: one row per IPO with company
name, aliases, and lifecycle stage. IPO headlines match against it by name. On listing day the row
is linked to the real ticker and the accumulated history carries over. This is the v1 form of
Change 4.

### GMP rules (it is unofficial data — treat it that way)
- **One adapter.** All GMP scraping sits behind a single source adapter, so a broken or blocked
  source is a one-file fix and a second source can be added beside it.
- **Snapshots, not overwrites.** Store each reading with `source` and `fetched_at`.
- **Stale means hidden.** If the latest reading is older than a set threshold, show "GMP
  unavailable" rather than an old number.
- **Labelled in the UI** as unofficial, grey-market, and not a predictor of listing price.
- **Never feeds alerts or the impact score in v1.** Display and logging only, until Change 5 shows
  whether it has predictive value.
- **Check each source's terms and robots.txt before scraping it**, and keep the request rate low.
- GMP sources are Chittorgarh / IPO-Watch-style sites; subscription and calendar data come from
  NSE/BSE. Which specific sources are used is still to be picked and verified.

### Out of v1
- **US IPOs** (no GMP; S-1 data, lock-up expiry, underwriter quality — a different data shape).
  Checked 2026-10-09: Finnhub's IPO calendar (`/calendar/ipo`) answers on the key the project
  already has — 33 issues over five weeks, each with date, exchange, name, symbol, price range,
  share count, total value and a status (filed / expected / priced / withdrawn). It has no
  subscription figures and there is no grey market. Because the symbol is known up front, the
  first-day and later returns can come from the existing price service. Needs a `market`
  column on `ipos` (its `board` check is India-only) and a US currency on the page.
- **Listing-gain estimate** — no labelled outcomes yet, so it would be a guess (Change 5).
- Anchor-investor quality and promoter-holding analysis.
- Push alerts on IPO events.

## Change 4 — Auto-monitor new listings from announcement
*(The pre-listing registry in Change 3 is the first half of this; what remains is adding the listed
company to the monitored universe automatically.)*
The moment an IPO / new company is announced, **auto-add it to the monitored universe** so its
sentiment history starts accumulating *before* it lists. (Ties to the universe-wide signal-recording
decision.) By listing day you already have the full pre-listing hype arc — the exact window the
research says predicts the pop.

### Change 4, refined (2026-10-09) — what happens to an IPO after it lists  *(approved and built 2026-10-09)*

**The lifecycle today.** An issue is tracked from first sighting; the listing result is logged
once; GMP stops at listing; the ticker is looked for for 14 days (India); the name matches news
for 30 days after listing; prices are fetched for 45 days (so the 1-month return is the last
one); the issue leaves the IPO Watch page 90 days after listing. Its row and history are kept
for good — they are the training data for Change 5.

**The gap.** After that a newly listed company is nobody's. It is not in the company reference
(`companies`), so the add-holding search does not find it. It *can* still be added by typing the
symbol, but badly: no name, no exchange (an Indian share is then not priced in rupees), and its
news is matched the loose way reserved for "a ticker we know nothing about".

**Proposal: graduate it into the company reference, in a tier of its own.**

1. **A third tier, `ipo`.** Not the `listed` tier: that tier is rebuilt from
   `server/data/listed.json` on every boot, and any `listed` row not in the file is switched
   off, so a graduated IPO put there would be deactivated at the next restart. `ipo` rows are
   left alone by the seed.
2. **When an issue graduates** — once it has a ticker *and* the price feed confirms it:
   - India: Yahoo has a price for the ticker on the listing day, and where the source gave a
     listing price, Yahoo's opening price is within 2% of it (this is the check that showed the
     tickers found so far are the right companies).
   - US: a first trading day is on record (`first_trade_date`). SPACs never graduate.
   - A ticker already in the reference is never overwritten; a clash with a different company
     is recorded and skipped.
3. **What graduation gives.** The add-holding search finds it; a holding gets its name and
   exchange, so an Indian one is priced in rupees; and its news is matched strictly, like a
   listed-tier company — as whole words with capitals, a one-word name only beside a company
   cue ("Moneyview shares"), and only while someone holds it. `namesHolding` in
   `entityResolver.js` learns the `ipo` tier from the table for this.
4. **What it does not give.** No sector (neither source has one). No hand-written aliases,
   brands or executives — that is the curated tier, and promoting a big listing (Jio Platforms)
   into it stays a decision made by hand.
5. **History.** The `ipos` row keeps its pre-listing stories, tone, GMP, subscription and
   outcome, joined to the company by ticker. They are NOT copied into the per-ticker sentiment
   tables in this step (see open questions).
6. **Later promotion.** When a graduated company enters the Nifty 500 or S&P 1500 file, the
   seed moves its row from `ipo` to `listed`.
7. **Three-month return.** Price fetching runs to 100 days after listing instead of 45, and the
   outcome gains a 3-month close and return (first trading day on or after listing + 90). One
   more request per issue.
8. **On the page.** A graduated issue shows an "Add to portfolio" action in IPO Watch.

**Unchanged.** The 14 / 30 / 90-day windows above; nothing is ever deleted; an issue with no
ticker (most SME issues) cannot graduate and stays as history only.

**Decided by Annas (2026-10-09).** SME issues graduate too, when they pass the price check.
Pre-listing tone is NOT copied into the per-ticker sentiment history. The "Add to portfolio"
action is included.

**Built.** Migration 0041; `graduate` in `registry.js` (runs after the daily poll;
`node scripts/ipo_watch.js graduate` by hand, no request made); the `ipo` tier read into
`namesHolding` by `loadIndex` in `entityResolver.js`; the seed moving an `ipo` row to `listed`
when the file gains its ticker; `close_3m` / `ret_3m_pct` with price fetching to 100 days and a
6-month price window; a "+ Portfolio" button on graduated issues.

**First run.** 22 companies graduated: 17 Indian (10 mainboard, 7 SME) and 5 US. They survived
a restart (the boot seed left them active) and the add-holding search finds them. Held back: 2
Indian issues with no listing-day price yet (Vishal Nirmiti, Vans Electroengineerings), 1 listed
that day with no outcome yet (TNA Solutions), and 1 US issue with no first trading day (ACCV).
Each is picked up by a later poll once its price arrives.

**Not verified.** The "+ Portfolio" button was seen on the page but not clicked, so as not to
add a holding to a real account. The move from `ipo` to `listed` and the 3-month figure have
tests or code only — no issue is old enough, and none is in the file, to see them live.

**Limits.** A graduated company has no sector. Its name is the calendar's short one ("German
Green Steel"), not the legal one. Nothing switches a graduated company off if it is later
renamed or delisted. Company tickers are one namespace across both markets, so an Indian and a
US company with the same symbol clash: the second is noted on its `ipos` row and skipped.

## Change 5 — Outcome logging → listing-gain predictor  *(v2; needs data first)*
The listing-day / 1-week / 1-month return model is real but **can't be trained on day one** (no
labeled outcomes). Like the E3 outcome-logging design: **log every IPO's features + actual returns
now**; after a few dozen IPOs, train a simple, explainable model (gradient boosting / logistic
regression). Features: offer price, issue size, market cap, promoter holding, anchor allocation,
subscription ratios, GMP, news/social sentiment, article count, sector momentum, Nifty/VIX, FII/DII
flows. Targets: listing-day / 1w / 1m / 3m return, P(beat benchmark). **Build the logging now; the
model rides on the accumulated data.**

---

## Honest constraints (design around these)
1. **IPO data sourcing** (GMP/subscription) is the hard, scrape-heavy, India-leaning part — the
   biggest unknown. GMP is in v1 anyway, under the rules in Change 3.
2. **Free small-cap news is thin** — *except* around the IPO event itself, which is fortunately the
   moment that matters, so the signal is there when needed.
3. **Horizon honesty:** sentiment predicts the *short-term* pop; fundamentals dominate long-term
   (many IPOs give back early gains). Label IPO signals as short-horizon, keep the **informational,
   not advice** frame — retail gets hurt here most.

## Sequencing
> **Decided 2026-10-09:** IPO Watch goes first, ahead of Changes 1–2, starting with the calendar.

1. **Change 3 IPO Watch v1** — India only. Build order: calendar + lifecycle → pre-listing
   registry → subscription ratios → GMP → news + sentiment arc. Outcome logging starts with the
   calendar.
2. **Cheap, reuses data:** Change 1 (size-aware sentiment) + Change 2 (Signal Score).
3. **After that:** rest of Change 4 (auto-add listed IPOs to the universe), then US IPOs.
4. **v2:** Change 5 (train the listing-gain predictor) once the logged dataset is real.

## Ties into existing plans
- `impactScoring.js` 6-factor model (Change 1 adds a sensitivity term).
- `STRATEGY_PLAN.md` — the Signal Score is a SenIQ signal factor for the builder/MCP.
- Universe expansion (S&P 500 + Nifty 100 + curated small/mid + auto-added IPOs) — Change 3/4 need it.
- E3 outcome logging — the pattern Change 5 reuses.
