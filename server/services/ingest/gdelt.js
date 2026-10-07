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
const { UNIVERSE } = require('../../data/universe');
const { hashId, clampText, fetchWithTimeout } = require('./util');

// Tickers whose news GDELT exists to cover: every Indian name in the curated universe
// (Finnhub's company feed is US-centric). This was a hand-kept list of 11; names added to the
// universe since then got no targeted query.
const INDIA_NAMES = new Map(UNIVERSE.filter((c) => c.country === 'IN').map((c) => [c.ticker, c.name]));
const INDIA_TICKERS = new Set(INDIA_NAMES.keys());

/**
 * GDELT search term for an Indian ticker: the short everyday name where one is known
 * ("reliance", "tcs"), else the company name — as an exact phrase when it is plain words
 * ("Asian Paints"), or as its distinctive words when it has punctuation that a phrase search
 * would trip on ("Larsen & Toubro" → Larsen Toubro; GDELT ANDs bare words). Pure.
 */
function indiaTerm(ticker) {
  const known = TICKER_ALIASES[ticker] && TICKER_ALIASES[ticker][0];
  if (known) return known;
  const name = String(INDIA_NAMES.get(ticker) || ticker).trim();
  if (/^[A-Za-z0-9 ]+$/.test(name)) return name.includes(' ') ? `"${name}"` : name;
  const words = name.replace(/['’]s\b/g, '').split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 4);
  return [...new Set(words)].join(' ') || ticker;
}

/**
 * Which held Indian names to query this run. At most `max`; when more are held, a window
 * starting at `cursor` rotates through them so every name is covered within a few runs.
 * Returns { tickers, next } — pass `next` back as the cursor on the following run. Pure.
 */
function indiaBatch(tickers, cursor = 0, max = INGEST.GDELT_INDIA_MAX_PER_RUN) {
  const held = [...new Set(tickers)].filter((t) => INDIA_TICKERS.has(t)).sort();
  if (held.length <= max) return { tickers: held, next: 0 };
  const start = cursor % held.length;
  const picked = Array.from({ length: max }, (_, i) => held[(start + i) % held.length]);
  return { tickers: picked, next: (start + max) % held.length };
}

let indiaCursor = 0; // in-memory: a restart just begins the rotation again

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

  // India coverage — only names that are actually held, capped per run (see indiaBatch).
  const batch = indiaBatch(tickers, indiaCursor);
  indiaCursor = batch.next;
  for (const t of batch.tickers) queries.push({ q: indiaTerm(t), platform: 'news' });

  // Run in parallel — each call already degrades to [] on 429/timeout, so the
  // whole GDELT step is bounded by one ~6s timeout instead of N sequential ones.
  const settled = await Promise.allSettled(queries.map(({ q, platform }) => runQuery(q, platform)));
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

module.exports = { fetchGdelt, INDIA_TICKERS, indiaTerm, indiaBatch };
