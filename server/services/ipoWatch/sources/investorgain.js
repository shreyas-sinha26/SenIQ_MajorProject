/**
 * InvestorGain (a Chittorgarh.com site) — two calendar sources, one page each.
 *
 * The live IPO table lists every current mainboard and SME issue with its dates, price,
 * lot, size and grey market premium — and, once it has listed, its listing gain. The live
 * subscription table lists how many times each
 * issue has been bid for, in total and by investor class. Both are already in the HTML, so
 * each source is ONE request.
 *
 * The data is UNOFFICIAL: the site compiles it and says it does not guarantee its accuracy.
 * Its robots.txt allows both pages (checked 2026-10-09); its terms on automated reuse have
 * not been settled, so this stays polite — one plain request a page, identified by our own
 * User-Agent, no cookie or header tricks — and a refusal is "no data today".
 */

const { IPO_WATCH } = require('../../../config');
const { fetchWithTimeout, stripHtml } = require('../../ingest/util');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "14-Oct" or "7th Oct 17:56" has no year: take the year that puts it nearest to today. Pure.
function nearDate(text, today) {
  const m = String(text || '').match(/^\s*(\d{1,2})(?:st|nd|rd|th)?[- ]([A-Za-z]{3})/);
  const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (mon < 0) return null;
  const y = Number(today.slice(0, 4));
  const now = Date.parse(today);
  let best = null;
  for (const year of [y - 1, y, y + 1]) {
    const t = Date.UTC(year, mon, Number(m[1]));
    if (new Date(t).getUTCDate() !== Number(m[1])) continue;        // 31-Feb and the like
    if (best == null || Math.abs(t - now) < Math.abs(best - now)) best = t;
  }
  return best == null ? null : new Date(best).toISOString().slice(0, 10);
}

// "₹702.00 Cr", "2,000", "289" → a number, or null for "-", "" and 0. Pure.
function amount(text) {
  const n = Number(String(text || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The GMP cell's first line: "₹167 (-%)" → 167, "₹-5 (-2%)" → -5, "₹ -- (0.00%)" → null. Pure.
function gmpValue(text) {
  const m = String(text || '').replace(/₹/g, ' ').trim().match(/^(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"');

// The rows of a report page's table, each as { cells: label → cell HTML, link, board, exchange }.
// Rows that are not a mainboard or SME issue (a REIT, a filler row) are left out. Pure.
function tableRows(html, what) {
  const table = String(html || '').match(/<table[^>]*id="reportTable"[^>]*>([\s\S]*?)<\/table>/);
  if (!table) throw new Error(`InvestorGain: the ${what} table was not found on the page`);
  const out = [];
  for (const [, row] of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = {};
    for (const [, label, body] of row.matchAll(/<td[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)) cells[label] = body;
    const link = (cells.Name || '').match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const kind = ((cells.Name.match(/<span[^>]*badge[^>]*>([^<]*)<\/span>/) || [])[1] || '').trim();
    const sme = kind.match(/^(NSE|BSE) SME$/);
    if (!sme && kind !== 'IPO') continue;
    out.push({ cells, name: decode(stripHtml(link[2])), ref: link[1], board: sme ? 'sme' : 'mainboard', exchange: sme ? sme[1] : null });
  }
  return out;
}

// A cell can carry a second line ("GMP: 7", a time); the value is the first.
const firstLine = (cell) => stripHtml(String(cell || '').split(/<br\s*\/?>/i)[0]);

// A date cell's second line is the premium on that day: "5-Oct<br>GMP: 7" → { on, gmp }. Pure.
function gmpOn(cell, today) {
  const [first, second] = String(cell || '').split(/<br\s*\/?>/i);
  const on = nearDate(stripHtml(first), today);
  const m = stripHtml(second || '').match(/^GMP:\s*(-?\d+(?:\.\d+)?)/);
  return on && m ? { on, gmp: Number(m[1]) } : null;
}

// Once listed, the name carries "L@450 (65.44%)": the listing price and the gain over the
// issue price. The site's host rewrites a price with decimals ("L@74.20") as a protected
// e-mail address, so often only the gain can be read; the price is then left unknown here
// rather than decoded. Pure.
function listingResult(nameCell) {
  const cell = String(nameCell || '');
  const m = cell.match(/(?:\bL@\s*([\d,]+(?:\.\d+)?)|__cf_email__[\s\S]*?<\/a>)\s*\((-?\d+(?:\.\d+)?)%\)/);
  return m ? { listing_price: m[1] ? amount(m[1]) : null, listing_gain_pct: Number(m[2]) } : { listing_price: null, listing_gain_pct: null };
}

// The live IPO table's HTML → plain issues (the shape in ./index.js). `today` is "YYYY-MM-DD". Pure.
function parseIssues(html, today) {
  return tableRows(html, 'IPO').map(({ cells, name, ref, board, exchange }) => ({
    name, board, exchange,
    open_date: nearDate(firstLine(cells.Open), today), close_date: nearDate(firstLine(cells.Close), today),
    allotment_date: nearDate(firstLine(cells['BoA Dt']), today), listing_date: nearDate(firstLine(cells.Listing), today),
    price_high: amount(stripHtml(cells['Price (₹)'] || '')),
    lot_size: amount(stripHtml(cells.Lot || '')),
    issue_size_cr: amount(stripHtml(cells['IPO Size'] || '')),
    gmp: gmpValue(firstLine(cells.GMP)),
    gmp_history: ['Open', 'Close', 'BoA Dt', 'Listing'].map((c) => gmpOn(cells[c], today)).filter(Boolean),
    ...listingResult(cells.Name),
    source_ref: ref,
  }));
}

// "14.11" → 14.11, "0.00" → 0 (nobody bid is a real figure), "-" or "" → null. Pure.
function times(text) {
  const t = String(text || '').replace(/,/g, '').replace(/x$/i, '').trim();
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

// "7-10-2026" (day-month-year) → "2026-10-07". Pure.
function dmyDate(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// The live subscription table's HTML → plain issues that carry a `subscription`. A row with
// no total yet (bidding has not started) is left out. Pure.
function parseSubscriptions(html, today) {
  const out = [];
  for (const { cells, name, ref, board, exchange } of tableRows(html, 'subscription')) {
    const total = times(firstLine(cells.Total));
    if (total == null) continue;
    // The total's second line is when the figures are as of: "7th Oct 17:56".
    const asOf = stripHtml(String(cells.Total).split(/<br\s*\/?>/i)[1] || '');
    out.push({
      name, board, exchange,
      close_date: dmyDate(stripHtml(cells['Closing Date'] || '')),
      price_high: amount(stripHtml(cells['IPO Price'] || '')),
      issue_size_cr: amount(stripHtml(cells['IPO Size'] || '')),
      source_ref: ref,
      subscription: {
        observed_on: nearDate(asOf, today),
        total,
        qib: times(stripHtml(cells.QIB || '')),
        nii: times(stripHtml(cells.NII || '')),
        nii_small: times(stripHtml(cells.SHNI || '')),
        nii_big: times(stripHtml(cells.BHNI || '')),
        retail: times(stripHtml(cells.RII || '')),
      },
    });
  }
  return out;
}

async function page(url) {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': IPO_WATCH.USER_AGENT, Accept: 'text/html' } },
    IPO_WATCH.TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`InvestorGain replied ${res.status}`);
  return res.text();
}

const calendar = { name: 'investorgain', fetchIssues: async ({ today }) => parseIssues(await page(IPO_WATCH.INVESTORGAIN_URL), today) };
const subscriptions = { name: 'investorgain-subscription', fetchIssues: async ({ today }) => parseSubscriptions(await page(IPO_WATCH.INVESTORGAIN_SUBSCRIPTION_URL), today) };

module.exports = { calendar, subscriptions, parseIssues, parseSubscriptions, nearDate, amount, gmpValue, gmpOn, listingResult, times, dmyDate };
