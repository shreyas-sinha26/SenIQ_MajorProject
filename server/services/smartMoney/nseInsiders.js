/**
 * NSE insider-trading disclosures — the Indian counterpart of the Congress tab.
 *
 * SEBI's insider-trading rules (PIT Regulation 7) make promoters, directors and key
 * managers report their trades in the company's shares; the company passes them to the
 * exchange, usually within two trading days. NSE serves them per symbol as JSON. Most rows
 * are small (employees selling stock options), so everything is stored but only a narrow
 * slice can alert — see insiderAlertable.
 */

const { INDIA_SMART_MONEY } = require('../../config');
const { hashId } = require('../ingest/util');
const { nseDate, nseNumber, nseFetch } = require('./nse');

// What the person did. NSE states it for most rows; otherwise read it off the holding
// before and after. Pledges are kept apart — shares offered as loan security, not a trade.
function sideOf(row, before, after) {
  const t = `${row.tdpTransactionType || ''} ${row.acqMode || ''}`.toLowerCase();
  if (/pledge|invocation|revok/.test(t)) return 'pledge';
  const stated = String(row.tdpTransactionType || '').toLowerCase();
  if (/buy|acqui/.test(stated)) return 'buy';
  if (/sell|sale|dispos/.test(stated)) return 'sell';
  if (/market purchase/i.test(row.acqMode || '')) return 'buy';
  if (/market sale/i.test(row.acqMode || '')) return 'sell';
  if (before != null && after != null && after !== before) return after > before ? 'buy' : 'sell';
  return 'other';
}

// One NSE row → our normalized trade (or null when it names no one). Pure.
function normalizeInsider(row, symbol) {
  // NSE sends placeholder rows whose every field is "-".
  if (!row || !row.acqName || !/[A-Za-z]/.test(row.acqName)) return null;
  const ticker = String(row.symbol || symbol || '').toUpperCase().trim();
  if (!ticker) return null;
  const shares_before = nseNumber(row.befAcqSharesNo);
  const shares_after = nseNumber(row.afterAcqSharesNo);
  const trade_from = nseDate(row.acqfromDt);
  const quantity = nseNumber(row.secAcq);
  const person = String(row.acqName).trim().slice(0, 200);
  return {
    // NSE's own row id when it sends one; otherwise the facts of the trade.
    source_id: row.pid
      ? hashId('inpit', ticker, String(row.pid))
      : hashId('inpit', ticker, person, trade_from || '', String(quantity), String(row.acqMode || '')),
    ticker,
    company: String(row.company || '').slice(0, 200),
    person,
    category: row.personCategory ? String(row.personCategory).slice(0, 80) : null,
    security_type: row.secType ? String(row.secType).slice(0, 80) : null,
    mode: row.acqMode ? String(row.acqMode).slice(0, 80) : null,
    side: sideOf(row, shares_before, shares_after),
    quantity,
    value: nseNumber(row.secVal),
    shares_before,
    shares_after,
    pct_before: nseNumber(row.befAcqSharesPer),
    pct_after: nseNumber(row.afterAcqSharesPer),
    trade_from,
    trade_to: nseDate(row.acqtoDt),
    intimated_at: nseDate(row.intimDt),
    disclosed_at: nseDate(row.date),
  };
}

/**
 * Whether a stored trade is worth an alert: a promoter, director or key manager buying or
 * selling shares on the open market, above INSIDER_ALERT_MIN_INR, disclosed recently.
 * Stock options, gifts, off-market transfers between family members and pledges are
 * routine and say little about the person's view of the company. Pure.
 */
function insiderAlertable(t, now = Date.now()) {
  if (t.side !== 'buy' && t.side !== 'sell') return false;
  if (!/^market/i.test(t.mode || '')) return false; // "Market Purchase" / "Market Sale", not "Off Market"
  if (!/promoter|director|key manager|kmp/i.test(t.category || '')) return false;
  if (t.security_type && !/equity/i.test(t.security_type)) return false;
  if (!(t.value >= INDIA_SMART_MONEY.INSIDER_ALERT_MIN_INR)) return false;
  if (!t.disclosed_at) return false;
  const ageDays = (now - Date.parse(t.disclosed_at)) / 86400000;
  return ageDays <= INDIA_SMART_MONEY.ALERT_MAX_AGE_DAYS;
}

// dd-mm-yyyy, the format NSE's date filters take.
const ddmmyyyy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;

// Reply body → trades inside the lookback (NSE may ignore the date filter). Pure.
function insidersFrom(body, symbol, now = Date.now()) {
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : []);
  const cutoff = now - INDIA_SMART_MONEY.INSIDER_LOOKBACK_DAYS * 86400000;
  const out = [];
  for (const row of rows) {
    const t = normalizeInsider(row, symbol);
    if (!t) continue;
    const anchor = t.disclosed_at || t.trade_to || t.trade_from;
    if (anchor && Date.parse(anchor) < cutoff) continue;
    out.push(t);
  }
  return out;
}

// Recent insider trades for one NSE symbol.
async function fetchInsiderTrades(symbol, now = Date.now()) {
  const from = new Date(now - INDIA_SMART_MONEY.INSIDER_LOOKBACK_DAYS * 86400000);
  const url = `${INDIA_SMART_MONEY.INSIDER_URL}?index=equities&symbol=${encodeURIComponent(symbol)}` +
    `&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(new Date(now))}`;
  const res = await nseFetch(url, 'application/json');
  return insidersFrom(await res.json(), symbol, now);
}

module.exports = { normalizeInsider, insidersFrom, insiderAlertable, sideOf, fetchInsiderTrades };
