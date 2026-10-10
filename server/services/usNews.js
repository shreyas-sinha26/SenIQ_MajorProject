/**
 * US coverage (plan step P6): company news for the US shares nobody holds.
 *
 * The per-company fetch runs for held tickers only, and the general feeds are Indian and
 * crypto outlets, so a US share nobody holds has almost no stories. With US_LISTED_NEWS=1
 * each run of the news pipeline also asks Finnhub for the company news of a few such shares,
 * the ones checked longest ago (companies.news_checked_at), so all of them come round in turn.
 *
 * Two rules keep the extra volume from reaching anyone it should not:
 *   - a US listed name is tagged only on a story from its own ticker's feed, and only if the
 *     story names it (entityResolver; the feed alone is not enough: about half of what
 *     Finnhub files under a ticker does not name the company);
 *   - a story the rotation alone brought in is stored only if it is about a company. Without
 *     this a market or world keyword in its headline would put it in every user's feed.
 */

const { FEATURES, US_NEWS } = require('../config');
const { isUsListed } = require('./entityResolver');
const { subjectTickers } = require('./newsRelevance');

const enabled = () => FEATURES.US_LISTED_NEWS && !!process.env.FINNHUB_API_KEY;

// How many names this run's rotation takes: what is left of the run's news calls once the
// held and IPO Watch tickers have theirs. Pure.
function batchSize(ownCalls, limits = US_NEWS) {
  return Math.max(0, Math.min(limits.PER_RUN, limits.CALLS_PER_RUN - ownCalls));
}

// This run's names: the active US shares the run does not already ask for (`fetched`: the
// held and IPO Watch tickers), never-checked first, then the longest unchecked.
async function nextBatch(fetched = []) {
  if (!enabled()) return [];
  const own = [...new Set(fetched)];
  const n = batchSize(own.length);
  if (!n) return [];
  const { query } = require('../db');
  const rows = await query(
    `SELECT ticker FROM companies
      WHERE is_active AND country = 'US' AND asset_class = 'equity' AND NOT (ticker = ANY($1))
      ORDER BY news_checked_at NULLS FIRST, ticker
      LIMIT $2`,
    [own, n]
  );
  return rows.map((r) => r.ticker);
}

async function markChecked(tickers = []) {
  if (!tickers.length) return;
  const { execute } = require('../db');
  await execute('UPDATE companies SET news_checked_at = now() WHERE ticker = ANY($1)', [tickers]);
}

// Where the rotation stands: the names in it, how many have never been checked, and the
// oldest and newest check.
async function status(fetched = []) {
  const { queryOne } = require('../db');
  return queryOne(
    `SELECT count(*)::int AS names, count(*) FILTER (WHERE news_checked_at IS NULL)::int AS never,
            min(news_checked_at) AS oldest, max(news_checked_at) AS newest
       FROM companies
      WHERE is_active AND country = 'US' AND asset_class = 'equity' AND NOT (ticker = ANY($1))`,
    [[...new Set(fetched)]]
  );
}

/**
 * Stored stories that have now turned up in the feed of a US listed name they were not
 * fetched for before: external_id → those tickers. Such a story is read once more, because
 * the name could not be tagged on it until it came from that name's own feed. Pure.
 * `stored` = [{ external_id, feeds }] for the fetched stories already in the table.
 */
function gainedFeeds(articles, stored) {
  const have = new Map(stored.map((r) => [r.external_id, new Set(r.feeds || [])]));
  const out = new Map();
  for (const a of articles) {
    const had = have.get(a.external_id);
    if (!had) continue;
    const add = (a.feeds || []).filter((t) => !had.has(t) && isUsListed(t));
    if (add.length) out.set(a.external_id, add);
  }
  return out;
}

// Whether a fetched story goes on to be read and stored, before its tone is read: a story the
// rotation alone brought in must be about a company (a roundup that lists ten is about none). Pure.
function worthReading(article, tickers, inHeadline) {
  return !article.rotationOnly || subjectTickers(article.title, tickers, inHeadline).length > 0;
}

module.exports = { enabled, batchSize, nextBatch, markChecked, status, gainedFeeds, worthReading };
