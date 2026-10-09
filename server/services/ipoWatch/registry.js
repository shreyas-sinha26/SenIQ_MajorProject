/**
 * IPO Watch — the pre-listing registry (IPO_PLAN.md, Change 3).
 *
 * Before it lists, a company has no ticker, so the entity resolver cannot see it and its
 * news reaches no one. Here the ipos table stands in for the company reference: stored
 * stories are matched to an issue by its name (or a hand-added alias) and linked to it, and
 * once the issue lists, its row is given the ticker the exchange assigned.
 *
 * Matching is strict, like the resolver's listed tier: a full multi-word name is enough on
 * its own; a one-word name or an alias counts only in a story that is plainly about an IPO.
 */

const { query, execute } = require('../../db');
const { IPO_WATCH } = require('../../config');
const { nameKey, marketDate } = require('./index');

// Lower case, punctuation to spaces, padded so " phrase " finds whole words only. Pure.
function normText(s) {
  return ` ${String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

// "r k fashion accessories" → "rk fashion accessories": initials the news writes together. Pure.
const joinInitials = (key) => key.replace(/\b([a-z])(?: ([a-z])\b)+/g, (m) => m.replace(/ /g, ''));

// Words that make a story plainly about a public issue.
// Kept narrow: "lists", "listed" and "subscribers" turn up in ordinary company news.
const IPO_CONTEXT = /\b(ipos?|listing|debuts?|gmp|grey market|(over)?subscribed|price band|allotment|d?rhp|anchor investors?|public (issue|offer))\b/i;

// The issues → match(title, summary) → [{ id, matched_on }]. Pure.
function buildMatcher(ipos) {
  const entries = ipos.map((ipo) => {
    const key = ipo.name_key || nameKey(ipo.name);
    const names = [...new Set([key, joinInitials(key)])].filter(Boolean);
    return {
      id: ipo.id,
      names: names.map((n) => ` ${n} `),
      oneWord: !joinInitials(key).includes(' '),
      aliases: (ipo.aliases || []).map((a) => normText(a)).filter((a) => a.trim()),
    };
  });
  return function match(title, summary = '') {
    const raw = `${title || ''} ${summary || ''}`;
    const text = normText(raw);
    const aboutIpo = IPO_CONTEXT.test(raw);
    const out = [];
    for (const e of entries) {
      if (e.names.some((n) => text.includes(n)) && (!e.oneWord || aboutIpo)) out.push({ id: e.id, matched_on: 'name' });
      else if (aboutIpo && e.aliases.some((a) => text.includes(a))) out.push({ id: e.id, matched_on: 'alias' });
    }
    return out;
  };
}

// Link the stories fetched in the last `days` to the issues they are about. Issues stay
// matchable until MATCH_AFTER_LISTING_DAYS after listing. Safe to run again: a link is
// made once.
async function linkArticles({ days = IPO_WATCH.LINK_WINDOW_DAYS, today = marketDate() } = {}) {
  const ipos = await query(
    `SELECT id, name, name_key, aliases FROM ipos
      WHERE NOT withdrawn AND (listing_date IS NULL OR listing_date >= $1::date - $2::int)`,
    [today, IPO_WATCH.MATCH_AFTER_LISTING_DAYS]
  );
  if (!ipos.length) return { checked: 0, linked: 0 };
  const match = buildMatcher(ipos);
  const articles = await query(
    // By when a story was fetched, not published: a followed ticker's news arrives days old.
    `SELECT id, title, summary FROM articles WHERE fetched_at >= now() - make_interval(days => $1::int)`,
    [days]
  );
  let linked = 0;
  for (const a of articles) {
    for (const m of match(a.title, a.summary)) {
      const r = await execute(
        'INSERT INTO ipo_articles (ipo_id, article_id, matched_on) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [m.id, a.id, m.matched_on]
      );
      linked += r.rowCount || 0;
    }
  }
  return { checked: articles.length, linked };
}

// Replace an issue's hand-added aliases. The issue is found by its name.
async function setAliases(name, aliases) {
  const clean = [...new Set(aliases.map((a) => String(a).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const r = await execute('UPDATE ipos SET aliases = $2 WHERE name_key = $1 RETURNING name', [nameKey(name), clean]);   // either market
  if (!r.rowCount) throw new Error(`no issue named "${name}" on the calendar`);
  return { name: r.rows[0].name, aliases: clean };
}

// "Orient Cables (India) Limited" and "Orient Cables" are one company. Pure.
const looseKey = (name) => nameKey(name).replace(/\bindia\b/g, ' ').replace(/\s+/g, ' ').trim();

// Yahoo's search results for an issue's name → { symbol, exchange } when one or both Indian
// exchanges list a share under that name, else null. The calendar often carries a short
// name ("German Green Steel" for "German Green Steel and Power Limited"), so a name of two
// words or more may also be the start of the listed one — but only when every such share
// is the same company. Pure.
function pickSymbol(ipoName, quotes) {
  const want = looseKey(ipoName);
  const indian = (quotes || []).filter((q) => q && q.quoteType === 'EQUITY' && /\.(NS|BO)$/.test(q.symbol || ''));
  const named = (test) => indian.filter((q) => [q.longname, q.shortname].some((n) => n && test(looseKey(n))));
  let hits = named((n) => n === want);
  if (!hits.length && want.includes(' ')) hits = named((n) => n.startsWith(`${want} `));
  const bare = (q) => q.symbol.replace(/\.(NS|BO)$/, '');            // stored bare, like every ticker
  if (!hits.length || new Set(hits.map(bare)).size > 1) return null;
  const nse = hits.find((q) => q.symbol.endsWith('.NS'));
  const bse = hits.find((q) => q.symbol.endsWith('.BO'));
  return { symbol: bare(nse || bse), exchange: nse && bse ? 'BSE, NSE' : nse ? 'NSE' : 'BSE' };
}

async function searchYahoo(name) {
  const res = await fetch(`${IPO_WATCH.YAHOO_SEARCH_URL}?q=${encodeURIComponent(name)}&quotesCount=6&newsCount=0`, {
    headers: { 'User-Agent': IPO_WATCH.USER_AGENT }, signal: AbortSignal.timeout(IPO_WATCH.TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Yahoo search replied ${res.status}`);
  return (await res.json()).quotes || [];
}

// Give listed issues their ticker. Each is looked up at most once a day, a capped number a
// run (mainboard first — Yahoo carries those), and only for SYMBOL_LOOKUP_DAYS after listing — an issue Yahoo does not carry (many SME ones) is then
// left without one. Never throws.
async function linkSymbols({ today = marketDate(), search = searchYahoo, delayMs = IPO_WATCH.REQUEST_DELAY_MS } = {}) {
  const due = await query(
    `SELECT id, name, exchange FROM ipos
      WHERE market = 'IN' AND symbol IS NULL AND NOT withdrawn   -- a US issue's ticker comes with it
        AND listing_date <= $1::date AND listing_date >= $1::date - $2::int
        AND (symbol_checked_at IS NULL OR symbol_checked_at < now() - interval '20 hours')
      ORDER BY (board = 'mainboard') DESC, listing_date DESC
      LIMIT $3::int`,
    [today, IPO_WATCH.SYMBOL_LOOKUP_DAYS, IPO_WATCH.SYMBOL_LOOKUPS_PER_RUN]
  );
  let found = 0;
  let error = null;
  for (const [n, ipo] of due.entries()) {
    if (n > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    let hit;
    try { hit = pickSymbol(ipo.name, await search(ipo.name)); }
    catch (err) { error = err.message; break; }                    // refused or down: stop asking this run
    await execute(
      'UPDATE ipos SET symbol = $2, exchange = COALESCE(exchange, $3), symbol_checked_at = now() WHERE id = $1',
      [ipo.id, hit ? hit.symbol : null, hit ? hit.exchange : null]
    );
    if (hit) found++;
  }
  return { due: due.length, found, error };
}

// Whether the price feed backs an Indian issue's ticker: it has a price on the listing day,
// and its opening price agrees with the listing price the source gave. Where one of the two
// prices is missing, the listing-day price alone is taken. Pure.
function priceConfirms(o, tolerance = IPO_WATCH.GRADUATE_PRICE_TOLERANCE) {
  if (o.close_listing_day == null) return false;
  if (o.open_listing_day == null || !o.listing_price) return true;
  return Math.abs(o.open_listing_day / o.listing_price - 1) <= tolerance;
}

// The exchange code the company reference uses: NSE or BSE for India, 'US' for the US. Pure.
function referenceExchange(market, exchange) {
  if (market === 'US') return 'US';
  return /NSE/.test(exchange || '') ? 'NSE' : 'BSE';
}

// Graduate listed issues into the company reference (tier 'ipo'), so the company can be
// searched, held, priced and matched to news after IPO Watch lets go of it. An issue
// graduates once its ticker is confirmed by a price: for India the check in priceConfirms,
// for the US a first trading day on record. SPACs never do. A ticker already in the
// reference is left as it is — the issue is marked graduated when that row is the same
// company, and noted and skipped when it is another one.
async function graduate() {
  const rows = await query(
    `SELECT i.id, i.market, i.name, i.symbol, i.exchange, i.first_trade_date,
            o.open_listing_day::float8 AS open_listing_day, o.close_listing_day::float8 AS close_listing_day,
            o.listing_price::float8 AS listing_price
       FROM ipos i LEFT JOIN ipo_outcomes o ON o.ipo_id = i.id
      WHERE i.symbol IS NOT NULL AND i.graduated_at IS NULL AND i.graduation_note IS NULL
        AND NOT i.withdrawn AND NOT i.is_spac`
  );
  const out = { graduated: 0, existing: 0, clashes: 0 };
  for (const r of rows) {
    if (r.market === 'US' ? !r.first_trade_date : !priceConfirms(r)) continue;
    const there = (await query('SELECT name, tier FROM companies WHERE ticker = $1', [r.symbol]))[0];
    if (there) {
      const a = looseKey(there.name);
      const b = looseKey(r.name);
      if (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) {
        await execute('UPDATE ipos SET graduated_at = now() WHERE id = $1', [r.id]);
        out.existing++;
      } else {
        await execute('UPDATE ipos SET graduation_note = $2 WHERE id = $1', [r.id, `ticker ${r.symbol} is ${there.name} in the reference`]);
        out.clashes++;
      }
      continue;
    }
    await execute(
      `INSERT INTO companies (ticker, name, asset_class, exchange, country, is_active, tier, updated_at)
       VALUES ($1, $2, 'equity', $3, $4, true, 'ipo', now()) ON CONFLICT (ticker) DO NOTHING`,
      [r.symbol, r.name, referenceExchange(r.market, r.exchange), r.market]
    );
    await execute('UPDATE ipos SET graduated_at = now() WHERE id = $1', [r.id]);
    out.graduated++;
  }
  return out;
}

// The US issues whose company news the pipeline should fetch: the newest few with a ticker
// (Finnhub tags its news by ticker, and a filing or pricing is when it is written about).
async function monitoredTickers({ today = marketDate() } = {}) {
  const rows = await query(
    `SELECT symbol FROM ipos
      WHERE market = 'US' AND symbol IS NOT NULL AND NOT is_spac AND NOT withdrawn
        AND COALESCE(first_trade_date, listing_date, status_date) >= $1::date - $2::int
      ORDER BY (source_status IN ('expected', 'priced')) DESC, COALESCE(first_trade_date, listing_date, status_date) DESC
      LIMIT $3::int`,
    [today, IPO_WATCH.MONITOR_DAYS, IPO_WATCH.MONITOR_TICKERS]
  );
  return rows.map((r) => r.symbol);
}

module.exports = { normText, joinInitials, buildMatcher, linkArticles, setAliases, looseKey, pickSymbol, linkSymbols, monitoredTickers, priceConfirms, referenceExchange, graduate };
