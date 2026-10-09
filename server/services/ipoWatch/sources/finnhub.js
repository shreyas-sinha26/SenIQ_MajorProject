/**
 * Finnhub — the US IPO calendar, as a calendar source.
 *
 * An official API on the key the project already uses for US prices and news. One request
 * returns every issue with an event in the window: companies that have filed, deals expected
 * this week, deals just priced, and withdrawals — each with its ticker. It gives no firm
 * dates beyond the current week, and nothing like India's grey market or subscription
 * figures, which do not exist for US offerings.
 */

const { IPO_WATCH } = require('../../../config');
const { fetchWithTimeout } = require('../../ingest/util');

const shift = (date, days) => new Date(Date.parse(date) + days * 86400e3).toISOString().slice(0, 10);

// "14.00-16.00" → a range; "10.00" → the one price the deal was done at. Pure.
function priceRange(text) {
  const nums = String(text || '').split('-').map((p) => Number(p.trim())).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return { price_low: null, price_high: null };
  return nums.length > 1 ? { price_low: Math.min(...nums), price_high: Math.max(...nums) } : { price_low: null, price_high: nums[0] };
}

// A blank-check company lists a shell to buy a business later; its name says so. Pure.
const isSpac = (name) => /\bacquisition\b/i.test(String(name || ''));

const STATUSES = ['withdrawn', 'priced', 'expected', 'filed'];     // strongest first

// Finnhub's reply → plain issues (the shape in ./index.js). A company can appear more than
// once (filed, then withdrawn): its latest event is kept, the stronger status on a tie. Pure.
function parseCalendar(json) {
  const rows = (json && Array.isArray(json.ipoCalendar) ? json.ipoCalendar : [])
    .filter((r) => r && r.name && STATUSES.includes(r.status))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = String(r.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const dated = r.status === 'expected' || r.status === 'priced';   // its date is the listing day
    out.push({
      market: 'US',
      name: r.name,
      exchange: r.exchange || null,
      symbol: r.symbol || null,
      listing_date: dated ? r.date : null,
      status_date: dated ? null : r.date,
      ...priceRange(r.price),
      shares: r.numberOfShares || null,
      issue_size_usd: r.totalSharesValue || null,
      source_status: r.status,
      withdrawn: r.status === 'withdrawn',
      is_spac: isSpac(r.name),
    });
  }
  return out;
}

async function fetchIssues({ today }) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY is not set');
  const url = `${IPO_WATCH.FINNHUB_IPO_URL}?from=${shift(today, -IPO_WATCH.US_LOOKBACK_DAYS)}&to=${shift(today, IPO_WATCH.US_LOOKAHEAD_DAYS)}`;
  const res = await fetchWithTimeout(url, { headers: { 'X-Finnhub-Token': key } }, IPO_WATCH.TIMEOUT_MS);
  if (!res.ok) throw new Error(`Finnhub replied ${res.status}`);
  return parseCalendar(await res.json());
}

module.exports = { calendar: { name: 'finnhub', fetchIssues }, parseCalendar, priceRange, isSpac };
