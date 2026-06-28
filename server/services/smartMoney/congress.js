/**
 * Congress (STOCK Act periodic transaction reports) — Phase 3 politicians.
 *
 * Free community datasets are the cheapest-viable path. The historic stock-watcher S3
 * buckets are currently 403, so this reads from a configurable URL (CONGRESS_TRADES_URL)
 * and, when none is reachable, degrades to a bundled SAMPLE (data/congress_sample.json,
 * flagged is_sample) so the tab + pipeline still work in dev. The normalizer accepts the
 * common stock-watcher field shapes (House + Senate) plus our sample shape.
 *
 * STOCK Act disclosures lag the actual trade by up to ~45 days, so we keep BOTH
 * transaction_date and disclosure_date and surface the gap in the UI.
 */

const fs = require('fs');
const path = require('path');
const { SMART_MONEY } = require('../../config');
const { hashId, fetchWithTimeout } = require('../ingest/util');

const SAMPLE_PATH = path.join(__dirname, '..', '..', '..', 'data', 'congress_sample.json');

let warnedNoSource = false;

// "MM/DD/YYYY" or "YYYY-MM-DD" → "YYYY-MM-DD" (or null).
function normDate(s) {
  if (!s || typeof s !== 'string') return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(t);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function normType(raw) {
  const t = String(raw || '').toLowerCase();
  if (t.includes('exch')) return 'exchange';
  if (t.includes('purchase') || t === 'buy' || t.includes('buy')) return 'buy';
  if (t.includes('sale') || t.includes('sell')) return 'sell';
  return 'buy';
}

// "$1,001 - $15,000" → { min: 1001, max: 15000 }.
function parseAmount(raw) {
  if (!raw) return { min: null, max: null };
  const nums = String(raw).match(/[\d,]+/g);
  if (!nums) return { min: null, max: null };
  const vals = nums.map((n) => Number(n.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
  if (!vals.length) return { min: null, max: null };
  return { min: vals[0], max: vals.length > 1 ? vals[vals.length - 1] : vals[0] };
}

const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] != null && row[k] !== '') return row[k];
  return null;
};

// Map one source row (any of the supported shapes) → our normalized trade.
// Supported shapes: our bundled sample, the stock-watcher House/Senate fields, and
// Financial Modeling Prep (firstName/lastName, symbol, assetDescription, dateRecieved).
function normalizeRow(row, { isSample }) {
  let politician = pick(row, 'politician', 'representative', 'senator', 'name');
  if (!politician) {
    // FMP splits the name — recombine it.
    const fn = pick(row, 'firstName', 'first_name');
    const ln = pick(row, 'lastName', 'last_name');
    if (fn || ln) politician = [fn, ln].filter(Boolean).join(' ');
  }
  if (!politician) return null;

  // chamber: explicit field (stock-watcher `chamber`, or stamped from the source URL for
  // FMP, whose rows carry no chamber), else the stock-watcher senator/representative keys.
  const chamberRaw = pick(row, 'chamber')
    || (row.senator ? 'senate' : row.representative ? 'house' : null);
  const chamber = chamberRaw ? String(chamberRaw).toLowerCase() : 'house';
  const ticker = (pick(row, 'ticker', 'symbol') || '').toString().trim().toUpperCase().replace(/[^A-Z.\-]/g, '') || null;
  const transaction_date = normDate(pick(row, 'transaction_date', 'transactionDate'));
  const disclosure_date = normDate(pick(row, 'disclosure_date', 'disclosureDate', 'dateRecieved', 'disclosure_year'));
  const amountRaw = pick(row, 'amount', 'amount_range', 'value');
  const { min, max } = parseAmount(amountRaw);
  const transaction_type = normType(pick(row, 'type', 'transaction_type'));
  const asset_description = (pick(row, 'asset_description', 'asset', 'description', 'assetDescription') || '').toString().slice(0, 300);

  const source_id = hashId('cong', politician, ticker || asset_description, transaction_date || '', transaction_type, String(amountRaw || ''));

  return {
    source_id,
    politician: String(politician).trim(),
    chamber: chamber === 'senate' ? 'senate' : 'house',
    party: pick(row, 'party') || null,
    state: pick(row, 'state', 'district') || null,
    ticker: ticker && ticker.length <= 6 ? ticker : null,
    asset_description,
    transaction_type,
    transaction_date,
    disclosure_date,
    amount_range: amountRaw ? String(amountRaw) : null,
    amount_min: min,
    amount_max: max,
    is_sample: !!isSample,
  };
}

function loadSample() {
  try {
    const raw = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : raw.trades || [];
  } catch {
    return [];
  }
}

// Pull recent congress trades. Returns { trades, source } where source is 'live'|'sample'.
async function fetchCongressTrades() {
  const lookbackMs = SMART_MONEY.CONGRESS_LOOKBACK_DAYS * 24 * 3600 * 1000;
  const cutoff = new Date(Date.now() - lookbackMs);

  let rows = null;
  let isSample = false;

  // CONGRESS_TRADES_URL may be a single URL or a comma-separated list (e.g. an FMP
  // Senate endpoint + a House endpoint) — each is fetched independently so one chamber
  // failing doesn't lose the other.
  const urls = (SMART_MONEY.CONGRESS_TRADES_URL || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (urls.length) {
    rows = [];
    for (const url of urls) {
      try {
        const res = await fetchWithTimeout(
          url,
          { headers: { 'User-Agent': SMART_MONEY.SEC_USER_AGENT, Accept: 'application/json' } },
          12000
        );
        if (!res.ok) throw new Error(`congress source ${res.status}`);
        const data = await res.json();
        const part = Array.isArray(data) ? data : data.trades || data.transactions || [];
        // FMP rows carry no chamber field — stamp it from the endpoint URL so House and
        // Senate rows are labelled correctly (skipped if the row already states a chamber).
        const ch = /house/i.test(url) ? 'house' : /senate/i.test(url) ? 'senate' : null;
        if (ch) for (const r of part) { if (r && r.chamber == null) r.chamber = ch; }
        rows.push(...part);
      } catch (err) {
        console.warn(`   ⚠️  congress source failed (${err.message}); skipping that endpoint.`);
      }
    }
    if (rows.length === 0) rows = null; // all endpoints failed → fall back to sample below
  } else if (!warnedNoSource) {
    warnedNoSource = true;
    console.warn('   ⚠️  CONGRESS_TRADES_URL not set — using bundled sample congress data.');
  }

  if (!rows || rows.length === 0) {
    rows = loadSample();
    isSample = true;
  }

  const trades = [];
  for (const row of rows) {
    const t = normalizeRow(row, { isSample });
    if (!t) continue;
    // Filter to the recent window by whichever date we have.
    const anchor = t.disclosure_date || t.transaction_date;
    if (!isSample && anchor && new Date(anchor) < cutoff) continue;
    trades.push(t);
  }

  return { trades, source: isSample ? 'sample' : 'live' };
}

module.exports = { fetchCongressTrades, normalizeRow, parseAmount, normDate, normType };
