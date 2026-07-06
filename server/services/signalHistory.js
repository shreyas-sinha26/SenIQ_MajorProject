/**
 * Signal history for strategy factors (Phase 7, step 5).
 *
 * When a Builder spec uses source:"seniq" factors, the Node side reads RAW
 * rows from its own DB and pushes them with the engine request; the strategy
 * service does the math (rolling z-scores, trailing windows) and aligns them
 * to the price timeline. This keeps the service DB-free and the contract thin:
 *
 *   { sentiment: [{date, avg_score, n_articles}, ...],     // per ticker, per day
 *     congress:  [{date, side}, ...] }                     // DISCLOSURE dates
 *
 * Honesty rules: congress rows use disclosure_date (when the public could
 * know), and bundled sample rows are excluded — demo data must never feed a
 * backtest.
 */
const { query } = require('../db');

// True if a Builder spec references any SenIQ signal factor.
function hasSeniqFactors(spec) {
  return !!(spec && Array.isArray(spec.factors) &&
    spec.factors.some((f) => f && f.source === 'seniq'));
}

async function seniqDataForSymbol(symbol) {
  const t = String(symbol || '').trim().toUpperCase();
  if (!t) return { sentiment: [], congress: [] };
  const [sentiment, congress] = await Promise.all([
    query(
      `SELECT a.published_at::date AS date,
              AVG(s.sentiment_score)::float AS avg_score,
              COUNT(*)::int AS n_articles
       FROM article_sentiments s
       JOIN articles a ON a.id = s.article_id
       WHERE s.ticker = $1
       GROUP BY 1 ORDER BY 1`, [t]),
    query(
      `SELECT disclosure_date::date AS date, transaction_type AS side
       FROM congress_trades
       WHERE ticker = $1 AND NOT is_sample AND disclosure_date IS NOT NULL
       ORDER BY 1`, [t]),
  ]);
  return {
    sentiment: sentiment.map((r) => ({
      date: r.date.toISOString ? r.date.toISOString().slice(0, 10) : String(r.date),
      avg_score: r.avg_score, n_articles: r.n_articles,
    })),
    congress: congress.map((r) => ({
      date: r.date.toISOString ? r.date.toISOString().slice(0, 10) : String(r.date),
      side: r.side,
    })),
  };
}

// For a single-symbol request (backtest / paper): the raw packet or null.
async function seniqDataIfNeeded(spec, symbol) {
  if (!hasSeniqFactors(spec)) return null;
  return seniqDataForSymbol(symbol);
}

// For a watchlist (live signals): {SYMBOL: packet} or null.
async function seniqDataForWatchlist(spec, symbols) {
  if (!hasSeniqFactors(spec)) return null;
  const out = {};
  await Promise.all((symbols || []).map(async (s) => {
    const t = String(s.symbol || '').trim().toUpperCase();
    if (t) out[t] = await seniqDataForSymbol(t);
  }));
  return out;
}

module.exports = { hasSeniqFactors, seniqDataIfNeeded, seniqDataForWatchlist };
