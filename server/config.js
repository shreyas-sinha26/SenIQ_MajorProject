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
const TIERS = {
  free: {
    label: 'Free',
    maxHoldings: 7,
    sources: ['news', 'macro'],
    claudeReportsPerDay: 0,
    realtimeAlerts: false,
    apiAccess: false,
    smartMoney: 'teaser',          // top 1-2, delayed, in the digest only
    smartMoneyRealtime: false,     // no instant smart-money alerts
    webhooks: false,
  },
  plus: {
    label: 'Plus',
    maxHoldings: Infinity,
    sources: ['news', 'reddit', 'macro'],
    claudeReportsPerDay: 1,
    realtimeAlerts: true,
    apiAccess: false,
    smartMoney: 'full',            // full Institutions + Politicians tabs
    smartMoneyRealtime: true,      // instant alerts on followed + holdings
    webhooks: false,
  },
  pro: {
    label: 'Pro',
    maxHoldings: Infinity,
    sources: ['news', 'reddit', 'macro'],
    claudeReportsPerDay: 2,
    realtimeAlerts: true,
    apiAccess: true,
    smartMoney: 'full',            // full + filtered to holdings
    smartMoneyRealtime: true,
    webhooks: true,                // register outbound webhooks for events
  },
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

// ─── Portfolio Impact Scoring (Phase 2e) ─────────────────────
const IMPACT = {
  EVENT_WINDOW_HOURS: 72,     // only recent events compete for "today's most important"
  MACRO_BROAD_FACTOR: 0.5,    // a macro event touches the whole portfolio, but diluted
  Z_BOOST: 0.25,              // how much a surprising z-score amplifies impact
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

module.exports = { DISCLAIMER, TIERS, FEATURES, SENTIMENT, SOURCE_WEIGHTS, IMPACT, NEWS_RELEVANCE, MATERIALITY, INGEST, SMART_MONEY };
