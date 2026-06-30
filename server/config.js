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
  FINBERT_CLASSIFY: process.env.FINBERT_CLASSIFY === '1', // HF Inference API batch classifier (needs HF_API_TOKEN)
  SMART_MONEY: true,     // Phase 3: 13F (EDGAR) + Congress tabs + instant filing alerts
  CLAUDE_REPORTS: false,
  BILLING: false,
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
  MACRO_BROAD_FACTOR: 0.5,    // relevance of a macro event to a non-matching holding
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
};

// ─── Alert budgets + outcomes (Engine Phase E3) ──────────────
// Anti-fatigue: every material event is still recorded, but only the top
// MAX_REALTIME_PER_DAY (by priority) push in real time; the rest are 'digest'.
// A ticker can't push more than once per PER_TICKER_COOLDOWN_HOURS. Quiet hours
// hold pushes to digest (off until we capture each user's timezone).
const ALERT_BUDGET = {
  MAX_REALTIME_PER_DAY: 5,
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
  HOLDING_THRESHOLD: 0.35,    // per-user materiality needed to fire a holding alert
  BROAD_THRESHOLD: 0.6,       // importance needed for a market/world alert to all users
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
  CRON: '30 5 * * *',            // server-scheduled daily (05:30 server time); never user-triggered on demand
  MAX_OUTPUT_TOKENS: 1800,       // hard per-call output cap
  TOP_HOLDINGS: 12,              // trim the packet to the top-N holdings by exposure
  TOP_EVENTS: 6,                 // and the top-N impact events
  MAX_NEWS_CHARS: 280,           // clamp each untrusted headline/summary before prompting
  PER_USER_DAILY_QUOTA: 1,       // Plus=1, Pro=2 (+1 manual) once tiers land; blocked before any call
  GLOBAL_DAILY_USD_CEILING: 5,   // global kill-switch: stop calling Claude past this day's spend
  // Haiku 4.5 pricing ($/1M tokens) for the cost estimate logged per call.
  PRICE_PER_MTOK: { input: 1.0, output: 5.0 },
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
  MAX_OUTPUT_TOKENS: 1000,
  PER_USER_DAILY_QUESTIONS: 10,  // becomes Plus tier later (Free 0 / Pro ~30) with billing
  MAX_QUESTION_CHARS: 500,       // clamp the (untrusted) question before prompting
  TOP_EVENTS: 10,                // extended grounding: fuller impact feed than the daily brief
  MAX_HOLDINGS: 30,              // all holdings up to this cap (not just top-N)
};

// ─── Ingestion sources (Phase 2b) ────────────────────────────
const INGEST = {
  GDELT_MAX_RECORDS: 30,
  GDELT_TIMESPAN: '1d',
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
};

module.exports = { DISCLAIMER, TIERS, TIER_ORDER, PRICING, FEATURES, SENTIMENT, SOURCE_WEIGHTS, IMPACT, EVENT_TYPES, NEWS_RELEVANCE, MATERIALITY, ALERT_BUDGET, OUTCOMES, EVENTS, ONBOARDING, REPORTS, QA, INGEST, SMART_MONEY };
