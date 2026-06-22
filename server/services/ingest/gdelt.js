/**
 * GDELT DOC 2.0 ingestion (Phase 2b) — free, no key, strong global + India coverage.
 * Two roles:
 *   - macro: a fixed set of war/budget/rates queries → platform 'macro' (→ __MARKET__)
 *   - india: company-name queries for India tickers Finnhub's US-centric feed misses
 * GDELT rate-limits aggressively (HTTP 429); we keep calls few, sequential, and
 * degrade to an empty list on any error so the pipeline never hangs on it.
 */

const { INGEST } = require('../../config');
const { TICKER_ALIASES } = require('../tickerMatcher');
const { hashId, clampText, fetchWithTimeout } = require('./util');

// Tickers whose news GDELT/RSS exist to cover (NSE/BSE names).
const INDIA_TICKERS = new Set([
  'RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'WIPRO', 'ICICIBANK',
  'SBIN', 'BHARTIARTL', 'ITC', 'TATAMOTORS', 'ADANIENT',
]);

// "20240601T120000Z" → ISO string.
function parseSeenDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || '');
  if (!m) return new Date().toISOString();
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)).toISOString();
}

async function runQuery(queryStr, platform) {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(queryStr)}` +
    `&mode=ArtList&format=json&sort=DateDesc` +
    `&maxrecords=${INGEST.GDELT_MAX_RECORDS}&timespan=${INGEST.GDELT_TIMESPAN}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'seniq/0.1' } }, 6000);
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const arts = (data && data.articles) || [];
    return arts
      .filter((a) => a.url && a.title)
      .map((a) => ({
        external_id: hashId('gdelt', a.url),
        title: clampText(a.title, 300),
        summary: '',
        source: a.domain || 'GDELT',
        url: a.url,
        image_url: a.socialimage || '',
        published_at: parseSeenDate(a.seendate),
        platform,
      }));
  } catch {
    return [];
  }
}

/**
 * @param {string[]} tickers tickers across all portfolios (used to target India queries)
 */
async function fetchGdelt(tickers = []) {
  // Macro layer — broad market drivers.
  const queries = INGEST.GDELT_MACRO_QUERIES.map((q) => ({ q, platform: 'macro' }));

  // India coverage — only query names that are actually held, to stay under rate limits.
  for (const t of tickers.filter((t) => INDIA_TICKERS.has(t))) {
    const term = (TICKER_ALIASES[t] && TICKER_ALIASES[t][0]) || t;
    queries.push({ q: term, platform: 'news' });
  }

  // Run in parallel — each call already degrades to [] on 429/timeout, so the
  // whole GDELT step is bounded by one ~6s timeout instead of N sequential ones.
  const settled = await Promise.allSettled(queries.map(({ q, platform }) => runQuery(q, platform)));
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

module.exports = { fetchGdelt, INDIA_TICKERS };
