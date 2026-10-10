/**
 * Central config + feature-flag layer.
 * Tier gating, disclaimers, and rollout flags live here so the rest of the
 * codebase reads from one place as SenIQ grows (multi-asset, social, billing).
 */

// Shown across the UI + attached to generated reports. Regulatory framing:
// everything SenIQ surfaces is informational, never imperative advice.
const DISCLAIMER =
  'SenIQ is informational, not investment advice — just here to keep you ' +
  'informed about what you own so you can make better decisions.';

// Tier matrix scaffold (Phase 4 fills in billing). Limits are read by gating
// middleware; numbers reflect the decided Free/Plus/Pro split.
// Tier order (lowest → highest) — used by requireTier() comparisons.
const TIER_ORDER = ['free', 'plus', 'pro'];

const TIERS = {
  free: {
    label: 'Free',
    rank: 0,
    maxHoldings: 7,
    sources: ['news', 'macro'],
    sentimentDepth: 'basic',       // acute + 7-day history; no 90-day z-score
    impactFeed: 'top',             // today's single most important event only
    claudeReportsPerDay: 0,
    qaPerDay: 0,                    // Ask-anything (E6) gated off
    realtimeAlerts: false,
    apiAccess: false,
    strategies: 'list',            // names + descriptions only (Phase 7)
    smartMoney: 'teaser',          // top 1-2, delayed, in the digest only
    smartMoneyRealtime: false,     // no instant smart-money alerts
    webhooks: false,
    price: { usd: 0, inr: 0 },
  },
  plus: {
    label: 'Plus',
    rank: 1,
    maxHoldings: Infinity,
    sources: ['news', 'reddit', 'macro'],
    sentimentDepth: 'full',        // + 90-day z-score baseline
    impactFeed: 'full',            // full ranked impact feed + exposure %
    claudeReportsPerDay: 1,
    qaPerDay: 10,
    realtimeAlerts: true,
    apiAccess: false,
    strategies: 'applicability',   // + live "what it flags in your portfolio"
    smartMoney: 'full',            // full Institutions + Politicians tabs
    smartMoneyRealtime: true,      // instant alerts on followed + holdings
    webhooks: false,
    price: { usd: 9, inr: 399 },
  },
  pro: {
    label: 'Pro',
    rank: 2,
    maxHoldings: Infinity,
    sources: ['news', 'reddit', 'macro'],
    sentimentDepth: 'full',
    impactFeed: 'full',
    claudeReportsPerDay: 2,
    qaPerDay: 30,
    realtimeAlerts: true,
    apiAccess: true,
    strategies: 'personalized',    // personalized to portfolio (Phase 7)
    smartMoney: 'full',            // full + filtered to holdings
    smartMoneyRealtime: true,
    webhooks: true,                // register outbound webhooks for events
    price: { usd: 24, inr: 999 },
  },
};

// Pricing for the upgrade UI. Annual ≈ 2 months free (10× monthly).
const PRICING = {
  currencies: { usd: { symbol: '$', code: 'USD' }, inr: { symbol: '₹', code: 'INR' } },
  annualMonthsFree: 2,
};

// Rollout flags — flip on as each phase lands. X stays deferred indefinitely;
// FINBERT_CLASSIFY is opt-in because the model downloads ~250MB on first run.
const FEATURES = {
  MACRO_INGEST: true,    // Phase 2b: GDELT macro + India news
  RSS_INGEST: true,      // Phase 2b: Indian financial RSS feeds
  REDDIT_INGEST: true,   // Phase 2b: Reddit (needs REDDIT_CLIENT_ID/SECRET to actually fetch)
  X_INGEST: false,       // deferred — interface stubbed only
  FINBERT_CLASSIFY: process.env.FINBERT_CLASSIFY === '1', // FinBERT reads each new story (see FINBERT below); off = the word list
  // A language model reads the multi-company stories FinBERT cannot split per company (see
  // TARGETED below). Its own opt-in, and a choice of model: COMPANY_SENTIMENT_LLM=1 (or
  // "claude") spends on the model key; "ollama" uses the local model, at no cost.
  // Value here: false | 'claude' | 'ollama'.
  COMPANY_SENTIMENT_LLM: ({ 1: 'claude', claude: 'claude', ollama: 'ollama' })[String(process.env.COMPANY_SENTIMENT_LLM || '').toLowerCase()] || false,
  SMART_MONEY: true,     // Phase 3: 13F (EDGAR) + Congress tabs + instant filing alerts
  // India side of those tabs: NSE bulk/block deals + insider trades. Opt-in
  // (INDIA_SMART_MONEY=1): the NSE routes are unofficial and their terms are unchecked.
  INDIA_SMART_MONEY: process.env.INDIA_SMART_MONEY === '1',
  // News matching for the Indian listed names nobody holds (the Nifty 500 names outside the
  // curated universe). Nothing more is fetched: their stories already arrive from the Indian
  // outlets, and with this on the pipeline tags them. Off unless INDIA_LISTED_NEWS=1.
  INDIA_LISTED_NEWS: process.env.INDIA_LISTED_NEWS === '1',
  // IPO Watch: the calendar of Indian public issues, its own tab. Opt-in (IPO_WATCH=1) while
  // the section is being built.
  IPO_WATCH: process.env.IPO_WATCH === '1',
  // News retention: a daily job that archives and then REMOVES old stories (RETENTION below).
  // Off unless RETENTION=1. `node scripts/retention.js` shows what a run would remove without it.
  RETENTION: process.env.RETENTION === '1',
  // Claude writes the daily brief, Ask answers and the Pro alert narrative. Off unless
  // CLAUDE_REPORTS=1 — a key alone never starts spending.
  CLAUDE_REPORTS: process.env.CLAUDE_REPORTS === '1',
  // v2 feature set: Strategy Builder / Your Strategies / Backtest / Paper Trade + the MCP
  // server, public REST API (/v1), API keys and /docs. Off = v1 (portfolio → AI Workspace).
  STRATEGIES: process.env.FEATURES_STRATEGIES === '1',
  NEWS_EMBEDDINGS: process.env.NEWS_EMBEDDINGS === '1', // embed articles for Ask's news search (needs HF_API_TOKEN + pgvector)
  // Company filings (SEC 8-K) for held US stocks, fetched lazily by the smart-money poller.
  // On by default; DISCLOSURES=0 turns the fetching off (stored filings stay searchable).
  DISCLOSURES: process.env.DISCLOSURES !== '0',
  // Ask's local-model tier (Claude → Ollama → deterministic). Opt-in: it loads a model into
  // memory on the machine running Ollama and answers take seconds, so it is for demos and
  // offline use, not the default.
  ASK_OLLAMA: process.env.ASK_OLLAMA === '1',
  BILLING: false,
};

// ─── FinBERT (services/finbertClassifier.js) ─────────────────
// The finance-trained model that replaces the word list when FEATURES.FINBERT_CLASSIFY is on.
const FINBERT = {
  // local = run the model in this process (no token, no cost, a few hundred MB of memory);
  // hosted = Hugging Face's Inference API (HF_API_TOKEN; a tiny free allowance).
  MODE: process.env.FINBERT_MODE === 'hosted' ? 'hosted' : 'local',
  // The ONNX build of ProsusAI/finbert. FINBERT_LOCAL_MODEL swaps in another model of the same
  // kind (a Hugging Face id, or a folder on disk) — for trials; the labels must be the same three.
  LOCAL_MODEL: process.env.FINBERT_LOCAL_MODEL || 'Xenova/finbert',
  LOCAL_DTYPE: 'q8',               // 8-bit weights: ~110 MB on disk, downloaded on first use
  HOSTED_MODEL: 'ProsusAI/finbert',
  // Optional: a FinBERT fine-tuned to read a text FOR ONE COMPANY (training/
  // train_target_sentiment.py). FINBERT_TARGET_MODEL is its folder; when set and present,
  // every company named in a story is read by it instead of by FinBERT on fragments.
  TARGET_MODEL: process.env.FINBERT_TARGET_MODEL || '',
  TARGET_SEP: ' | ',               // "<company as the text names it> | <text>" — as in training
  BATCH: 16,                       // texts per pass through the local model
  MAX_CHARS: 1500,                 // the model reads at most 512 tokens
  RETRY_MINUTES: 10,               // after a failure, how long the word list stands in
  // Score → label, on the bands the word list's labels fall in (0.5 = neutral).
  BANDS: { POSITIVE: 0.6, NEGATIVE: 0.4 },
};

// ─── Per-company sentiment (services/targetedSentiment.js) ───
// A story naming several companies is read once per company: FinBERT on the sentences and
// clauses that name it, and a language model for a clause that names two or more.
const TARGETED = {
  // Words where a sentence turns ("…weighed on markets, while Nike advanced"): a unit ends here.
  CLAUSE_BREAKS: ['while', 'whereas', 'but', 'although', 'though', 'even as'],
  LLM: {
    // Which companies the model is asked about, per provider (COMPANY_SENTIMENT_SCOPE overrides):
    //   shared — only those in a clause with another company (the fewest calls)
    //   multi  — every company of a story naming two or more
    //   all    — every company of every story FinBERT read
    // The local model is free, so it reads everything and its answer is weighed against
    // FinBERT's (AGREE below). Paid calls stay on the clauses FinBERT cannot split.
    SCOPE: { claude: 'shared', ollama: 'all' },
    SCOPE_OVERRIDE: ['shared', 'multi', 'all'].includes(process.env.COMPANY_SENTIMENT_SCOPE) ? process.env.COMPANY_SENTIMENT_SCOPE : null,
    // Whether a "not about" answer removes the company's tag. A wrong removal hides the story
    // from the company altogether, and the local model's answer is right about two times in
    // three — so its answer is stored as a neutral reading at the lowest confidence instead.
    REMOVE_NOT_ABOUT: { claude: true, ollama: false },
    MODEL: 'claude-haiku-4-5',   // same model as the brief and alert narrative
    // The local model for COMPANY_SENTIMENT_LLM=ollama. Not OLLAMA_MODEL: that one writes
    // prose for other features and defaults to a 3B model.
    OLLAMA_MODEL: process.env.COMPANY_SENTIMENT_OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_0',
    OLLAMA_TIMEOUT_MS: 120000,   // the first call also loads the model into memory
    MAX_OUTPUT_TOKENS: 300,      // one short JSON object
    MAX_TEXT_CHARS: 600,         // clamp the untrusted headline/summary before prompting
    MAX_CALLS_PER_DAY: 300,      // paid calls only: one per hard story; REPORTS.GLOBAL_DAILY_USD_CEILING also applies
    // A label → a score on FinBERT's scale (0.5 = neutral), so the history stays on one scale.
    SCORE: { positive: 0.9, neutral: 0.5, negative: 0.1 },
    CONFIDENCE: 0.8,             // a model reading with no FinBERT reading to weigh it against
  },
  // Two readers, one reading. FinBERT is decisive and sometimes wrong; the language model is
  // cautious. Where both read a company, how far they agree is the reading's confidence —
  // and confidence is its weight in the ticker's score (sentimentScoring.acuteWeight).
  //   BOTH  — same label from both
  //   ONE   — one says neutral, the other takes a side
  //   CLASH — positive against negative: stored as neutral
  // In a clause naming several companies FinBERT cannot tell them apart, so the model's
  // label is the reading there; everywhere else FinBERT's is.
  AGREE: { BOTH: 0.9, ONE: 0.5, CLASH: 0.3 },
};

// ─── Sentiment v2 windows (Phase 2a) ─────────────────────────
// Decay half-life + window lengths for the windowed scoring engine. News impact is
// mostly realized in 1-3 days and reverts within ~2 weeks, so the headline (acute)
// score decays fast while a 90-day baseline gives the z-score its "vs own normal".
const SENTIMENT = {
  HALF_LIFE_HOURS: 7 * 24,    // exponential time-decay half-life (~7 days)
  ACUTE_WINDOW_HOURS: 72,     // headline score looks at the last 24-72h
  MOMENTUM_RECENT_DAYS: 7,    // recent leg of the momentum trend
  MOMENTUM_PRIOR_DAYS: 14,    // prior leg (7-14d ago)
  BASELINE_DAYS: 90,          // z-score baseline length
  MIN_BASELINE_POINTS: 5,     // need this many points before a z-score is meaningful
};

// ─── Source credibility weights (Phase 2c) ───────────────────
// A Reuters headline outweighs a Reddit comment. Matched case-insensitively as a
// substring of the article's source; falls back to the platform default.
const SOURCE_WEIGHTS = {
  bySource: {
    reuters: 1.0, bloomberg: 1.0, 'wall street journal': 1.0, wsj: 1.0,
    'financial times': 1.0, ft: 1.0, cnbc: 0.9, 'associated press': 1.0, ap: 1.0,
    'economic times': 0.8, mint: 0.8, livemint: 0.8, moneycontrol: 0.8,
    'business standard': 0.8, marketwatch: 0.8, 'the verge': 0.7, techcrunch: 0.7,
  },
  byPlatform: { news: 0.7, macro: 0.8, reddit: 0.35, x: 0.3 },
};

// ─── Event typing (Engine Phase E2) ──────────────────────────
// Each event gets a TYPE (earnings, legal, M&A, …) and a SEVERITY weight = how much
// that kind of event tends to matter. Severity feeds the 6-factor impact score.
const EVENT_TYPES = {
  SEVERITY: {
    ma: 1.0,            // M&A / takeover — the biggest mover
    legal: 0.9,         // lawsuit / fraud / regulator / fine
    disruption: 0.9,    // recall / breach / shutdown / strike
    earnings: 0.8,      // results, profit, revenue
    guidance: 0.8,      // outlook / forecast / warning
    executive: 0.7,     // CEO/CFO change — key-person risk
    insider: 0.6,       // promoter / block / pledge
    macro: 0.6,         // broad market / world
    product: 0.5,       // launches / unveils
    rating: 0.4,        // analyst upgrade/downgrade — opinion, not fact
    other: 0.3,
    unknown: 0.3,
  },
};

// ─── Portfolio Impact Scoring (Phase 2e + E2 6-factor) ───────
// impact(holding) = exposure × relevance × severity × novelty × confidence × recency
//   exposure   : the holding's % weight (0..1)
//   relevance  : 1.0 direct hold · SECTOR_RELEVANCE sector-only · MACRO_BROAD_FACTOR macro
//   severity   : event-type weight × sentiment magnitude (|score-0.5|×2)  (0..1 core)
//   novelty    : z-surprise vs the asset's 90-day baseline  (mult ~0.8..1.2; null→1.0)
//   confidence : classifier/source confidence              (mult CONFIDENCE_FLOOR..1)
//   recency    : time decay on the event's last_seen        (mult RECENCY_FLOOR..1)
const IMPACT = {
  EVENT_WINDOW_HOURS: 72,     // only recent events compete for "today's most important"
  // Relevance of a market-wide story to a holding it does not name. A market story moves
  // many holdings a little, so it is scored well below a story about the holding itself,
  // always at "macro" severity whatever its own type, and only against holdings listed in
  // the market it is about. At 0.2 a clear results story on a holding outranks an equally
  // strong market story once that holding is above ~15% of the exposure in that market;
  // at the old 0.5 every market story counted as "50% of your exposure" and led the feed.
  MACRO_BROAD_FACTOR: 0.2,
  // How big a market story is, read from how much is being written about it: related
  // market headlines are grouped into one story (materiality.groupStories) and the story's
  // coverage (its headlines × their sources) multiplies the relevance above:
  //   1 + GAIN × log2(coverage), capped at MAX  →  1 headline ×1, 4 ×2, 8 ×2.5, 16+ ×3.
  // So a one-off market headline stays low, and a day when the whole market is the story
  // climbs into the top handful.
  MACRO_COVERAGE_GAIN: 0.5,
  MACRO_COVERAGE_MAX: 3,
  // What kind of writing a story is (eventTyping.classifyStance). Only a reported event
  // counts in full; someone's view of it counts for less, and a list that names a holding
  // in passing for less again. At 0.6 a commentary piece cannot clear the report's card bar.
  STANCE_FACTOR: { event: 1, commentary: 0.6, roundup: 0.4 },
  // How an impact score is worded for a reader. High is the level at which a story about a
  // holding would raise an alert (MATERIALITY.HOLDING_THRESHOLD); below Medium it is background.
  LEVELS: { HIGH: 0.10, MEDIUM: 0.04 },
  SECTOR_RELEVANCE: 0.4,      // relevance of a sector event to a holding in that sector
  Z_BOOST: 0.25,              // (materiality alerts) surprising z amplifies
  NOVELTY_BASE: 0.8,          // novelty mult = BASE + GAIN×min(|z|,3)/3 ; null z → 1.0
  NOVELTY_GAIN: 0.4,
  CONFIDENCE_FLOOR: 0.5,      // confidence mult = FLOOR + (1-FLOOR)×confidence
  RECENCY_FLOOR: 0.5,         // recency mult = FLOOR + (1-FLOOR)×decay(age)
  TOP_N_PER_USER: 25,         // persist this many ranked events per user
};

// ─── News relevance + de-spam (Phase 3.5) ────────────────────
// Every ingested article is graded into one of three buckets the user actually
// cares about — their HOLDINGS, broad MARKET-moving news, and major WORLD affairs —
// or dropped as noise. Importance = keyword-tier weight × source credibility; a
// market/world story must clear RELEVANT_THRESHOLD to show (a holding match always
// shows). Near-duplicate stories about one event share a cluster_key so the feed
// shows one card (with a source count) instead of the same story four times.
const NEWS_RELEVANCE = {
  // "Balanced": keep every holding match; keep market/world only above this score.
  // med-tier keyword (0.6) × a credible source (≥0.7) clears it; weak/generic does not.
  RELEVANT_THRESHOLD: 0.42,
  HOLDING_BASE: 0.8,          // a direct holding match starts here (always relevant)
  TIER_WEIGHT: { high: 1.0, med: 0.6 },
  CLUSTER_WINDOW_HOURS: 36,   // duplicates of one event fall within this window
  CLUSTER_TOKENS: 8,          // # of salient title tokens that define an event
  CLUSTER_SIM: 0.6,           // stemmed-headline Jaccard ≥ this ⇒ same event (merged)
  // Broad market-moving topics → the "Markets" bucket (apply to everyone).
  MARKET_KEYWORDS: {
    high: ['rate decision', 'rate hike', 'rate cut', 'recession', 'market crash', 'crash',
           'circuit breaker', 'sovereign default', 'downgrade', 'credit rating', 'bear market',
           'sell-off', 'selloff', 'bond yield', 'inflation', 'cpi print', 'fomc', 'federal reserve',
           'interest rate', 'rbi policy', 'ecb', 'liquidity crisis'],
    // NB: 'ipo' is deliberately excluded — individual small-cap IPO subscription
    // updates aren't market-wide news; they were the bulk of the leaked noise.
    med: ['gdp', 'unemployment', 'jobs report', 'earnings season', 'oil price', 'crude oil',
          'dollar index', 'rupee', 'sensex', 'nifty', 'nasdaq', 's&p 500', 'dow jones', 'treasury',
          'stimulus', 'tariff', 'trade deal', 'union budget', 'monetary policy'],
  },
  // Major world affairs that move markets → the "World" bucket (apply to everyone).
  WORLD_KEYWORDS: {
    high: ['war', 'invasion', 'airstrike', 'missile strike', 'ceasefire', 'sanctions', 'coup',
           'terror attack', 'pandemic', 'nuclear', 'oil embargo', 'election result',
           'government shutdown', 'martial law', 'state of emergency'],
    med: ['election', 'geopolitical', 'summit', 'opec', 'border conflict', 'trade war', 'treaty',
          'earthquake', 'hurricane', 'major flood', 'energy crisis'],
  },
  // A roundup lists movers; it is about the market, not about any company it names. The
  // story's one reading (FinBERT reads the whole text) is the market's tone, so it must not
  // be stored against each name: "Market wrap: Kotak Bank, Titan… top gainers and losers"
  // read negative for Kotak because the market fell. See newsRelevance.subjectTickers.
  ROUNDUP_PHRASES: ['market wrap', 'gainers and losers', 'gainers & losers', 'gainers, losers',
                    'top gainers', 'top losers', 'stocks to watch', 'stocks in focus',
                    'stocks in news', 'stocks in the news', 'buzzing stocks'],
  // "…shares in focus" is a roundup only when the headline lists several companies; with one
  // it is ordinary single-company news ("Kotak Bank shares in focus after Q2 results").
  ROUNDUP_PHRASES_MULTI: ['shares in focus', 'in focus today', 'in focus on'],
  // Headlines about a broad market. A company such a story names only in its summary is a
  // passing mention ("Wall Street slips… while Nike advanced"). Sector indices (Nifty IT,
  // Nifty Bank) are left out on purpose: their stories are about the companies in them.
  BROAD_MARKET_TERMS: ['sensex', 'wall street', 'dow jones', 'nasdaq', 's&p 500', 's p 500',
                       'us stocks', 'asian shares', 'asian stocks', 'asian markets',
                       'european shares', 'european stocks', 'stock market', 'stock markets',
                       'dalal street', 'd-street'],
  NIFTY_SECTORS: ['it', 'bank', 'auto', 'pharma', 'fmcg', 'metal', 'realty', 'psu', 'energy',
                  'media', 'financial', 'midcap', 'smallcap', 'private', 'healthcare'],
};

// ─── Alert budgets + outcomes (Engine Phase E3) ──────────────
// Anti-fatigue: every material event is still recorded, but only the top
// MAX_REALTIME_PER_DAY (by priority) push in real time; the rest are 'digest'.
// A ticker can't push more than once per PER_TICKER_COOLDOWN_HOURS. Quiet hours
// hold pushes to digest (off until we capture each user's timezone).
const ALERT_BUDGET = {
  MAX_REALTIME_PER_DAY: 5,      // every alert type draws on this, smart money included
  MAX_BROAD_REALTIME_PER_DAY: 2, // of which market/world stories — holdings news keeps the rest
  PER_TICKER_COOLDOWN_HOURS: 12,
  QUIET_HOURS_ENABLED: false,   // needs per-user TZ; global window until then
  QUIET_START: 22,              // local hour pushes pause (inclusive)
  QUIET_END: 7,                 // local hour pushes resume
  QUIET_TZ_OFFSET: 0,           // hours from UTC for the quiet window
};

// Outcome labelling: a |price move| ≥ this over 1–3 days = "materially moved".
const OUTCOMES = {
  MATERIAL_MOVE_PCT: 0.03,
};

// ─── Durable events (Engine Phase E1b) ───────────────────────
// An event lives this long: duplicates within the window join it; after it, the event
// (and its impacts) is pruned. Matches the impact/alert windows below.
const EVENTS = {
  WINDOW_DAYS: 7,
};

// ─── Materiality alerting (Phase 3.5, pulled forward from Phase 7) ─────
// Replaces the crude per-article threshold/keyword engine. An alert fires on a
// real EVENT (cluster), once per user, scored by how much it actually matters:
//   holdings: exposure_weight × magnitude × confidence × z_surprise × volume × source
//   market/world: importance × volume (fires to everyone, gated harder)
// This is what kills both kinds of spam — duplicate articles and one-more-bad-article
// on an already-negative name (no z-surprise) no longer page anyone.
const MATERIALITY = {
  // Per-user materiality needed to fire a holding alert. Calibrated on real portfolios:
  // 0.35 needed a ~60% position, so holdings alerts never fired (5 in three months).
  // 0.10 ≈ a 10% position hit by strong, confident, earnings-grade news; a 5% position
  // only clears it when the news is also a surprise for that stock and widely covered.
  HOLDING_THRESHOLD: 0.10,
  TYPE_BASE: 0.5,             // event-type factor = TYPE_BASE + severity (other 0.8 … M&A 1.5)
  REALTIME_MIN_CONFIDENCE: 0.4, // a holding alert below this still records, but never pushes/emails
  BROAD_THRESHOLD: 0.6,       // story importance × coverage needed for a market/world alert
  // A market/world STORY (related headlines grouped) pushes in real time only when it is
  // confirmed and concerns the user; otherwise it is recorded once, as digest.
  BROAD_REALTIME_MIN_COVERAGE: 3,   // reports across the story's headlines
  BROAD_MIN_REGION_EXPOSURE: 10,    // % of the user's portfolio in the story's market
  STORY_SHARED_TOKENS: 2,           // headlines sharing this many key words (same market) = one story
  Z_BOOST: 0.25,             // surprise vs the asset's 90-day baseline amplifies materiality
  VOLUME_BOOST: 0.15,        // each extra source covering the event adds this (log-scaled)
  MIN_CONFIDENCE: 0.2,       // ignore near-zero-confidence classifications
  LOOKBACK_HOURS: 24,        // only score events from the last day for alerting
};

// ─── New-holding onboarding (Engine Phase E4) ────────────────
// On add we (1) compute the holding's impact silently over events already stored
// (no alert blast for history), (2) hand back a short, deterministic company brief
// assembled from engine data — company reference + recent events + current sentiment —
// shaped so E5 can later feed it to Claude for prose, and (3) stamp a monitoring-since
// watermark so only post-add events can alert. No Claude call here (that's E5).
const ONBOARDING = {
  BRIEF_EVENTS: 5,        // recent events to surface in the brief
  BRIEF_EVENT_DAYS: 7,    // how far back the brief's "recent context" looks
  BRIEF_SMART_MONEY: 3,   // institutions / congress rows to include per side
};

// ─── The analyst voice — daily brief (Engine Phase E5) ───────
// Claude (Haiku by default) writes a daily brief grounded ENTIRELY in the user's own
// holdings, led by "what changed since yesterday" + the single most important event.
// The engine builds the grounding packet (grounding.js) and computes the diff; Claude
// only writes the prose. Non-negotiable cost guardrails (the user is firm about not
// letting the Claude key run a bill): server-scheduled only (never an on-demand
// loopable button), per-user daily quota checked BEFORE any call, hard token caps per
// call, a global daily spend kill-switch, and every call logged with tokens + cost.
// When CLAUDE_REPORTS is off or no ANTHROPIC_API_KEY is set, generation degrades to the
// local Ollama writer, then to a deterministic template — both free, so a brief still
// ships every day; Claude is the upgrade.
const REPORTS = {
  MODEL: 'claude-haiku-4-5',     // cheapest-viable; Sonnet/Opus reserved for major events later
  // Server-scheduled, never user-triggered on demand. The job runs every few minutes and
  // writes a user's brief once their own clock passes LOCAL_TIME (services/userTime.js).
  CRON: '*/15 * * * *',
  LOCAL_TIME: { HOUR: 5, MINUTE: 30 },
  LOCAL_WINDOW_MINUTES: 180,     // a late start still writes it; the morning email writes it if this never ran
  MAX_OUTPUT_TOKENS: 1800,       // hard per-call output cap
  TOP_HOLDINGS: 12,              // trim the packet to the top-N holdings by exposure
  TOP_EVENTS: 6,                 // and the top-N impact events
  MAX_NEWS_CHARS: 280,           // clamp each untrusted headline/summary before prompting
  // Claude-written briefs a day are set per plan (TIERS[tier].claudeReportsPerDay: Free 0,
  // Plus 1, Pro 2) and checked before any call — see reports.briefQuota.
  GLOBAL_DAILY_USD_CEILING: 5,   // global kill-switch: stop calling Claude past this day's spend
  // Haiku 4.5 pricing ($/1M tokens) for the cost estimate logged per call.
  PRICE_PER_MTOK: { input: 1.0, output: 5.0 },
  // The written layer on a report's headline cards (services/cardWriter.js): one call
  // rewrites all of a report's cards; a rewrite that fails its check keeps the template.
  CARDS: {
    TIERS: ['plus', 'pro'],
    MAX_OUTPUT_TOKENS: 1800,     // up to six cards × three short lines, as JSON
    PER_USER_DAILY_QUOTA: 2,     // one report a day, plus one retry if the send fails
    SUMMARIES_PER_CARD: 2,       // article summaries shown to the model for each card
    MAX_SUMMARY_CHARS: 600,      // each one clamped to this (untrusted feed text)
  },
};

// ─── Ask it anything — portfolio Q&A (Engine Phase E6) ───────
// Natural-language questions answered by Claude (Haiku), grounded STRICTLY on the engine's
// own data for that user — no outside knowledge, every claim cites a number. Q&A is
// inherently on-demand (the exact "loopable button" risk), so it carries a hard per-user
// daily question cap checked BEFORE any call, shares REPORTS' global $/day kill-switch and
// per-call cost logging (claude_calls.kind='qa'), and clamps the question + caps output.
// Same FEATURES.CLAUDE_REPORTS flag gates it; with no key / flag off / over cap it degrades
// to a deterministic grounded data summary (no NL reasoning, but it cites the numbers).
const QA = {
  MODEL: 'claude-haiku-4-5',
  // A model that thinks (Claude Haiku 5.5 and later) spends this limit on its thinking too:
  // at 1,000 two of six answers were cut off before or in the middle of the text.
  MAX_OUTPUT_TOKENS: 3000,
  PER_USER_DAILY_QUESTIONS: 10,  // fallback only — the real cap is TIERS[tier].qaPerDay (Plus 10 / Pro 30)
  MAX_QUESTION_CHARS: 500,       // clamp the (untrusted) question before prompting
  TOP_EVENTS: 10,                // extended grounding: fuller impact feed than the daily brief
  MAX_HOLDINGS: 30,              // all holdings up to this cap (not just top-N)
  // Agent (E6 v2): Claude pulls data through tools instead of one stuffed context.
  MAX_TOOL_ROUNDS: 4,            // tool-call rounds per question; then it must answer
  MAX_INPUT_TOKENS_PER_QUESTION: 25000, // stop calling tools past this summed input (worst question ≈ $0.04)
  MAX_TOOL_RESULT_CHARS: 4000,   // clamp each tool result before it re-enters the prompt
  HISTORY_TURNS: 3,              // follow-ups: last N question/answer pairs sent back
  MAX_HISTORY_CHARS: 1200,       // clamp each (client-supplied, untrusted) history message
  // Rolling digest of turns OLDER than those: built in code (no model call) from the earlier
  // questions and the tickers discussed, so a long thread keeps its thread without growing.
  DIGEST_LOOKBACK_MESSAGES: 16,  // older messages read to build it
  DIGEST_QUESTIONS: 6,           // most recent earlier questions kept
  DIGEST_QUESTION_CHARS: 100,
  DIGEST_MAX_CHARS: 700,         // ≈150 tokens
  // Local-model tier (FEATURES.ASK_OLLAMA): one prompt holding the user's data packet.
  OLLAMA_CONTEXT_CHARS: 6000,
  OLLAMA_MAX_TOKENS: 350,
  OLLAMA_TIMEOUT_MS: 25000,
  // Strategy tools (v2 only, services/strategyTools.js) — read-only, bounded engine use.
  STRATEGY_COMPARE_MAX: 10,          // paper deployments replayed for "which did best?"
  STRATEGY_ENGINE_CONCURRENCY: 3,    // replays in flight at once (the engine is one process)
  STRATEGY_ENGINE_TIMEOUT_MS: 20000, // per engine call — a chat answer can't wait for a 2-minute run
  STRATEGY_CACHE_MS: 5 * 60 * 1000,  // replay results reused within a conversation
  STRATEGY_CATALOG_CACHE_MS: 10 * 60 * 1000,
  STRATEGY_LIST_DEPLOYMENTS: 8,      // with 20 saved strategies the list must still fit MAX_TOOL_RESULT_CHARS
  STRATEGY_RULES_INLINE: 6,          // spell out rules only when the saved list is this short
  STRATEGY_EVIDENCE_SYMBOLS: 2,      // held symbols that get SenIQ evidence in explain_strategy_signal
  STRATEGY_PRESETS_MAX: 15,
  STRATEGY_VALIDATE_TIMEOUT_MS: 5000, // engine check of a drafted spec; on timeout the app's own check stands
  // A stock the user does not hold (services/stockSnapshot.js): price and sentiment only.
  SNAPSHOT_MAX_NAMES: 3,             // names snapshotted in one code-written answer; the rest are named as not shown
  SNAPSHOT_MATCHES: 5,               // companies offered back when a typed name fits several
  // What the other pages show, read by Ask (services/pageTools.js). Each result must fit MAX_TOOL_RESULT_CHARS.
  PAGE_MATCHES: 5,                   // funds, politicians or investors offered back when a name fits several
  PAGE_ROWS: 10,                     // trades or deals in one result
  PAGE_FUND_TOP: 10,                 // a fund's largest positions
  PAGE_FUND_CHANGES: 3,              // its largest new, added and reduced positions
  PAGE_ALERTS: 10,                   // newest alerts, asked for on their own
  PAGE_ALERTS_WITH_BRIEF: 6,         // and when the brief shares the result
  PAGE_ALERT_CHARS: 140,             // one alert's text
  PAGE_BRIEF_CHARS: 1100,            // the daily brief's text
  // Price history (services/priceHistory.js): daily bars fetched when asked, never stored.
  PRICE_HISTORY_PERIODS: [['1_week', 7], ['1_month', 30], ['3_months', 91], ['6_months', 182], ['1_year', 365]],
  PRICE_HISTORY_SLACK_DAYS: 5,       // a year of bars can start a weekend short of a year back
  PRICE_HISTORY_RECENT: 10,          // latest daily closes in the result
  PRICE_HISTORY_VOLUME_SESSIONS: 20, // the recent average volume, about a month of sessions
  PRICE_HISTORY_TTL_MS: 15 * 60 * 1000,
  PRICE_HISTORY_TIMEOUT_MS: 8000,
  // IPO Watch tools (services/ipoTools.js, only with FEATURES.IPO_WATCH) — the calendar, read-only.
  IPO_MAX_ISSUES: 10,                // issue cards in one get_ipo_calendar result; fewer when they would not fit MAX_TOOL_RESULT_CHARS
  IPO_RANK_TOP: 5,                   // names in an ordering (most subscribed, highest premium)
  IPO_DETAIL_STORIES: 5,             // latest stories in get_ipo_detail
  IPO_DETAIL_DAYS: 7,                // days of news tone, and of grey market premium readings, in get_ipo_detail
  // Saved threads: the server stores conversations and supplies follow-up history itself.
  THREAD_RETENTION_DAYS: 30,     // threads untouched this long are purged by the daily job
  THREAD_PURGE_CRON: '15 4 * * *',
  MAX_THREADS_LISTED: 20,
  THREAD_TITLE_CHARS: 80,
  NEWS_DAYS_DEFAULT: 7,
  NEWS_DAYS_MAX: 90,             // matches the sentiment baseline window
};

// ─── News search (RAG over ingested headlines + summaries) ───
// Embeddings via HF Inference (same HF_API_TOKEN as FinBERT), stored in pgvector.
// Without pgvector or a token, search degrades to keyword matching — never a hard fail.
const NEWS_SEARCH = {
  EMBED_MODEL: 'sentence-transformers/all-MiniLM-L6-v2',
  DIM: 384,                      // must match EMBED_MODEL's output size
  WINDOW_DAYS: 90,               // only recent relevant articles are embedded/searched
  EMBED_BATCH: 32,               // texts per HF request
  MAX_EMBED_PER_RUN: 200,        // per pipeline run, bounds HF calls
  MAX_TEXT_CHARS: 600,           // title + summary clamp before embedding
  TOP_K: 6,
  MIN_SIMILARITY: 0.3,           // below this cosine a match is noise, not relevance (MiniLM scale)
  // Hybrid, story-level search: full-text and vector each rank up to CANDIDATES articles,
  // the two rankings are fused per STORY (reciprocal rank fusion), then re-ranked for this user.
  CANDIDATES: 40,
  RRF_K: 60,                     // standard RRF constant; larger = flatter rank weighting
  // score = match × strength × (1 + IMPACT·impact + IMPORTANCE·importance) × recency.
  // The boosts reorder stories that matched the query; they never add ones that didn't.
  RANK: {
    STRENGTH: 0.5,               // share of the score tied to how fully the story matched (terms hit / cosine)
    IMPACT: 0.6,                 // this user's portfolio impact for the story (0–1)
    IMPORTANCE: 0.3,             // the story's own importance (0–1)
    RECENCY: 0.3,                // share of the score that decays with age
    RECENCY_HALF_LIFE_DAYS: 14,
  },
  CARD_TITLE_CHARS: 120,
  CARD_SUMMARY_CHARS: 140,       // story card snippet; six cards must fit QA.MAX_TOOL_RESULT_CHARS
  DETAIL_ARTICLES: 6,            // articles returned by get_story_detail
  DETAIL_SUMMARY_CHARS: 300,
};

// ─── Instant alert email + Pro narrative (Phase 9) ───────────
// The materiality engine (Phase 3.5) already decides WHEN an alert fires and dedupes it
// per (user, event). Phase 9 adds DELIVERY: realtime alerts are emailed to Plus/Pro via
// the existing Resend sender (Free = in-app digest only, no email). For Pro, a short
// Claude narrative is attached, reusing the same guardrails as the daily brief/Q&A —
// counted separately as claude_calls.kind='alert_narrative' so it can't cannibalise the
// brief/Q&A budgets, but sharing the global $/day kill-switch and cost logging. Claude →
// Ollama → deterministic template, same fallback order as the rest of the analyst voice.
const ALERT_EMAIL = {
  SUBJECT_PREFIX: '[SenIQ]',    // "[SenIQ] Portfolio Alert: <headline>"
  DASHBOARD_PATH: '/app',       // link back into the app (APP_URL + this)
  REALTIME_ONLY: true,          // only 'realtime' alerts email; 'digest' stays in-app
};
const ALERT_NARRATIVE = {
  MODEL: 'claude-haiku-4-5',    // cheapest-viable; matches the brief/Q&A default
  MAX_OUTPUT_TOKENS: 400,       // 150–250 words ≈ ~350 tokens; hard per-call cap
  PER_USER_DAILY_QUOTA: 5,      // Pro narratives/user/day — aligns with ALERT_BUDGET realtime cap
  MIN_WORDS: 150,
  MAX_WORDS: 250,
};

// ─── Model access for the analyst voice (services/llmClient.js) ──
// Claude is reached either directly (ANTHROPIC_API_KEY) or through an OpenAI-compatible
// router (AIROUTER_API_KEY — AIRouter by default, credits topped up in INR). The router
// names models "provider/model"; its Haiku 4.5 is priced the same as REPORTS.PRICE_PER_MTOK.
const LLM = {
  ROUTER: {
    API_KEY: process.env.AIROUTER_API_KEY || '',
    BASE_URL: (process.env.AIROUTER_BASE_URL || 'https://api.airouter.in/v1').replace(/\/$/, ''),
    MODEL: process.env.AIROUTER_MODEL || 'anthropic/claude-haiku-4.5',
    TIMEOUT_MS: 60000,
  },
};

// ─── Report emails (scheduled summaries) ─────────────────────
// Anything that can't wait is an alert; reports are the calm, scheduled read.
//   Free       → a weekly summary, Sunday evening.
//   Plus / Pro → the daily brief on weekday mornings.
//   Pro        → also an end-of-day report every evening (skipped on a day with no trading
//                and no new news about the user's holdings).
// All times are on the USER's clock (users.time_zone; until that is known, the zone of their
// market — users.home_market, or worked out from what they hold). The job runs every few
// minutes and sends to whoever is inside their send window and has not had that day's
// report (report_sends), so a restart or a late start still delivers once.
const REPORT_EMAIL = {
  CRON: '*/15 * * * *',
  DAILY: { HOUR: 8, MINUTE: 30, WEEKDAYS: [1, 2, 3, 4, 5] },  // local time, Mon–Fri
  WEEKLY: { HOUR: 18, MINUTE: 0, WEEKDAY: 0 },                // local time, Sunday
  EVENING: { HOUR: 20, MINUTE: 0, TIERS: ['pro'] },           // local time, every day
  SEND_WINDOW_MINUTES: 180,     // how long after the send time a late report still goes out
  MARKETS: {
    IN: { label: 'India', timeZone: 'Asia/Kolkata' },
    US: { label: 'United States', timeZone: 'America/New_York' },
  },
  DEFAULT_MARKET: 'US',
  IN_EXCHANGES: ['NSE', 'BSE'],
  MAX_EVENTS: 4,                // events listed in a report
  // Which headlines earn a card (reportInsights.pickCards). A story about a holding or its
  // sector passes on STRENGTH = its impact per unit of exposure it touches, i.e. event-type
  // severity × how one-sided the coverage is × novelty × confidence × recency (0 to ~1.2).
  // Strength ignores position size, so the bar means the same for a 5-stock and a 30-stock
  // portfolio. At 0.40 roughly the top tenth of stories about a holding pass (2 to 4 on a
  // normal day): a results, deal, legal or outlook story with a clear reading does; an
  // analyst rating rarely does; a "stocks to watch" round-up cannot.
  CARDS: {
    BAR: 0.40,
    MIN_EXPOSURE_PCT: 3,        // the story must touch at least this much of the portfolio
    MAX: 6,                     // hard cap, however busy the day
    MIN: 2,                     // a quiet day still shows its best two, as background
  },
  SUBJECT_PREFIX: '[SenIQ]',
};

// ─── Company filings (primary sources) ───────────────────────
// SEC 8-Ks for held US-listed stocks. Lazy and bounded: only tickers someone holds, a few per
// poll, a few filings each, and each request spaced by SMART_MONEY.SEC_RATE_DELAY_MS.
const DISCLOSURES = {
  FORMS: ['8-K', '8-K/A'],
  LOOKBACK_DAYS: 180,            // how far back to go the first time a ticker is seen
  MAX_TICKERS_PER_RUN: 4,        // tickers checked per poll
  MAX_FILINGS_PER_TICKER: 5,     // newest filings fetched per ticker per poll
  RECHECK_HOURS: 12,             // a ticker is not asked about again sooner than this
  UNLISTED_RECHECK_DAYS: 30,     // a ticker the SEC does not list is retried this rarely
  MAIN_TEXT_CHARS: 2500,         // excerpt taken from the filing's main document
  EXHIBIT_TEXT_CHARS: 3500,      // excerpt taken from its press release (EX-99)
  MAX_DOC_BYTES: 1_500_000,      // larger documents are skipped, not truncated mid-parse
  // Exchanges whose listings file with the SEC. A holding with no exchange is treated as US
  // unless the curated universe says otherwise.
  US_EXCHANGES: ['US', 'NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA'],
  CARD_EXCERPT_CHARS: 280,       // per filing in a listing
  DETAIL_EXCERPT_CHARS: 3000,    // when one filing is opened
  LIST_LIMIT: 6,
};

// ─── Ingestion sources (Phase 2b) ────────────────────────────
const INGEST = {
  GDELT_MAX_RECORDS: 30,
  GDELT_TIMESPAN: '1d',
  // Company queries per run for held Indian names. GDELT rate-limits hard (429), so a large
  // set of holdings is covered a slice at a time, rotating each run.
  GDELT_INDIA_MAX_PER_RUN: 12,
  // Macro/global queries mapped to the __MARKET__ tag (war/budget/rates).
  GDELT_MACRO_QUERIES: [
    'federal reserve interest rate', 'inflation economy', 'stock market',
    'RBI india budget', 'recession',
  ],
  RSS_FEEDS: [
    'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    'https://www.livemint.com/rss/markets',
    'https://www.moneycontrol.com/rss/marketreports.xml',
    'https://www.business-standard.com/rss/markets-106.rss',
    // Crypto outlets — the only crypto-specific source (Finnhub's crypto category is the
    // first two of these again). All four checked through rss.js 2026-10-09.
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cointelegraph.com/rss',
    'https://decrypt.co/feed',
    'https://www.theblock.co/rss.xml',
  ],
  REDDIT_SUBREDDITS: ['stocks', 'wallstreetbets', 'cryptocurrency'],
  REDDIT_LIMIT: 25,
  MAX_TEXT_CHARS: 2000, // bound untrusted text before it enters scoring/prompts
};

// ─── Smart-money tracking (Phase 3) ──────────────────────────
// Both sources are inherently weeks-stale by law (13F ~45d, Congress up to 45d) — the
// UI surfaces trade/period date vs filing/disclosure date so "immediate" is honest:
// immediate relative to DISCLOSURE, not the trade. SEC EDGAR + the free congress portals
// don't push, so a poller emulates a webhook (every POLL_CRON) and fires on new records.
const SMART_MONEY = {
  POLL_CRON: '*/15 * * * *',     // emulated-webhook poller cadence
  // SEC requires a descriptive User-Agent with a contact on every request.
  SEC_USER_AGENT: process.env.SEC_USER_AGENT || 'SenIQ admin@xynthis.com',
  SEC_RATE_DELAY_MS: 250,        // space SEC requests out (well under their 10 req/s)
  TOP_HOLDINGS: 25,              // top-N holdings surfaced per fund (by value)
  CONGRESS_LOOKBACK_DAYS: 60,    // only ingest recent congress disclosures
  // Free community dataset of congress trades. The classic stock-watcher S3 buckets are
  // currently 403; point this at a working mirror/export to light up LIVE congress data.
  // When unreachable, ingest degrades to the bundled sample (data/congress_sample.json).
  CONGRESS_TRADES_URL: process.env.CONGRESS_TRADES_URL || '',
  WEBHOOK_TIMEOUT_MS: 6000,
  WEBHOOK_MAX_FAILURES: 10,      // auto-disable a webhook after this many consecutive fails
  MAX_WEBHOOKS_PER_USER: 5,
};

// ─── India smart money (NSE bulk/block deals + insider trades) ───
// The Indian side of the Institutions and Congress tabs. Runs only when
// FEATURES.INDIA_SMART_MONEY is on. NSE's routes are public but unofficial, so the poller
// asks once a day after the market closes (never on boot) and gives up quietly when refused.
const INDIA_SMART_MONEY = {
  CRON: '30 19 * * 1-5',         // weekdays 19:30, in TIMEZONE — the deal files are out by then
  TIMEZONE: 'Asia/Kolkata',
  // Sent on every NSE request. Says who we are; override with NSE_USER_AGENT.
  USER_AGENT: process.env.NSE_USER_AGENT || 'Mozilla/5.0 (compatible; SenIQ/1.0; admin@xynthis.com)',
  BULK_DEALS_URL: 'https://nsearchives.nseindia.com/content/equities/bulk.csv',
  BLOCK_DEALS_URL: 'https://nsearchives.nseindia.com/content/equities/block.csv',
  // Insider trades. Since May 2026 NSE publishes them as filings: one whole-market list,
  // each filing pointing to an XBRL file on FILINGS_HOST with the trades inside.
  INSIDER_FILINGS_URL: 'https://www.nseindia.com/api/corporates-pit-gg?index=equities',
  FILINGS_HOST: 'https://nsearchives.nseindia.com/',
  INSIDER_MAX_FILINGS: 60,       // filings read per run, newest first — a backlog fills in over later runs
  // The older per-symbol route. It stops at April 2026 and is kept only to load history
  // by hand (scripts/india_smart_money.js history SYMBOL ...).
  INSIDER_URL: 'https://www.nseindia.com/api/corporates-pit',
  TIMEOUT_MS: 25000,             // the archive host is slow; a first probe timed out at 15s
  REQUEST_DELAY_MS: 1500,        // gap between two NSE requests
  INSIDER_LOOKBACK_DAYS: 365,    // how far back disclosures are kept — large caps can go months without one
  ALERT_MAX_AGE_DAYS: 7,         // an older deal/disclosure fetched late is stored, never alerted
  INSIDER_ALERT_MIN_INR: 1e7,    // ₹1 crore — smaller insider trades are stored but do not alert
  LIST_WINDOW: 500,              // newest rows a list route looks at before filtering
  // What the reports and the brief carry (grounding.smartMoneyContext): deals in the user's
  // Indian holdings, and insider trades that pass the alert rule (promoter, director or key
  // manager; open market; INSIDER_ALERT_MIN_INR or more). Everything else stays on the tabs.
  REPORT: { ROWS: 3, DEAL_DAYS: 7, INSIDER_DAYS: 90 },
};

// ─── News retention (services/retention.js) ──────────────────
// How long a stored story is kept, counted from the later of the day it was published and
// the day it was fetched. Before a story goes it is written to an archive file, and what the
// strategy factors need from it is added to its ticker's day in sentiment_daily.
const RETENTION = {
  // A story the pipeline judged irrelevant, with no sentiment reading and no IPO link: it is
  // kept only so the fetchers do not store it twice. Not below IPO_WATCH.LINK_BACKFILL_DAYS —
  // a newly seen issue is still matched against stories that old.
  UNUSED_DAYS: 30,
  // Every other story. The app reads 90 days (SENTIMENT.BASELINE_DAYS, NEWS_SEARCH.WINDOW_DAYS,
  // QA.NEWS_DAYS_MAX), which is also about as long as a run of news is found to move a share;
  // one more quarter is kept so recent history can be read again by a better sentiment model.
  USED_DAYS: 180,
  CRON: '45 4 * * *',            // daily, after the Ask thread purge; only when FEATURES.RETENTION
  // Where the archive files go (gzip, one JSON story per line). On a host without a lasting
  // disk this must point at storage that survives a deploy.
  ARCHIVE_DIR: process.env.RETENTION_ARCHIVE_DIR || 'data/archive',   // relative to the project root
  ARCHIVE_BATCH: 500,            // stories read per query while the archive is written
};

// ─── IPO Watch (services/ipoWatch) ───────────────────────────
// Runs only when FEATURES.IPO_WATCH is on. Dates are the exchange's, so "today" is too.
const IPO_WATCH = {
  TIMEZONE: 'Asia/Kolkata',
  // A listed issue stays on the calendar this long. The 3-month close is first readable on
  // day 91 (the first trading day on or after listing + 90, once that day is over), so the
  // window runs as long as prices are fetched (RETURN_GIVE_UP_DAYS) — at 90 the issue left
  // the page the day before its last figure could be shown.
  RECENT_LISTED_DAYS: 100,
  // The poll runs once a day and never on start, so a server that was down at poll time
  // shows yesterday's calendar. Older than this and the page says so.
  STALE_AFTER_HOURS: 30,
  UNLISTED_AFTER_CLOSE_DAYS: 10, // closed this long with no listing date on record → off the calendar
  // Grey market premium is hearsay from one aggregator. A reading older than this is not
  // shown at all — an old number passed off as current is worse than none.
  GMP_STALE_HOURS: 36,           // the poll is daily; this allows one late run
  // The calendar is polled once a day, never on boot: the sources are unofficial pages, so
  // a restart loop must not turn into a burst of requests.
  CRON: '15 9 * * *',            // 09:15, in TIMEZONE — as the market opens
  // Sent on every request. Says who we are; override with IPO_WATCH_USER_AGENT.
  USER_AGENT: process.env.IPO_WATCH_USER_AGENT || 'Mozilla/5.0 (compatible; SenIQ/1.0; admin@xynthis.com)',
  INVESTORGAIN_URL: 'https://www.investorgain.com/report/live-ipo-gmp/331/',
  INVESTORGAIN_SUBSCRIPTION_URL: 'https://www.investorgain.com/report/ipo-subscription-live/333/all/',
  REQUEST_DELAY_MS: 1500,        // gap between two sources — they can be the same site
  // The registry: stored stories are matched to an issue by name, and a listed issue is
  // given its ticker.
  LINK_WINDOW_DAYS: 2,           // how far back each news run looks for stories to link
  LINK_BACKFILL_DAYS: 30,        // ...and each calendar poll, so a newly seen issue gets its earlier stories
  MATCH_AFTER_LISTING_DAYS: 30,  // an issue's name stops matching news this long after it lists
  SYMBOL_LOOKUP_DAYS: 14,        // how long after listing the ticker is still looked for
  SYMBOL_LOOKUPS_PER_RUN: 20,    // ticker lookups a run — one request each, so a backlog drains over days
  STORY_READS_PER_RUN: 60,       // linked stories read for tone a run (FinBERT, or the word list)
  YAHOO_SEARCH_URL: 'https://query2.finance.yahoo.com/v1/finance/search',   // unofficial, like the price route
  // US issues come from Finnhub's IPO calendar (FINNHUB_API_KEY), in the same daily poll.
  FINNHUB_IPO_URL: 'https://finnhub.io/api/v1/calendar/ipo',
  US_LOOKBACK_DAYS: 30,          // how far back each poll asks for US filings, pricings and withdrawals
  US_LOOKAHEAD_DAYS: 60,         // ...and how far ahead (Finnhub rarely dates anything past the week)
  // Returns after listing, read from Yahoo's daily prices for issues that have a ticker.
  YAHOO_CHART_URL: 'https://query1.finance.yahoo.com/v8/finance/chart',
  RETURN_SLACK_DAYS: 5,          // a horizon's close may be this many days late (weekends, holidays)
  RETURN_GIVE_UP_DAYS: 100,      // stop asking for an issue's prices this long after it listed (the 3-month close is the last)
  RETURN_LOOKUPS_PER_RUN: 20,    // price lookups a run — one request each
  US_TIMEZONE: 'America/New_York',   // a US day's prices are final once this clock has moved past it
  // Graduation into the company reference: the price feed's opening price on the listing day
  // must be this close to the listing price the source gave, or the ticker is not trusted.
  GRADUATE_PRICE_TOLERANCE: 0.02,
  // US issues with a ticker get their company news fetched in the news pipeline, so stories
  // exist to link: the newest few, a request each a pass.
  MONITOR_TICKERS: 10,
  MONITOR_DAYS: 30,
  TIMEOUT_MS: 20000,
};

// ─── Strategy service (Phase 7) ──────────────────────────────
// The Python backtest engine runs as its own HTTP service; SenIQ proxies to it.
// When the service isn't running, strategy routes return 503 and the rest of the
// app is unaffected. The shared secret (when set on both sides) authenticates
// SenIQ to the service.
const STRATEGY_SERVICE = {
  URL: process.env.STRATEGY_SERVICE_URL || 'http://localhost:8100',
  SECRET: process.env.STRATEGY_SERVICE_SECRET || '',
  TIMEOUT_MS: 120000,            // backtests fetch + replay years of bars; allow long runs
  CATALOG_TIMEOUT_MS: 8000,
};

// ─── Paper ledger (services/paperLedger.js) ──────────────────
// A daily job replays every paper deployment and stores the fills and the day's closing
// value. Only completed days are stored: a bar dated today (UTC) may still be trading.
const PAPER = {
  // 01:15 UTC: the US close (20:00–21:00 UTC), the NSE close (10:00 UTC) and the crypto
  // day (ends 00:00 UTC) are all behind it, so every bar dated before today is final.
  MARK_CRON: '15 1 * * *',
  MARK_TIMEZONE: 'UTC',
  BOOT_DELAY_MS: 20000,          // catch-up run after start; a deployment already marked today is skipped
  // A fill is emailed only if it is this recent when first recorded. Older ones are history
  // (the first pass over an existing deployment, or the app was off for a week).
  NOTIFY_FRESH_DAYS: 3,
  LEDGER_FILLS: 200,             // newest fills a ledger read returns
  LEDGER_DAYS: 400,              // newest recorded days a ledger read returns
  EMAIL_SUBJECT_PREFIX: '[SenIQ]',
};

// ─── OAuth sign-in (Phase 5) ─────────────────────────────────
// Authorization-code flow, callback at /api/auth/oauth/<provider>/callback.
// A provider is live only when both its ID and SECRET are set; the frontend asks
// /api/config which buttons to show, so unset providers simply don't appear.
// APP_URL builds the callback + emailed links; local dev falls back to localhost.
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const OAUTH = {
  GOOGLE: {
    ID: process.env.GOOGLE_CLIENT_ID || '',
    SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
    get enabled() { return !!(this.ID && this.SECRET); },
  },
  GITHUB: {
    ID: process.env.GITHUB_CLIENT_ID || '',
    SECRET: process.env.GITHUB_CLIENT_SECRET || '',
    get enabled() { return !!(this.ID && this.SECRET); },
  },
  STATE_TTL_MIN: 10,             // signed state token lifetime (CSRF guard)
};

// ─── Transactional email (Phase 5 reset/verify; Phase 9 reuses this) ──
// Two ways to send, picked by what is configured:
//   Resend (https://resend.com) — one HTTPS POST. Needs a verified sending domain to reach
//     anyone but the account owner. Used whenever RESEND_API_KEY is set.
//   SMTP — any mailbox that accepts an app password (Gmail: ~500 emails/day, sent from
//     that address). The no-domain option for demos and a few test users.
// With neither, the app still works: password-reset links are returned in dev responses
// instead of emailed, and verification + alert emails are skipped.
const EMAIL = {
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  SMTP: {
    HOST: process.env.SMTP_HOST || '',
    PORT: Number(process.env.SMTP_PORT) || 587,
    USER: process.env.SMTP_USER || '',
    PASS: (process.env.SMTP_PASS || '').replace(/\s+/g, ''), // Google shows app passwords in spaced groups
    get enabled() { return !!(this.HOST && this.USER && this.PASS); },
  },
  FROM: process.env.EMAIL_FROM || (process.env.SMTP_USER ? `SenIQ <${process.env.SMTP_USER}>` : 'SenIQ <onboarding@resend.dev>'),
  get provider() { return this.RESEND_API_KEY ? 'resend' : (this.SMTP.enabled ? 'smtp' : null); },
  get enabled() { return !!this.provider; },
  SMTP_TIMEOUT_MS: 15000,
};

// ─── Auth endpoint rate limits (Phase 5 hardening) ───────────
// Per-IP sliding windows (in-memory, same limiter as the API keys). Aimed at
// credential stuffing / reset spam, not accounting — counters reset on restart.
const AUTH_LIMITS = {
  LOGIN:  { limit: 20, windowMs: 10 * 60 * 1000 },  // login + signup attempts
  RESET:  { limit: 5,  windowMs: 15 * 60 * 1000 },  // forgot-password requests
  TOKEN_TTL_MIN: { RESET: 30, VERIFY: 60 * 24 },    // emailed link lifetimes
  MIN_PASSWORD_CHARS: 8,
  MAX_PASSWORD_CHARS: 72,                            // bcrypt reads only the first 72 bytes
};

// ─── Browser sessions (services/sessions.js) ─────────────────
const SESSION = {
  COOKIE: 'seniq_session',
  IDLE_DAYS: 7,          // unused this long → signed out (each use pushes it back)
  ABSOLUTE_DAYS: 30,     // signed out this long after sign-in, however active
  TOUCH_MINUTES: 5,      // how often activity is written back to the session row
  REAUTH_MINUTES: 10,    // how long a password confirmation covers sensitive actions
};

module.exports = { SESSION, DISCLAIMER, TIERS, TIER_ORDER, PRICING, FEATURES, FINBERT, TARGETED, SENTIMENT, SOURCE_WEIGHTS, IMPACT, EVENT_TYPES, NEWS_RELEVANCE, MATERIALITY, ALERT_BUDGET, ALERT_EMAIL, ALERT_NARRATIVE, OUTCOMES, EVENTS, ONBOARDING, REPORTS, QA, NEWS_SEARCH, INGEST, SMART_MONEY, INDIA_SMART_MONEY, IPO_WATCH, RETENTION, STRATEGY_SERVICE, PAPER, APP_URL, OAUTH, EMAIL, AUTH_LIMITS, DISCLOSURES, REPORT_EMAIL, LLM };
