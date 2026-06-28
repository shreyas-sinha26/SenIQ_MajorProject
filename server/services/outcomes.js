/**
 * Outcome logging (Engine Phase E3).
 *
 * The self-assembling training set the v2 supervised model will learn from — no
 * historical corpus needed. Two steps run each pipeline pass:
 *
 *  logEventFeatures()  — snapshot, per event, the features that drove our decision
 *                        (type, severity, source_count, sentiment, z, max_impact) plus
 *                        the primary ticker's price right now (price_at_event).
 *  resolveOutcomes()   — for events 1–3 days old, capture the later price and compute
 *                        the move; |move| ≥ OUTCOMES.MATERIAL_MOVE_PCT ⇒ "materially
 *                        moved" (the label). Price only resolves where we have a feed
 *                        (US equities w/ Finnhub key + crypto); India equities stay null.
 *
 * Engagement labels (did the user open/dismiss) live on the alerts table (read/dismissed)
 * and are joined at training time.
 */

const { EVENTS, EVENT_TYPES, OUTCOMES } = require('../config');

async function logEventFeatures() {
  const { query, execute } = require('../db');
  const { getQuotes } = require('./priceService');
  const { scoreTicker } = require('./sentimentScoring');
  const win = String(EVENTS.WINDOW_DAYS);

  const rows = await query(
    `SELECT e.id, e.primary_ticker, e.event_type, e.relevance_tier, e.source_count, e.first_seen,
            (SELECT avg(s.sentiment_score) FROM articles a JOIN article_sentiments s ON s.article_id = a.id
              WHERE a.event_id = e.id AND s.ticker = e.primary_ticker) AS sentiment_score,
            (SELECT max(impact_score) FROM event_portfolio_impact i WHERE i.event_id = e.id) AS max_impact
       FROM events e
      WHERE e.last_seen > now() - ($1 || ' days')::interval
        AND e.primary_ticker IS NOT NULL`,
    [win]
  );
  if (rows.length === 0) return 0;

  const tickers = [...new Set(rows.map((r) => r.primary_ticker))];
  const zByTicker = {};
  for (const t of tickers) {
    try { zByTicker[t] = (await scoreTicker(t)).baseline.z; } catch { zByTicker[t] = null; }
  }
  const acRows = await query('SELECT ticker, asset_class FROM companies WHERE ticker = ANY($1)', [tickers]);
  const acByTicker = Object.fromEntries(acRows.map((r) => [r.ticker, r.asset_class]));
  const quotes = await getQuotes(tickers.map((t) => ({ ticker: t, assetClass: acByTicker[t] || 'equity' })));

  let n = 0;
  for (const r of rows) {
    const severity = EVENT_TYPES.SEVERITY[r.event_type] ?? EVENT_TYPES.SEVERITY.other;
    const price = quotes[r.primary_ticker] ? quotes[r.primary_ticker].price : null;
    await execute(
      `INSERT INTO event_outcomes (event_id, primary_ticker, event_type, relevance_tier, severity,
              source_count, sentiment_score, z_score, max_impact, price_at_event, first_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (event_id) DO UPDATE SET
         event_type=EXCLUDED.event_type, relevance_tier=EXCLUDED.relevance_tier, severity=EXCLUDED.severity,
         source_count=EXCLUDED.source_count, sentiment_score=EXCLUDED.sentiment_score, z_score=EXCLUDED.z_score,
         max_impact=EXCLUDED.max_impact,
         price_at_event = COALESCE(event_outcomes.price_at_event, EXCLUDED.price_at_event)`,
      [r.id, r.primary_ticker, r.event_type, r.relevance_tier, severity, r.source_count,
       r.sentiment_score, zByTicker[r.primary_ticker], r.max_impact, price, r.first_seen]
    );
    n++;
  }
  return n;
}

async function resolveOutcomes() {
  const { query, execute } = require('../db');
  const { getQuotes } = require('./priceService');

  const rows = await query(
    `SELECT eo.event_id, eo.primary_ticker, eo.price_at_event, eo.first_seen, eo.price_1d, eo.price_3d,
            c.asset_class
       FROM event_outcomes eo
       LEFT JOIN companies c ON c.ticker = eo.primary_ticker
      WHERE eo.price_at_event IS NOT NULL AND (eo.price_1d IS NULL OR eo.price_3d IS NULL)`
  );
  if (rows.length === 0) return 0;

  const tickers = [...new Set(rows.map((r) => r.primary_ticker))];
  const acByTicker = Object.fromEntries(rows.map((r) => [r.primary_ticker, r.asset_class || 'equity']));
  const quotes = await getQuotes(tickers.map((t) => ({ ticker: t, assetClass: acByTicker[t] })));
  const now = Date.now();
  let n = 0;

  for (const r of rows) {
    const cur = quotes[r.primary_ticker] ? quotes[r.primary_ticker].price : null;
    if (cur == null) continue;
    const ageDays = (now - new Date(r.first_seen).getTime()) / 86_400_000;
    const base = Number(r.price_at_event);
    if (base <= 0) continue;

    if (r.price_1d == null && ageDays >= 1) {
      await execute(
        'UPDATE event_outcomes SET price_1d=$2, move_1d=$3, resolved_1d_at=now() WHERE event_id=$1',
        [r.event_id, cur, (cur - base) / base]
      );
      n++;
    }
    if (r.price_3d == null && ageDays >= 3) {
      const move = (cur - base) / base;
      await execute(
        'UPDATE event_outcomes SET price_3d=$2, move_3d=$3, materially_moved=$4, resolved_3d_at=now() WHERE event_id=$1',
        [r.event_id, cur, move, Math.abs(move) >= OUTCOMES.MATERIAL_MOVE_PCT]
      );
      n++;
    }
  }
  return n;
}

module.exports = { logEventFeatures, resolveOutcomes };
