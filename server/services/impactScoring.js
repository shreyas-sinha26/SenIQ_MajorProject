/**
 * Portfolio Impact Scoring (Phase 2e) — the North Star.
 *
 * The differentiator is NOT "Tesla sentiment is negative" but exposure-weighted
 * impact on the user's OWN portfolio: "this event affects 18% of your exposure /
 * today's most important event for you." Core unit = event → portfolio impact.
 *
 *   impact = Σ_holdings ( exposure_weight × event_relevance × magnitude × z_boost )
 *
 *   - exposure_weight: the holding's share of the portfolio (portfolioService)
 *   - magnitude:       |score - 0.5| × 2  (how extreme the event's sentiment is)
 *   - z_boost:         surprise vs the asset's 90-day baseline amplifies impact
 *   - macro events:    apply across the whole portfolio, diluted by MACRO_BROAD_FACTOR
 *
 * Recomputed each cron pass over a recent window; results land in
 * event_portfolio_impact and drive the per-user ranked feed (GET /api/news/impact).
 */

const { query, execute } = require('../db');
const { IMPACT } = require('../config');
const { getWeightedHoldings } = require('./portfolioService');
const { scoreTicker } = require('./sentimentScoring');

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

// Pull recent scored articles and group them into events keyed by article.
async function loadRecentEvents() {
  const rows = await query(
    `SELECT a.id AS article_id, a.title, a.url, a.source, a.platform, a.published_at,
            s.ticker, s.sentiment_score AS score, s.confidence
       FROM articles a
       JOIN article_sentiments s ON s.article_id = a.id
      WHERE a.published_at > now() - ($1 || ' hours')::interval`,
    [String(IMPACT.EVENT_WINDOW_HOURS)]
  );

  const events = new Map();
  for (const r of rows) {
    let ev = events.get(r.article_id);
    if (!ev) {
      ev = {
        article_id: r.article_id,
        title: r.title,
        url: r.url,
        source: r.source,
        platform: r.platform,
        published_at: r.published_at,
        tickers: {},
        isMacro: false,
      };
      events.set(r.article_id, ev);
    }
    if (r.ticker === '__MARKET__' || r.platform === 'macro') ev.isMacro = true;
    if (r.ticker && r.ticker !== '__MARKET__') {
      ev.tickers[r.ticker] = { score: Number(r.score), confidence: Number(r.confidence) };
    } else if (r.ticker === '__MARKET__') {
      ev.macroScore = Number(r.score);
    }
  }
  return [...events.values()];
}

function zBoost(z) {
  if (z == null) return 1;
  return 1 + IMPACT.Z_BOOST * Math.min(Math.abs(z), 3);
}

function dirLabel(signed) {
  if (signed > 0.02) return 'positive';
  if (signed < -0.02) return 'negative';
  return 'neutral';
}

// Compute one user's impact for one event given their exposure map + z-boosts.
function impactForEvent(event, exposureByTicker, zByTicker) {
  let impact = 0;
  let exposure = 0;
  let signed = 0; // magnitude-weighted direction accumulator

  for (const [ticker, s] of Object.entries(event.tickers)) {
    const exp = exposureByTicker[ticker];
    if (exp == null) continue; // user doesn't hold it
    const mag = Math.abs(s.score - 0.5) * 2;
    const w = exp / 100;
    const eff = mag * zBoost(zByTicker[ticker]);
    impact += w * eff;
    exposure += exp;
    signed += (s.score - 0.5) * w;
  }

  if (event.isMacro && Object.keys(exposureByTicker).length > 0) {
    const macroScore = event.macroScore != null ? event.macroScore : avgScore(event);
    if (macroScore != null) {
      const mag = Math.abs(macroScore - 0.5) * 2;
      impact += IMPACT.MACRO_BROAD_FACTOR * mag;
      exposure += 100 * IMPACT.MACRO_BROAD_FACTOR;
      signed += (macroScore - 0.5) * IMPACT.MACRO_BROAD_FACTOR;
    }
  }

  return { impact: round(impact), exposure_pct: round(Math.min(100, exposure), 1), direction: dirLabel(signed) };
}

function avgScore(event) {
  const xs = Object.values(event.tickers).map((t) => t.score);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

async function recomputeImpacts() {
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

  let written = 0;
  for (const { user_id } of userRows) {
    const holdings = await getWeightedHoldings(user_id);
    if (holdings.length === 0) continue;
    const exposureByTicker = {};
    for (const h of holdings) exposureByTicker[h.ticker] = h.exposure_pct ?? 0;

    for (const event of events) {
      const { impact, exposure_pct, direction } = impactForEvent(event, exposureByTicker, zByTicker);
      if (impact <= 0 || exposure_pct <= 0) continue;
      await execute(
        `INSERT INTO event_portfolio_impact (user_id, article_id, impact_score, exposure_pct, direction)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, article_id)
         DO UPDATE SET impact_score = EXCLUDED.impact_score,
                       exposure_pct = EXCLUDED.exposure_pct,
                       direction    = EXCLUDED.direction,
                       computed_at  = now()`,
        [user_id, event.article_id, impact, exposure_pct, direction]
      );
      written++;
    }
  }

  // Drop impacts for events that have aged out of the window.
  await execute(
    `DELETE FROM event_portfolio_impact
      WHERE article_id IN (
        SELECT id FROM articles WHERE published_at <= now() - ($1 || ' hours')::interval
      )`,
    [String(IMPACT.EVENT_WINDOW_HOURS)]
  );

  return written;
}

// Ranked feed for a user; the first row is "today's most important event".
async function getImpactFeed(userId, limit = 20) {
  return query(
    `SELECT e.impact_score, e.exposure_pct, e.direction, e.computed_at,
            a.id AS article_id, a.title, a.url, a.source, a.platform, a.published_at
       FROM event_portfolio_impact e
       JOIN articles a ON a.id = e.article_id
      WHERE e.user_id = $1
      ORDER BY e.impact_score DESC, a.published_at DESC
      LIMIT $2`,
    [userId, limit]
  );
}

module.exports = { recomputeImpacts, getImpactFeed, impactForEvent, loadRecentEvents };
