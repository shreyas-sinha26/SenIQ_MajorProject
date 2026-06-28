/**
 * Portfolio Impact Scoring (Phase 2e + E2 6-factor) — the North Star.
 *
 * The differentiator is NOT "Tesla sentiment is negative" but exposure-weighted
 * impact on the user's OWN portfolio: "this event affects 18% of your exposure /
 * today's most important event for you." Core unit = event → portfolio impact.
 *
 *   impact(holding) = exposure × relevance × severity × novelty × confidence × recency
 *
 *   exposure  : the holding's % weight (portfolioService)               0..1
 *   relevance : 1.0 direct hold · SECTOR_RELEVANCE sector · MACRO_BROAD_FACTOR macro
 *   severity  : event-type weight × sentiment magnitude (|score-0.5|×2) 0..1 (the core)
 *   novelty   : z-surprise vs the asset's 90-day baseline   (mult ~0.8..1.2; null→1.0)
 *   confidence: classifier/source confidence                (mult CONFIDENCE_FLOOR..1)
 *   recency   : time decay on the event's last_seen          (mult RECENCY_FLOOR..1)
 *
 * Recomputed each cron pass; results land in event_portfolio_impact and drive the
 * per-user ranked feed (GET /api/news/impact).
 */

// db + portfolioService are lazy-required inside the async functions so the pure
// scoring math (impactForEvent + factors) stays importable/testable without a database.
const { IMPACT, EVENT_TYPES, SENTIMENT } = require('../config');
const { scoreTicker } = require('./sentimentScoring');

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

// Pull recent durable events with per-ticker sentiment + type/sectors for scoring.
async function loadRecentEvents() {
  const { query } = require('../db');
  const rows = await query(
    `SELECT e.id AS event_id, e.title, e.url, e.source, e.relevance_tier, e.event_type,
            e.sectors, e.last_seen,
            s.ticker, avg(s.sentiment_score) AS score, max(s.confidence) AS confidence,
            bool_or(a.platform = 'macro') AS is_macro
       FROM events e
       JOIN articles a ON a.event_id = e.id
       JOIN article_sentiments s ON s.article_id = a.id
      WHERE e.last_seen > now() - ($1 || ' hours')::interval
      GROUP BY e.id, e.title, e.url, e.source, e.relevance_tier, e.event_type, e.sectors, e.last_seen, s.ticker`,
    [String(IMPACT.EVENT_WINDOW_HOURS)]
  );

  const events = new Map();
  for (const r of rows) {
    let ev = events.get(r.event_id);
    if (!ev) {
      ev = {
        event_id: r.event_id,
        title: r.title,
        url: r.url,
        source: r.source,
        event_type: r.event_type,
        sectors: r.sectors || [],
        last_seen: r.last_seen,
        published_at: r.last_seen,
        tickers: {},
        isMacro: r.relevance_tier === 'market' || r.relevance_tier === 'world',
      };
      events.set(r.event_id, ev);
    }
    if (r.is_macro) ev.isMacro = true;
    if (r.ticker === '__MARKET__') {
      ev.isMacro = true;
      ev.macroScore = Number(r.score);
    } else if (r.ticker) {
      ev.tickers[r.ticker] = { score: Number(r.score), confidence: Number(r.confidence) };
    }
  }
  return [...events.values()];
}

function dirLabel(signed) {
  if (signed > 0.02) return 'positive';
  if (signed < -0.02) return 'negative';
  return 'neutral';
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function avgScore(event) { return avg(Object.values(event.tickers).map((t) => t.score)); }
function avgConf(event) { return avg(Object.values(event.tickers).map((t) => t.confidence)); }

// ── the six factors ──
function noveltyMult(z) {
  if (z == null) return 1.0; // unknown surprise → neutral
  return IMPACT.NOVELTY_BASE + IMPACT.NOVELTY_GAIN * (Math.min(Math.abs(z), 3) / 3);
}
function confidenceMult(conf) {
  return IMPACT.CONFIDENCE_FLOOR + (1 - IMPACT.CONFIDENCE_FLOOR) * Math.min(1, Math.max(0, conf || 0));
}
function recencyMult(lastSeen, now) {
  const ageH = (now - new Date(lastSeen).getTime()) / 3_600_000;
  const decay = Math.pow(0.5, Math.max(0, ageH) / SENTIMENT.HALF_LIFE_HOURS);
  return IMPACT.RECENCY_FLOOR + (1 - IMPACT.RECENCY_FLOOR) * decay;
}

/**
 * One user's impact for one event. `holdings` = [{ticker, exposure_pct, sector}].
 * Each holding is scored by its strongest connection to the event:
 * direct ticker > sector match > macro-broad. Pure (now injectable for tests).
 */
function impactForEvent(event, holdings, zByTicker, now = Date.now()) {
  const severity = EVENT_TYPES.SEVERITY[event.event_type] ?? EVENT_TYPES.SEVERITY.other;
  const eventSectors = new Set(event.sectors || []);
  const eventScore = event.macroScore != null ? event.macroScore : (avgScore(event) ?? 0.5);
  const eventConf = avgConf(event) ?? 0.5;
  const recency = recencyMult(event.last_seen, now);

  let impact = 0;
  let exposure = 0;
  let signed = 0;

  for (const h of holdings) {
    let relevance = 0;
    let score;
    let conf;
    let z = null;
    if (event.tickers[h.ticker]) {
      relevance = 1.0;                              // direct holding
      score = event.tickers[h.ticker].score;
      conf = event.tickers[h.ticker].confidence;
      z = zByTicker[h.ticker];
    } else if (h.sector && eventSectors.has(h.sector)) {
      relevance = IMPACT.SECTOR_RELEVANCE;          // sector-wide event
      score = eventScore; conf = eventConf;
    } else if (event.isMacro) {
      relevance = IMPACT.MACRO_BROAD_FACTOR;        // macro applies broadly
      score = eventScore; conf = eventConf;
    } else {
      continue;                                      // event doesn't touch this holding
    }

    const magnitude = Math.abs(score - 0.5) * 2;
    const severityCore = severity * magnitude;       // "how big" = type × sentiment
    const w = (h.exposure_pct || 0) / 100;
    const contribution = w * relevance * severityCore * noveltyMult(z) * confidenceMult(conf) * recency;
    impact += contribution;
    exposure += (h.exposure_pct || 0) * relevance;
    signed += (score - 0.5) * w * relevance;
  }

  return { impact: round(impact), exposure_pct: round(Math.min(100, exposure), 1), direction: dirLabel(signed) };
}

async function recomputeImpacts() {
  const { query, execute } = require('../db');
  const { getWeightedHoldings } = require('./portfolioService');
  const events = await loadRecentEvents();
  const userRows = await query('SELECT DISTINCT user_id FROM portfolio');

  // Baseline z per distinct held ticker, computed once for the whole run.
  const heldTickers = await query('SELECT DISTINCT ticker FROM portfolio');
  const zByTicker = {};
  for (const { ticker } of heldTickers) {
    try {
      const s = await scoreTicker(ticker);
      zByTicker[ticker] = s.baseline.z;
    } catch {
      zByTicker[ticker] = null;
    }
  }

  // ticker → sector, so a holding can match a sector-wide event.
  const sectorByTicker = {};
  for (const r of await query('SELECT ticker, sector FROM companies')) sectorByTicker[r.ticker] = r.sector;

  const now = Date.now();
  let written = 0;
  for (const { user_id } of userRows) {
    const raw = await getWeightedHoldings(user_id);
    if (raw.length === 0) continue;
    const holdings = raw.map((h) => ({ ticker: h.ticker, exposure_pct: h.exposure_pct ?? 0, sector: sectorByTicker[h.ticker] || null }));

    for (const event of events) {
      const { impact, exposure_pct, direction } = impactForEvent(event, holdings, zByTicker, now);
      if (impact <= 0 || exposure_pct <= 0) continue;
      await execute(
        `INSERT INTO event_portfolio_impact (user_id, event_id, impact_score, exposure_pct, direction)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, event_id)
         DO UPDATE SET impact_score = EXCLUDED.impact_score,
                       exposure_pct = EXCLUDED.exposure_pct,
                       direction    = EXCLUDED.direction,
                       computed_at  = now()`,
        [user_id, event.event_id, impact, exposure_pct, direction]
      );
      written++;
    }
  }

  // Prune impacts for events that have aged out of the 72h feed window. (Events live
  // 7 days for clustering, but the impact feed is "today's most important" — without
  // this, an out-of-window event keeps a stale score it's no longer being recomputed on.)
  await execute(
    `DELETE FROM event_portfolio_impact
      WHERE event_id IN (SELECT id FROM events WHERE last_seen <= now() - ($1 || ' hours')::interval)`,
    [String(IMPACT.EVENT_WINDOW_HOURS)]
  );

  return written;
}

/**
 * Silent historical backfill for ONE user (Engine Phase E4) — run on add.
 * Computes this user's impact over events already stored (the 72h window), so a newly
 * added holding gets instant context in the feed/brief WITHOUT touching alerts or other
 * users. Returns the number of impact rows written for the user.
 */
async function recomputeImpactsForUser(userId) {
  const { query, execute } = require('../db');
  const { getWeightedHoldings } = require('./portfolioService');
  const raw = await getWeightedHoldings(userId);
  if (raw.length === 0) return 0;

  const events = await loadRecentEvents();
  if (events.length === 0) return 0;

  const sectorByTicker = {};
  for (const r of await query('SELECT ticker, sector FROM companies')) sectorByTicker[r.ticker] = r.sector;

  const zByTicker = {};
  for (const h of raw) {
    try { zByTicker[h.ticker] = (await scoreTicker(h.ticker)).baseline.z; }
    catch { zByTicker[h.ticker] = null; }
  }

  const holdings = raw.map((h) => ({ ticker: h.ticker, exposure_pct: h.exposure_pct ?? 0, sector: sectorByTicker[h.ticker] || null }));
  const now = Date.now();
  let written = 0;
  for (const event of events) {
    const { impact, exposure_pct, direction } = impactForEvent(event, holdings, zByTicker, now);
    if (impact <= 0 || exposure_pct <= 0) continue;
    await execute(
      `INSERT INTO event_portfolio_impact (user_id, event_id, impact_score, exposure_pct, direction)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, event_id)
       DO UPDATE SET impact_score = EXCLUDED.impact_score,
                     exposure_pct = EXCLUDED.exposure_pct,
                     direction    = EXCLUDED.direction,
                     computed_at  = now()`,
      [userId, event.event_id, impact, exposure_pct, direction]
    );
    written++;
  }
  return written;
}

// Ranked feed for a user; the first row is "today's most important event".
async function getImpactFeed(userId, limit = 20) {
  const { query } = require('../db');
  return query(
    `SELECT i.impact_score, i.exposure_pct, i.direction, i.computed_at,
            e.id AS event_id, e.title, e.url, e.source, e.last_seen AS published_at
       FROM event_portfolio_impact i
       JOIN events e ON e.id = i.event_id
      WHERE i.user_id = $1
      ORDER BY i.impact_score DESC, e.last_seen DESC
      LIMIT $2`,
    [userId, limit]
  );
}

module.exports = { recomputeImpacts, recomputeImpactsForUser, getImpactFeed, impactForEvent, loadRecentEvents, noveltyMult, confidenceMult, recencyMult };
