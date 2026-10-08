/**
 * NSE (National Stock Exchange of India) — shared fetch + parsing helpers for the Indian
 * smart-money sources (nseDeals.js, nseInsiders.js).
 *
 * These routes are public but UNOFFICIAL: NSE documents no API, can change or block them
 * without notice, and its terms on automated access have not been checked. So this stays
 * polite — one plain request per file or symbol, spaced out, identified by our own
 * User-Agent, no cookie or header tricks — and every caller treats a failure as "no data
 * today", never as an error worth retrying in a loop.
 */

const { INDIA_SMART_MONEY } = require('../../config');
const { fetchWithTimeout } = require('../ingest/util');

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// "07-OCT-2026", "13-Feb-2026" or "18-Feb-2026 19:06" → "2026-10-07" (or null). Pure.
function nseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, '0')}` : null;
}

// "1,23,456.50" → 123456.5; "-", "" or junk → null. Pure.
function nseNumber(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (!t || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// One CSV line → fields. Client names can hold commas inside quotes. Pure.
function csvFields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// GET an NSE route. Throws an Error carrying `.status` on a non-2xx reply.
async function nseFetch(url, accept) {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': INDIA_SMART_MONEY.USER_AGENT, Accept: accept } },
    INDIA_SMART_MONEY.TIMEOUT_MS
  );
  if (!res.ok) {
    const err = new Error(`NSE replied ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// 401/403 means NSE is refusing this client — stop asking for the rest of the run.
const isBlocked = (err) => err && (err.status === 401 || err.status === 403);

module.exports = { nseDate, nseNumber, csvFields, nseFetch, isBlocked };
