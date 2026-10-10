/**
 * IPO Watch — the calendar (IPO_PLAN.md, Change 3).
 *
 * Indian public issues, mainboard and SME, from announcement to after listing. Sources
 * (./sources) each return a list of issues in one plain shape; this file cleans them,
 * merges the same issue seen by two sources, stores them, and works out where each one is
 * in its lifecycle. A source may also give an issue's grey market premium (GMP), which is
 * kept as a dated series and shown only while it is fresh and the issue has not listed, and
 * its subscription (times bid for, by investor class), kept as a series by the day of the
 * figures and always shown with that day. When a listed issue's listing price is first
 * reported it is logged as the issue's outcome, once. The stage is computed from the dates on read, so it is never stale.
 *
 * A source that fails is "no data today": the rows already stored stay as they are.
 */

const { query, execute } = require('../../db');
const { IPO_WATCH } = require('../../config');
const SOURCES = require('./sources');

const STAGES = ['announced', 'upcoming', 'open', 'closed', 'listed', 'withdrawn'];
const BOARDS = ['mainboard', 'sme'];
const MARKETS = ['IN', 'US'];

// Today's date on the exchange's clock, "YYYY-MM-DD". Pure given `now`.
function marketDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IPO_WATCH.TIMEZONE }).format(now);
}

// "Swara Baby Products Ltd." and "SWARA BABY PRODUCTS LIMITED" are one company. Pure.
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(limited|ltd|pvt|private|inc|corp|corporation|plc|llc|the|ipo|sme)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const positive = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null; };

// [{ on, gmp }] with a real date and a real number each, or null when none is left. Pure.
function cleanHistory(list) {
  const out = (Array.isArray(list) ? list : [])
    .filter((h) => h && isoDate(h.on) && typeof h.gmp === 'number' && Number.isFinite(h.gmp))
    .map((h) => ({ on: h.on, gmp: h.gmp }));
  return out.length ? out : null;
}

const SUB_PARTS = ['qib', 'nii', 'nii_small', 'nii_big', 'retail'];
const timesOver = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// A subscription reading as a source gave it → the shape that is stored, or null without a
// total. It remembers its own source: the issue it rides on may come from another. Pure.
function cleanSubscription(sub, source) {
  if (!sub || typeof sub !== 'object' || timesOver(sub.total) == null) return null;
  const out = { observed_on: isoDate(sub.observed_on), total: sub.total, source };
  for (const k of SUB_PARTS) out[k] = timesOver(sub[k]);
  return out;
}

// One issue as a source gave it → the shape that is stored, or null when it cannot be used
// (no name, or a board we do not know). Bad dates and numbers become null, not errors. Pure.
function normalizeIssue(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').replace(/\s+/g, ' ').trim();
  const key = nameKey(name);
  const market = raw.market === 'US' ? 'US' : 'IN';
  // A board is India's: mainboard or SME. A US issue has none.
  const board = market === 'IN' ? String(raw.board || '').toLowerCase() : null;
  if (!key || (market === 'IN' && !BOARDS.includes(board))) return null;

  let open = isoDate(raw.open_date);
  let close = isoDate(raw.close_date);
  if (open && close && close < open) { open = null; close = null; }   // a source mix-up; keep neither
  let low = positive(raw.price_low);
  let high = positive(raw.price_high);
  if (low && high && low > high) [low, high] = [high, low];

  return {
    market, name, name_key: key, board,
    exchange: raw.exchange ? String(raw.exchange).trim() : null,
    symbol: raw.symbol ? String(raw.symbol).trim().toUpperCase() : null,
    open_date: open, close_date: close,
    allotment_date: isoDate(raw.allotment_date),
    listing_date: isoDate(raw.listing_date),
    price_low: low, price_high: high,
    lot_size: positive(raw.lot_size) ? Math.round(positive(raw.lot_size)) : null,
    issue_size_cr: positive(raw.issue_size_cr),
    fresh_issue_cr: positive(raw.fresh_issue_cr),
    ofs_cr: positive(raw.ofs_cr),
    withdrawn: raw.withdrawn === true,
    // US only: the status as the source states it, the day it dates from, and the deal's size.
    source_status: raw.source_status ? String(raw.source_status).toLowerCase() : null,
    status_date: isoDate(raw.status_date),
    shares: positive(raw.shares) ? Math.round(positive(raw.shares)) : null,
    issue_size_usd: positive(raw.issue_size_usd),
    is_spac: raw.is_spac === true,
    // Grey market premium, ₹ per share. Not a column of ipos: it goes to ipo_gmp as a series.
    gmp: typeof raw.gmp === 'number' && Number.isFinite(raw.gmp) ? raw.gmp : null,
    subscription: cleanSubscription(raw.subscription, source),
    // Premiums the source reports for earlier days, and the price it listed at.
    gmp_history: cleanHistory(raw.gmp_history),
    listing_price: positive(raw.listing_price),
    listing_gain_pct: typeof raw.listing_gain_pct === 'number' && Number.isFinite(raw.listing_gain_pct) ? raw.listing_gain_pct : null,
    source, source_ref: raw.source_ref ? String(raw.source_ref) : null,
  };
}

// The same issue from two sources becomes one: the earlier source in the list wins a field
// it has, a later one fills what is missing. Pure.
function mergeIssues(issues) {
  const byKey = new Map();
  for (const it of issues) {
    const key = `${it.market}|${it.name_key}`;                     // the same name in two markets is two companies
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, { ...it }); continue; }
    for (const [k, v] of Object.entries(it)) if (seen[k] == null) seen[k] = v;
    seen.withdrawn = seen.withdrawn || it.withdrawn;
  }
  return [...byKey.values()];
}

// Where an issue is in its life, from its dates alone. `today` is the exchange's date. Pure.
function stageOf(ipo, today = marketDate()) {
  if (ipo.withdrawn) return 'withdrawn';
  // A US issue's source states its status; there are no bidding dates to work from.
  if (ipo.market === 'US') {
    // Priced is not yet trading: it is 'listed' once the price feed has its first day.
    if (ipo.source_status === 'priced') return ipo.first_trade_date ? 'listed' : 'closed';
    return ipo.source_status === 'expected' ? 'upcoming' : 'announced';
  }
  if (ipo.listing_date && ipo.listing_date <= today) return 'listed';
  if (ipo.close_date && ipo.close_date < today) return 'closed';   // subscription over, not yet listed
  if (!ipo.open_date) return 'announced';
  if (ipo.open_date > today) return 'upcoming';
  return 'open';
}

const COLUMNS = ['market', 'name', 'name_key', 'board', 'exchange', 'symbol', 'open_date', 'close_date', 'allotment_date',
  'listing_date', 'price_low', 'price_high', 'lot_size', 'issue_size_cr', 'fresh_issue_cr', 'ofs_cr',
  'withdrawn', 'source', 'source_ref', 'source_status', 'status_date', 'shares', 'issue_size_usd', 'is_spac'];
// On a repeat sighting a field the source no longer gives keeps its stored value.
const KEEP_IF_MISSING = COLUMNS.filter((c) => !['market', 'name_key', 'withdrawn', 'source', 'is_spac'].includes(c));

async function upsertIssues(issues, run = execute) {
  for (const it of issues) {
    await run(
      `INSERT INTO ipos (${COLUMNS.join(', ')})
       VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (market, name_key) DO UPDATE SET
         ${KEEP_IF_MISSING.map((c) => `${c} = COALESCE(EXCLUDED.${c}, ipos.${c})`).join(',\n         ')},
         withdrawn = EXCLUDED.withdrawn, is_spac = EXCLUDED.is_spac, source = EXCLUDED.source, fetched_at = now()`,
      COLUMNS.map((c) => it[c])
    );
  }
  return issues.length;
}

// Grey market trading ends when an issue lists, so a premium is only a reading before that.
const PRE_LISTING = ['announced', 'upcoming', 'open', 'closed'];
const gmpReadings = (issues, today) => issues.filter((it) => it.gmp != null && PRE_LISTING.includes(stageOf(it, today)));

// One reading per issue, per source, per market day; a later poll that day replaces it.
async function recordGmp(readings, today, run = execute) {
  for (const it of readings) {
    await run(
      `INSERT INTO ipo_gmp (ipo_id, observed_on, gmp, source)
       SELECT id, $2::date, $3, $4 FROM ipos WHERE name_key = $1 AND market = $5
       ON CONFLICT (ipo_id, source, observed_on) DO UPDATE SET gmp = EXCLUDED.gmp, fetched_at = now()`,
      [it.name_key, today, it.gmp, it.source, it.market]
    );
  }
  return readings.length;
}

// Premiums the source reports for earlier days (the open, the close, listing day). They fill
// days we did not see; a reading we took ourselves on that day is never replaced.
async function recordGmpHistory(issues, run = execute) {
  let n = 0;
  for (const it of issues) {
    for (const h of it.gmp_history || []) {
      const r = await run(
        `INSERT INTO ipo_gmp (ipo_id, observed_on, gmp, source)
         SELECT id, $2::date, $3, $4 FROM ipos WHERE name_key = $1 AND market = $5
         ON CONFLICT (ipo_id, source, observed_on) DO NOTHING`,
        [it.name_key, h.on, h.gmp, it.source, it.market]
      );
      n += (r && r.rowCount) || 0;
    }
  }
  return n;
}

// The issues whose outcome can be logged: listed, with a listing price or gain reported. Pure.
const outcomesOf = (issues, today) => issues.filter((it) => (it.listing_price != null || it.listing_gain_pct != null) && stageOf(it, today) === 'listed');

// Listing gain over the issue price, in percent to two places; null without an issue price. Pure.
function listingGain(listingPrice, issuePrice) {
  return issuePrice ? Math.round((listingPrice / issuePrice - 1) * 10000) / 100 : null;
}

// The price an issue listed at, worked back from its issue price and the gain. Pure.
function priceFromGain(issuePrice, gainPct) {
  return issuePrice && gainPct != null ? Math.round(issuePrice * (1 + gainPct / 100) * 100) / 100 : null;
}

// One row per issue, written the first time its listing result is seen and then left alone.
// The issue price is the stored one, so an issue first met after listing still gets a gain.
// With a price, the gain is worked out from it; with only a gain, the price is worked back
// and marked derived.
async function recordOutcomes(issues, run = execute, read = query) {
  let n = 0;
  for (const it of issues) {
    const ipo = (await read('SELECT id, price_high::float8 AS price_high FROM ipos WHERE name_key = $1 AND market = $2', [it.name_key, it.market]))[0];
    if (!ipo) continue;
    const derived = it.listing_price == null;
    const price = derived ? priceFromGain(ipo.price_high, it.listing_gain_pct) : it.listing_price;
    const gain = derived ? it.listing_gain_pct : listingGain(it.listing_price, ipo.price_high) ?? it.listing_gain_pct;
    const r = await run(
      `INSERT INTO ipo_outcomes (ipo_id, issue_price, listing_price, listing_gain_pct, price_derived, source)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (ipo_id) DO NOTHING`,
      [ipo.id, ipo.price_high, price, gain, derived && price != null, it.source]
    );
    n += (r && r.rowCount) || 0;
  }
  return n;
}

// One reading per issue, per source, per day the figures are as of (today when the source
// does not say). Seeing the same final figure again changes nothing but fetched_at.
async function recordSubscriptions(issues, today, run = execute) {
  const cols = ['total', ...SUB_PARTS];
  for (const it of issues) {
    const sub = it.subscription;
    await run(
      `INSERT INTO ipo_subscriptions (ipo_id, observed_on, source, ${cols.join(', ')})
       SELECT id, $2::date, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')} FROM ipos WHERE name_key = $1 AND market = $${cols.length + 4}
       ON CONFLICT (ipo_id, source, observed_on) DO UPDATE SET
         ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, fetched_at = now()`,
      [it.name_key, sub.observed_on || today, sub.source, ...cols.map((c) => sub[c]), it.market]
    );
  }
  return issues.length;
}

// What the calendar says about an issue's GMP. `row` carries the latest reading (gmp,
// gmp_at) and the one before it (gmp_prev). Nothing is shown once the issue has listed, or
// when the latest reading is older than GMP_STALE_HOURS. Pure.
function gmpView(row, stage, now = new Date()) {
  const none = { gmp: null, gmp_pct: null, gmp_prev: null, gmp_at: null, gmp_source: null };
  if (row.gmp == null || !PRE_LISTING.includes(stage)) return none;
  if (now - new Date(row.gmp_at) > IPO_WATCH.GMP_STALE_HOURS * 3600e3) return none;
  return {
    gmp: row.gmp,
    // As a share of the top of the price band — the figure GMP is usually quoted against.
    gmp_pct: row.price_high ? Math.round((row.gmp / row.price_high) * 1000) / 10 : null,
    gmp_prev: row.gmp_prev ?? null,
    gmp_at: row.gmp_at,
    gmp_source: row.gmp_source,
  };
}

// Ask every source once, store what came back. Never throws: a source that fails is
// reported in `failed` and skipped.
async function pollCalendar({
  sources = SOURCES, save = upsertIssues, saveGmp = recordGmp, saveGmpHistory = recordGmpHistory,
  saveSubscriptions = recordSubscriptions, saveOutcomes = recordOutcomes,
  today = marketDate(), delayMs = IPO_WATCH.REQUEST_DELAY_MS,
} = {}) {
  const found = [];
  const failed = [];
  for (const [n, src] of sources.entries()) {
    if (n > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const raw = await src.fetchIssues({ today });
      for (const r of raw || []) {
        const it = normalizeIssue(r, src.name);
        if (it) found.push(it);
      }
    } catch (err) {
      failed.push({ source: src.name, error: err.message });
    }
  }
  const issues = mergeIssues(found);
  const stored = issues.length ? await save(issues) : 0;
  const readings = gmpReadings(issues, today);
  const gmp = readings.length ? await saveGmp(readings, today) : 0;
  const subscribed = issues.filter((it) => it.subscription);
  const subscriptions = subscribed.length ? await saveSubscriptions(subscribed, today) : 0;
  const withHistory = issues.filter((it) => it.gmp_history);
  const gmpHistory = withHistory.length ? await saveGmpHistory(withHistory) : 0;
  const listed = outcomesOf(issues, today);
  const outcomes = listed.length ? await saveOutcomes(listed) : 0;
  return { sources: sources.length, stored, gmp, gmpHistory, subscriptions, outcomes, failed };
}

const dateCol = (c) => `${c}::text AS ${c}`;
const numCol = (c) => `${c}::float8 AS ${c}`;

// The calendar as the screen shows it: everything not yet listed, plus issues that listed
// in the last RECENT_LISTED_DAYS. An issue that closed long ago with no listing date on record
// is left off: listing follows the close within days, so the source has lost track of it. board = 'mainboard' | 'sme' | 'all'.
async function listCalendar({ market = 'IN', board = 'mainboard', spacs = false, stage = null, today = marketDate(), run = query } = {}) {
  const rows = await run(
    `SELECT i.id, market, name, board, exchange, symbol,
            ${['open_date', 'close_date', 'allotment_date', 'listing_date'].map(dateCol).join(', ')},
            ${['price_low', 'price_high', 'issue_size_cr', 'fresh_issue_cr', 'ofs_cr'].map(numCol).join(', ')},
            lot_size, withdrawn, i.source, source_ref, i.fetched_at,
            source_status, status_date::text AS status_date, shares::float8 AS shares,
            issue_size_usd::float8 AS issue_size_usd, is_spac, first_trade_date::text AS first_trade_date,
            g.gmp::float8 AS gmp, g.fetched_at AS gmp_at, g.source AS gmp_source,
            s.total::float8 AS sub_total, s.qib::float8 AS sub_qib, s.nii::float8 AS sub_nii,
            s.retail::float8 AS sub_retail, s.observed_on::text AS sub_on, s.source AS sub_source,
            o.listing_price::float8 AS listing_price, o.listing_gain_pct::float8 AS listing_gain_pct,
            o.price_derived AS listing_price_derived,
            o.ret_listing_day_pct::float8 AS ret_listing_day_pct, o.ret_1w_pct::float8 AS ret_1w_pct,
            o.ret_1m_pct::float8 AS ret_1m_pct, o.ret_3m_pct::float8 AS ret_3m_pct,
            (i.graduated_at IS NOT NULL) AS graduated,
            (SELECT count(*)::int FROM ipo_articles x WHERE x.ipo_id = i.id) AS stories,
            (SELECT p.gmp::float8 FROM ipo_gmp p
              WHERE p.ipo_id = i.id AND p.source = g.source AND p.observed_on < g.observed_on
              ORDER BY p.observed_on DESC LIMIT 1) AS gmp_prev
       FROM ipos i
       LEFT JOIN LATERAL (
         SELECT * FROM ipo_gmp WHERE ipo_id = i.id ORDER BY observed_on DESC, fetched_at DESC LIMIT 1
       ) g ON true
       LEFT JOIN ipo_outcomes o ON o.ipo_id = i.id
       LEFT JOIN LATERAL (
         SELECT * FROM ipo_subscriptions WHERE ipo_id = i.id ORDER BY observed_on DESC, fetched_at DESC LIMIT 1
       ) s ON true
      WHERE market = $5
        AND (market = 'US' OR $1 = 'all' OR board = $1)
        AND ($6::boolean OR NOT is_spac)
        AND (listing_date IS NULL OR listing_date >= $2::date - $3::int)
        AND (listing_date IS NULL AND close_date < $2::date - $4::int) IS NOT TRUE
        -- A US issue with no listing day (filed, withdrawn) ages out by the day of its status.
        AND (market = 'IN' OR listing_date IS NOT NULL OR COALESCE(status_date, i.created_at::date) >= $2::date - $3::int)
      ORDER BY COALESCE(first_trade_date, listing_date, open_date, status_date) DESC NULLS FIRST, name`,
    [board, today, IPO_WATCH.RECENT_LISTED_DAYS, IPO_WATCH.UNLISTED_AFTER_CLOSE_DAYS, market, spacs]
  );
  const out = rows.map((r) => { const stage = stageOf(r, today); return { ...r, stage, ...gmpView(r, stage) }; });
  return stage ? out.filter((r) => r.stage === stage) : out;
}

// When a market's calendar was last refreshed from its source, and whether that is long
// enough ago that the page should say so. null before the first poll.
async function calendarAge(market = 'IN', { now = new Date(), run = query } = {}) {
  const row = (await run('SELECT max(fetched_at) AS at FROM ipos WHERE market = $1', [market]))[0];
  const at = row && row.at ? new Date(row.at) : null;
  return { updatedAt: at, stale: !at || now - at > IPO_WATCH.STALE_AFTER_HOURS * 3600e3 };
}

module.exports = { STAGES, BOARDS, MARKETS, marketDate, nameKey, calendarAge, normalizeIssue, mergeIssues, stageOf, upsertIssues, cleanSubscription, cleanHistory, gmpReadings, recordGmp, recordGmpHistory, recordSubscriptions,
  outcomesOf, listingGain, priceFromGain, recordOutcomes, gmpView, pollCalendar, listCalendar };
