/**
 * IPO Watch — returns after listing (IPO_PLAN.md, Change 5).
 *
 * Once a listed issue has a ticker (registry.js), its daily prices are read from Yahoo's
 * chart route — the one priceService already uses for Indian shares — and the outcome row
 * gains the listing-day close and the closes a week, a month and three months later, each as
 * a return over the issue price. A figure is written once, when its day has passed.
 *
 * A US issue has no listing result from its source at all, so its whole outcome is read
 * the same way (resolveUsOutcomes), from the first day the feed has for its ticker.
 *
 * Yahoo's route is unofficial: one request an issue, at most once a day, a capped number a
 * run, and a refusal ends the run quietly.
 */

const { query, execute } = require('../../db');
const { IPO_WATCH } = require('../../config');
const { marketDate, listingGain } = require('./index');

const round2 = (n) => Math.round(n * 100) / 100;
const addDays = (date, n) => new Date(Date.parse(date) + n * 86400e3).toISOString().slice(0, 10);

// Yahoo's chart reply → [{ date, open, close }] in the exchange's own dates, oldest first.
// Days with no price are dropped. Pure.
function parseBars(json) {
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r || !q || !Array.isArray(r.timestamp)) return [];
  const offset = (r.meta?.gmtoffset || 0) * 1000;
  return r.timestamp
    .map((t, i) => ({ date: new Date(t * 1000 + offset).toISOString().slice(0, 10), open: q.open?.[i], close: q.close?.[i] }))
    .filter((b) => typeof b.close === 'number' && b.close > 0)
    .map((b) => ({ date: b.date, open: typeof b.open === 'number' && b.open > 0 ? round2(b.open) : null, close: round2(b.close) }));
}

// The first finished bar on or after `target`, if it falls within `slack` days of it
// (weekends and holidays move a day; a long gap means the share was not trading). Pure.
function barOnOrAfter(bars, target, today, slack = IPO_WATCH.RETURN_SLACK_DAYS) {
  const b = bars.find((x) => x.date >= target && x.date < today);     // today's bar is not final
  return b && b.date <= addDays(target, slack) ? b : null;
}

// The horizons that can be read off the bars today. Pure.
function returnsFrom(bars, listingDate, issuePrice, today) {
  const d0 = barOnOrAfter(bars, listingDate, today, 0);               // the listing day itself, or nothing
  const w1 = barOnOrAfter(bars, addDays(listingDate, 7), today);
  const m1 = barOnOrAfter(bars, addDays(listingDate, 30), today);
  const m3 = barOnOrAfter(bars, addDays(listingDate, 90), today);
  const ret = (b) => (b ? listingGain(b.close, issuePrice) : null);
  return {
    open_listing_day: d0 ? d0.open : null,
    close_listing_day: d0 ? d0.close : null, ret_listing_day_pct: ret(d0),
    close_1w: w1 ? w1.close : null, ret_1w_pct: ret(w1),
    close_1m: m1 ? m1.close : null, ret_1m_pct: ret(m1),
    close_3m: m3 ? m3.close : null, ret_3m_pct: ret(m3),
  };
}

// An Indian ticker is stored bare and takes its exchange's suffix; a US one is used as it is.
async function fetchBars(symbol, exchange, market = 'IN') {
  const yahoo = market === 'US' ? symbol : `${symbol}.${/NSE/.test(exchange || '') ? 'NS' : 'BO'}`;
  const res = await fetch(`${IPO_WATCH.YAHOO_CHART_URL}/${encodeURIComponent(yahoo)}?range=6mo&interval=1d`, {
    headers: { 'User-Agent': IPO_WATCH.USER_AGENT }, signal: AbortSignal.timeout(IPO_WATCH.TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Yahoo chart replied ${res.status}`);
  return parseBars(await res.json());
}

const FIELDS = ['open_listing_day', 'close_listing_day', 'ret_listing_day_pct', 'close_1w', 'ret_1w_pct', 'close_1m', 'ret_1m_pct', 'close_3m', 'ret_3m_pct'];

// Fill in whatever horizons have come due for issues with a ticker. An issue is asked about
// only when a horizon it lacks has passed, at most once a day, and not at all once
// RETURN_GIVE_UP_DAYS have gone by since listing. Never throws.
async function resolveReturns({ today = marketDate(), bars = fetchBars, delayMs = IPO_WATCH.REQUEST_DELAY_MS } = {}) {
  const due = await query(
    `SELECT o.ipo_id, i.symbol, i.exchange, i.listing_date::text AS listing_date, o.issue_price::float8 AS issue_price
       FROM ipo_outcomes o JOIN ipos i ON i.id = o.ipo_id
      WHERE i.market = 'IN' AND i.symbol IS NOT NULL AND i.listing_date >= $1::date - $2::int
        AND ((o.close_listing_day IS NULL AND i.listing_date < $1::date)
          OR (o.close_1w IS NULL AND i.listing_date + 7 < $1::date)
          OR (o.close_1m IS NULL AND i.listing_date + 30 < $1::date)
          OR (o.close_3m IS NULL AND i.listing_date + 90 < $1::date))
        AND (o.returns_checked_at IS NULL OR o.returns_checked_at < now() - interval '20 hours')
      ORDER BY i.listing_date DESC
      LIMIT $3::int`,
    [today, IPO_WATCH.RETURN_GIVE_UP_DAYS, IPO_WATCH.RETURN_LOOKUPS_PER_RUN]
  );
  let updated = 0;
  let error = null;
  for (const [n, row] of due.entries()) {
    if (n > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    let got;
    try { got = returnsFrom(await bars(row.symbol, row.exchange), row.listing_date, row.issue_price, today); }
    catch (err) { error = err.message; break; }                    // refused or down: stop asking this run
    // COALESCE keeps a figure already written: each horizon is recorded once.
    const r = await execute(
      `UPDATE ipo_outcomes SET ${FIELDS.map((f, i) => `${f} = COALESCE(${f}, $${i + 2})`).join(', ')}, returns_checked_at = now()
        WHERE ipo_id = $1`,
      [row.ipo_id, ...FIELDS.map((f) => got[f])]
    );
    if (FIELDS.some((f) => got[f] != null)) updated += r.rowCount || 0;
  }
  return { due: due.length, updated, error };
}

// Today on the US market's clock, "YYYY-MM-DD".
const usDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: IPO_WATCH.US_TIMEZONE }).format(now);

// The day a newly priced share first traded: the feed's first day, when that falls on or
// just after the pricing day. A ticker with prices from before its pricing was already
// trading (or is another company's), so it gives no first day. Pure.
function firstTradeDay(bars, pricedOn, today) {
  if (!bars.length || bars[0].date < pricedOn) return null;
  const b = barOnOrAfter(bars, pricedOn, today);
  return b && b === bars[0] ? b.date : null;
}

// US outcomes. Finnhub gives a priced deal's IPO price and ticker but not what happened
// next, so the whole outcome comes from prices: the first trading day's open is the listing
// price, and the closes follow as for India. SPACs are skipped — a shell trades at its
// trust value. Each issue is asked about at most once a day. Never throws.
async function resolveUsOutcomes({ today = usDate(), bars = fetchBars, delayMs = IPO_WATCH.REQUEST_DELAY_MS } = {}) {
  const due = await query(
    `SELECT i.id, i.symbol, i.listing_date::text AS priced_on, i.first_trade_date::text AS first_trade_date,
            i.price_high::float8 AS issue_price
       FROM ipos i LEFT JOIN ipo_outcomes o ON o.ipo_id = i.id
      WHERE i.market = 'US' AND i.source_status = 'priced' AND NOT i.is_spac AND NOT i.withdrawn
        AND i.symbol IS NOT NULL AND i.listing_date >= $1::date - $2::int
        AND (o.ipo_id IS NULL OR o.close_listing_day IS NULL
          OR (o.close_1w IS NULL AND COALESCE(i.first_trade_date, i.listing_date) + 7 < $1::date)
          OR (o.close_1m IS NULL AND COALESCE(i.first_trade_date, i.listing_date) + 30 < $1::date)
          OR (o.close_3m IS NULL AND COALESCE(i.first_trade_date, i.listing_date) + 90 < $1::date))
        AND (i.symbol_checked_at IS NULL OR i.symbol_checked_at < now() - interval '20 hours')
      ORDER BY i.listing_date DESC
      LIMIT $3::int`,
    [today, IPO_WATCH.RETURN_GIVE_UP_DAYS, IPO_WATCH.RETURN_LOOKUPS_PER_RUN]
  );
  let updated = 0;
  let error = null;
  for (const [n, row] of due.entries()) {
    if (n > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    let series;
    try { series = await bars(row.symbol, null, 'US'); }
    catch (err) { error = err.message; break; }                    // refused or down: stop asking this run
    const first = row.first_trade_date || firstTradeDay(series, row.priced_on, today);
    await execute('UPDATE ipos SET first_trade_date = COALESCE(first_trade_date, $2), symbol_checked_at = now() WHERE id = $1', [row.id, first]);
    if (!first) continue;
    const got = returnsFrom(series, first, row.issue_price, today);
    if (got.open_listing_day == null && got.close_listing_day == null) continue;
    const listed = got.open_listing_day ?? got.close_listing_day;
    await execute(
      `INSERT INTO ipo_outcomes (ipo_id, issue_price, listing_price, listing_gain_pct, price_derived, source)
       VALUES ($1, $2, $3, $4, false, 'yahoo') ON CONFLICT (ipo_id) DO NOTHING`,
      [row.id, row.issue_price, listed, listingGain(listed, row.issue_price)]
    );
    await execute(
      `UPDATE ipo_outcomes SET ${FIELDS.map((f, i) => `${f} = COALESCE(${f}, $${i + 2})`).join(', ')}, returns_checked_at = now()
        WHERE ipo_id = $1`,
      [row.id, ...FIELDS.map((f) => got[f])]
    );
    updated++;
  }
  return { due: due.length, updated, error };
}

module.exports = { parseBars, barOnOrAfter, returnsFrom, resolveReturns, usDate, firstTradeDay, resolveUsOutcomes };
