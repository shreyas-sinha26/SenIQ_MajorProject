/**
 * Signal history for strategy factors (Phase 7, step 5).
 *
 * When a Builder spec uses source:"seniq" factors, the Node side reads RAW
 * rows from its own DB and pushes them with the engine request; the strategy
 * service does the math (rolling z-scores, trailing windows) and aligns them
 * to the price timeline. This keeps the service DB-free and the contract thin:
 *
 *   { sentiment: [{date, avg_score, n_articles, w_sum, w_score}, ...],  // per ticker, per day
 *     congress:  [{date, side, politician}, ...],          // DISCLOSURE dates
 *     institutions: { filings:  [{fund, date}, ...],       // every tracked fund's 13F, by FILED date
 *                     holdings: [{fund, date, change}, ...] } }  // this ticker's rows in those filings
 *
 * w_sum / w_score carry the dashboard's per-article weighting (source credibility ×
 * confidence, see sentimentScoring.js) summed per day, so the engine can rebuild the
 * Acute score for the sentiment_acute factor without knowing about sources.
 *
 * Honesty rules: congress rows use disclosure_date and 13F rows use the FILED date (when
 * the public could know), and bundled sample rows are excluded — demo data must never
 * feed a backtest.
 *
 * Dates are formatted in SQL (to_char) and travel as 'YYYY-MM-DD' strings. A pg DATE comes
 * back as a JS Date at local midnight, and toISOString() on that is the PREVIOUS day east
 * of GMT — which handed the engine every disclosure one day early (a day of lookahead).
 *
 * Sentiment has two homes. Stories still stored are read from article_sentiments. Stories
 * that retention.js has pruned left their share of each day behind in sentiment_daily, as
 * sums; a day is the two added together, so pruning does not shorten or change the history.
 */
const { sourceWeight } = require('./sentimentScoring');

// One reading as the factors see it: its day, score and what its weight is made from.
// retention.js selects the same columns for the stories it prunes, so a story adds to its
// day in sentiment_daily exactly what it gave that day while it was stored.
const READING_COLS = `to_char(a.published_at, 'YYYY-MM-DD') AS date, s.sentiment_score::float AS score,
              s.confidence, a.source, a.platform`;

// True if a Builder spec references any SenIQ signal factor.
function hasSeniqFactors(spec) {
  return !!(spec && Array.isArray(spec.factors) &&
    spec.factors.some((f) => f && f.source === 'seniq'));
}

async function seniqDataForSymbol(symbol) {
  const t = String(symbol || '').trim().toUpperCase();
  if (!t) return { sentiment: [], congress: [], institutions: { filings: [], holdings: [] } };
  const { query } = require('../db'); // lazy — keeps dailySentiment testable offline
  const [sentiment, pruned, congress, filings, holdings] = await Promise.all([
    query(
      `SELECT ${READING_COLS}
       FROM article_sentiments s
       JOIN articles a ON a.id = s.article_id
       WHERE s.ticker = $1
       ORDER BY 1`, [t]),
    query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS date, n_articles, score_sum, w_sum, w_score
       FROM sentiment_daily
       WHERE ticker = $1`, [t]),
    query(
      `SELECT to_char(disclosure_date, 'YYYY-MM-DD') AS date, transaction_type AS side, politician
       FROM congress_trades
       WHERE ticker = $1 AND NOT is_sample AND disclosure_date IS NOT NULL
       ORDER BY 1`, [t]),
    // Every filing of every tracked fund — the engine needs the ones that do NOT list this
    // ticker too, or a fund that sold out would look like it still held.
    query(
      `SELECT i.slug AS fund, to_char(f.filed_at, 'YYYY-MM-DD') AS date
       FROM institution_filings f JOIN institutions i ON i.id = f.institution_id
       WHERE f.filed_at IS NOT NULL
       ORDER BY 2`),
    query(
      `SELECT i.slug AS fund, to_char(f.filed_at, 'YYYY-MM-DD') AS date, h.change_type AS change
       FROM institution_holdings h
       JOIN institution_filings f ON f.id = h.filing_id
       JOIN institutions i ON i.id = f.institution_id
       WHERE h.ticker = $1 AND f.filed_at IS NOT NULL
       ORDER BY 2`, [t]),
  ]);
  return {
    sentiment: dailySentiment(sentiment, pruned),
    congress: congress.map((r) => ({ date: r.date, side: r.side, politician: r.politician })),
    institutions: { filings, holdings: fundHoldings(holdings) },
  };
}

// A fund can report one company on several lines (share classes mapped to one ticker, or
// positions split across managers). Per (fund, filing) keep the strongest statement:
// opening or adding outranks trimming, which outranks no change. Pure.
const CHANGE_RANK = { new: 5, added: 4, reduced: 3, unchanged: 2, baseline: 1 };
function fundHoldings(rows) {
  const best = new Map();
  for (const r of rows || []) {
    const key = `${r.fund}|${r.date}`;
    const cur = best.get(key);
    if (!cur || (CHANGE_RANK[r.change] || 0) > (CHANGE_RANK[cur.change] || 0)) best.set(key, { fund: r.fund, date: r.date, change: r.change });
  }
  return [...best.values()];
}

// Per-article rows → sums per day: readings counted, scores added, and the weights the
// dashboard's Acute score gives each article — source credibility × max(confidence, 0.15) —
// added plain and times the score. Sums, not averages, so two parts of one day add up. Pure.
function sentimentSums(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const date = r.date.toISOString ? r.date.toISOString().slice(0, 10) : String(r.date);
    const d = byDay.get(date) || { date, n_articles: 0, score_sum: 0, w_sum: 0, w_score: 0 };
    const w = sourceWeight(r.source, r.platform) * Math.max(Number(r.confidence) || 0, 0.15);
    d.score_sum += r.score; d.n_articles += 1; d.w_sum += w; d.w_score += w * r.score;
    byDay.set(date, d);
  }
  return [...byDay.values()];
}

// One row per day, oldest first, from the stories still stored (`rows`) plus the sums the
// pruned ones left behind (`pruned`, sentiment_daily rows). avg_score stays the plain mean
// (sentiment_avg, z-score); w_sum / w_score carry the weighting minus the time decay, which
// the engine applies because it depends on the bar being evaluated. Pure.
function dailySentiment(rows, pruned = []) {
  const byDay = new Map();
  for (const p of [...pruned, ...sentimentSums(rows)]) {
    const d = byDay.get(p.date) || { date: p.date, n_articles: 0, score_sum: 0, w_sum: 0, w_score: 0 };
    d.n_articles += Number(p.n_articles); d.score_sum += Number(p.score_sum);
    d.w_sum += Number(p.w_sum); d.w_score += Number(p.w_score);
    byDay.set(p.date, d);
  }
  return [...byDay.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => ({
      date: d.date, avg_score: d.score_sum / d.n_articles, n_articles: d.n_articles,
      w_sum: d.w_sum, w_score: d.w_score,
    }));
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

module.exports = { hasSeniqFactors, seniqDataIfNeeded, seniqDataForWatchlist, dailySentiment, sentimentSums, fundHoldings, READING_COLS };
