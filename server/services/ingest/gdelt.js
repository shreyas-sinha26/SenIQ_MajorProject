/**
 * GDELT DOC 2.0 ingestion (Phase 2b) — free, no key, strong global + India coverage.
 * Two roles:
 *   - macro: a fixed set of war/budget/rates queries → platform 'macro' (→ __MARKET__)
 *   - india: company-name queries for India tickers Finnhub's US-centric feed misses
 * GDELT rate-limits aggressively (one request every 5 seconds, HTTP 429 beyond that) and is
 * slow (10 to 12 seconds a request), so a run asks one query at a time, spaced, inside a
 * time budget; a failed query gives an empty list and the run says why (see fetchGdelt).
 */

const { INGEST } = require('../../config');
const { TICKER_ALIASES } = require('../tickerMatcher');
const { UNIVERSE } = require('../../data/universe');
const { hashId, clampText, fetchWithTimeout } = require('./util');

// Tickers whose news GDELT exists to cover: every Indian name in the curated universe
// (Finnhub's company feed is US-centric). This was a hand-kept list of 11; names added to the
// universe since then got no targeted query.
// Listed-tier Indian names (the Nifty 500 beyond the curated ones) are covered the same way
// once someone holds them, under the name a headline would use.
const LISTED_INDIA = require('../../data/listed.json').companies.filter((c) => c.country === 'IN');
const INDIA_NAMES = new Map([
  ...LISTED_INDIA.map((c) => [c.ticker, c.core]),
  ...UNIVERSE.filter((c) => c.country === 'IN').map((c) => [c.ticker, c.name]),
]);
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

// One query. → { articles, problem }: problem is null, or why nothing came back
// ('HTTP 429', 'timed out', 'no connection', 'not JSON'), so a run can say what happened.
async function runQuery(queryStr, platform) {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(queryStr)}` +
    `&mode=ArtList&format=json&sort=DateDesc` +
    `&maxrecords=${INGEST.GDELT_MAX_RECORDS}&timespan=${INGEST.GDELT_TIMESPAN}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'seniq/0.1' } }, INGEST.GDELT_TIMEOUT_MS);
    if (!res.ok) return { articles: [], problem: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data) return { articles: [], problem: 'not JSON' };
    const arts = data.articles || [];
    return {
      problem: null,
      articles: arts
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
        })),
    };
  } catch (err) {
    return { articles: [], problem: err && err.name === 'AbortError' ? 'timed out' : 'no connection' };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// "2 HTTP 429, 1 timed out" from a list of problems. Pure.
function tallyProblems(problems) {
  const counts = {};
  for (const p of problems) counts[p] = (counts[p] || 0) + 1;
  return Object.entries(counts).map(([p, n]) => `${n} ${p}`).join(', ');
}

/**
 * One run's GDELT queries, ONE AT A TIME: the macro queries first, then the held Indian
 * names, starting where the last run stopped. A request starts at least GDELT_GAP_MS after
 * the last one was answered (GDELT refuses more than one every 5 seconds), and the step ends at GDELT_BUDGET_MS so a
 * slow GDELT cannot hold the pipeline: the names not reached go first next run.
 * A refused or failed query gives no stories and the run goes on; one line says what happened.
 *
 * @param {string[]} tickers tickers across all portfolios (used to target India queries)
 * `ask`, `wait` and `now` are injectable for tests.
 */
async function fetchGdelt(tickers = [], { ask = runQuery, wait = sleep, now = Date.now } = {}) {
  // Macro layer — broad market drivers.
  const macro = INGEST.GDELT_MACRO_QUERIES.map((q) => ({ q, platform: 'macro' }));

  // India coverage — only names that are actually held, capped per run, in rotation.
  const held = [...new Set(tickers)].filter((t) => INDIA_TICKERS.has(t)).sort();
  const start = held.length ? indiaCursor % held.length : 0;
  const names = held.slice(start).concat(held.slice(0, start)).slice(0, INGEST.GDELT_INDIA_MAX_PER_RUN);
  const queries = [...macro, ...names.map((t) => ({ q: indiaTerm(t), platform: 'news', india: true }))];

  const began = now();
  const articles = [];
  const problems = [];
  let asked = 0;
  let askedIndia = 0;
  let lastEnd = null;
  for (const query of queries) {
    // The gap runs from the END of the last answer. GDELT takes 10 to 14 seconds over one,
    // so a gap counted from its start was already over when the answer came and the next
    // request went out at once: asked that way by hand, it was refused.
    if (lastEnd != null) {
      const gap = INGEST.GDELT_GAP_MS - (now() - lastEnd);
      if (gap > 0) await wait(gap);
    }
    if (now() - began >= INGEST.GDELT_BUDGET_MS) break;
    const r = await ask(query.q, query.platform);
    lastEnd = now();
    asked++;
    if (query.india) askedIndia++;
    if (r.problem) problems.push(r.problem);
    articles.push(...r.articles);
  }
  indiaCursor = held.length ? (start + askedIndia) % held.length : 0;

  const left = queries.length - asked;
  if (problems.length || left) {
    console.warn(`   ⚠️  GDELT: ${articles.length} stories from ${asked - problems.length} of ${queries.length} queries` +
      `${problems.length ? ` (${tallyProblems(problems)})` : ''}${left ? `; ${left} not reached in ${Math.round(INGEST.GDELT_BUDGET_MS / 1000)}s, first next run` : ''}`);
  }
  return articles;
}

module.exports = { fetchGdelt, runQuery, tallyProblems, INDIA_TICKERS, indiaTerm, indiaBatch };
