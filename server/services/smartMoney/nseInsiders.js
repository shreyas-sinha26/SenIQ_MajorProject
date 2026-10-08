/**
 * NSE insider-trading disclosures — the Indian counterpart of the Congress tab.
 *
 * SEBI's insider-trading rules (PIT Regulation 7) make promoters, directors and key
 * managers report their trades in the company's shares; the company passes them to the
 * exchange, usually within two trading days. Most are small (employees selling stock
 * options), so everything is stored but only a narrow slice can alert — see insiderAlertable.
 *
 * NSE has served these two ways. Until April 2026: one JSON row per trade, per symbol.
 * From May 2026 ("PIT V2.0"): a whole-market list of FILINGS, each linking an XBRL file
 * with the trades inside. The daily poll reads the filings; the per-symbol route is kept
 * for loading older history by hand.
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

// ─── Filings (NSE's format from May 2026) ─────────────────────────────────────
// The list reply → the filings worth reading: originals inside the lookback, with a file
// on NSE's archive host. A revision restates an earlier filing's trades; reading both
// would count the trade twice, so revisions are left out. Pure.
function filingsFrom(body, now = Date.now()) {
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : []);
  const cutoff = now - INDIA_SMART_MONEY.INSIDER_LOOKBACK_DAYS * 86400000;
  const out = [];
  for (const r of rows) {
    const ticker = String((r && r.symbol) || '').toUpperCase().trim();
    const xml = String((r && r.xmlFileName) || '');
    const broadcast_at = nseDate(r && r.broadcastDateTime);
    if (!ticker || !r.appId || !broadcast_at) continue;
    if (!xml.startsWith(INDIA_SMART_MONEY.FILINGS_HOST)) continue; // only ever fetch from NSE's archive
    if (/revision/i.test(r.typeOfSubmission || '')) continue;
    if (Date.parse(broadcast_at) < cutoff) continue;
    out.push({ app_id: String(r.appId), ticker, company: String(r.companyName || '').slice(0, 200), broadcast_at, xml });
  }
  return out;
}

const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);
const xmlText = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
// XBRL states a holding as a fraction of the company (0.011 = 1.1%); we keep percent.
const pctOf = (s) => { const n = nseNumber(s); return n == null ? null : Math.round(n * 1e6) / 1e4; };

/**
 * One filing's XBRL → its trades. The file is a flat list of facts, each tagged with the
 * disclosure it belongs to (contextRef="Disclosure1", "Disclosure2", …); a filing can hold
 * several people's trades. Pure.
 */
function parseFilingXml(xml, filing) {
  const byCtx = new Map();
  for (const m of String(xml || '').matchAll(/<in-bse-co:(\w+)\s+contextRef="(Disclosure\d+)"[^>]*>([^<]*)</g)) {
    if (!byCtx.has(m[2])) byCtx.set(m[2], {});
    byCtx.get(m[2])[m[1]] = xmlText(m[3]);
  }
  const trades = [];
  for (const [ctx, f] of byCtx) {
    const person = (f.NameOfThePerson || '').slice(0, 200);
    if (!/[A-Za-z]/.test(person)) continue;
    const shares_before = nseNumber(f.SecuritiesHeldPriorToAcquisitionOrDisposalNumberOfSecurity);
    const shares_after = nseNumber(f.SecuritiesHeldPostAcquistionOrDisposalNumberOfSecurity);
    const mode = f.ModeOfAcquisitionOrDisposal || null;
    trades.push({
      source_id: hashId('inpit2', filing.ticker, filing.app_id, ctx),
      ticker: filing.ticker,
      company: filing.company || '',
      person,
      category: f.CategoryOfPerson ? f.CategoryOfPerson.slice(0, 80) : null,
      // The filing says "Equity"; the older route said "Equity Shares" — keep one spelling.
      security_type: f.TypeOfInstrument ? (/^equity$/i.test(f.TypeOfInstrument) ? 'Equity Shares' : f.TypeOfInstrument.slice(0, 80)) : null,
      mode: mode ? mode.slice(0, 80) : null,
      side: sideOf({ tdpTransactionType: f.SecuritiesAcquiredOrDisposedTransactionType, acqMode: mode }, shares_before, shares_after),
      quantity: nseNumber(f.SecuritiesAcquiredOrDisposedNumberOfSecurity),
      value: nseNumber(f.SecuritiesAcquiredOrDisposedValueOfSecurity),
      shares_before,
      shares_after,
      pct_before: pctOf(f.SecuritiesHeldPriorToAcquisitionOrDisposalPercentageOfShareholding),
      pct_after: pctOf(f.SecuritiesHeldPostAcquistionOrDisposalPercentageOfShareholding),
      trade_from: isoDate(f.DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyFromDate),
      trade_to: isoDate(f.DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyToDate),
      intimated_at: isoDate(f.DateOfIntimationToCompany),
      disclosed_at: filing.broadcast_at,
    });
  }
  return trades;
}

// The whole market's recent insider filings — one request.
async function fetchInsiderFilings(now = Date.now()) {
  const res = await nseFetch(INDIA_SMART_MONEY.INSIDER_FILINGS_URL, 'application/json');
  return filingsFrom(await res.json(), now);
}

// The trades inside one filing — one request to NSE's archive.
async function fetchFilingTrades(filing) {
  const res = await nseFetch(filing.xml, 'application/xml,text/xml,*/*');
  return parseFilingXml(await res.text(), filing);
}

// ─── The per-symbol route (history up to April 2026) ──────────────────────────
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

module.exports = {
  normalizeInsider, insidersFrom, insiderAlertable, sideOf, fetchInsiderTrades,
  filingsFrom, parseFilingXml, fetchInsiderFilings, fetchFilingTrades,
};
