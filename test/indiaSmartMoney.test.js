/**
 * Offline tests for India smart money: parsing NSE's bulk/block deal CSV and insider-trade
 * JSON, matching client names to the curated investors, the alert rule, and the poller's
 * baseline / grouping / recipient logic. No network; the database is an in-memory stand-in
 * that answers the handful of statements the poller sends.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';
process.env.INDIA_SMART_MONEY = '1';

const assert = require('node:assert');

// ── In-memory stand-in for server/db.js (installed before anything requires it) ──
const state = {};
function resetDb() {
  Object.assign(state, {
    deals: [], insiders: [], sync: new Set(), alerts: [],
    holders: {},      // ticker → [userId] holding it as an Indian stock
    followers: {},    // investor slug → [userId]
  });
}
resetDb();
async function run(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q.startsWith('SELECT count(*)::int AS n FROM india_deals')) return [{ n: state.deals.filter((d) => d.deal_type === params[0]).length }];
  if (q.startsWith('INSERT INTO india_deals')) {
    if (state.deals.some((d) => d.source_id === params[0])) return [];
    state.deals.push({ source_id: params[0], deal_type: params[1], ticker: params[3] });
    return [{ id: state.deals.length }];
  }
  if (q.startsWith('SELECT 1 AS x FROM india_insider_sync')) return state.sync.has(params[0]) ? [{ x: 1 }] : [];
  if (q.startsWith('INSERT INTO india_insider_sync')) { state.sync.add(params[0]); return []; }
  if (q.startsWith('INSERT INTO india_insider_trades')) {
    if (state.insiders.some((t) => t.source_id === params[0])) return [];
    state.insiders.push({ source_id: params[0], ticker: params[1] });
    return [{ id: state.insiders.length }];
  }
  if (q.startsWith('SELECT DISTINCT p.user_id FROM portfolio p')) return (state.holders[params[0]] || []).map((user_id) => ({ user_id }));
  if (q.startsWith('SELECT DISTINCT user_id FROM followed_entities')) {
    const ids = new Set(params[0].flatMap((slug) => state.followers[slug] || []));
    return [...ids].map((user_id) => ({ user_id }));
  }
  if (q.startsWith('SELECT count(*)::int AS n FROM alerts')) return [{ n: 0 }];
  if (q.startsWith('INSERT INTO alerts')) { state.alerts.push({ user_id: params[0], ticker: params[1], type: params[2], message: params[3], delivery: params[4] }); return []; }
  if (q.startsWith('SELECT * FROM webhooks')) return [];
  throw new Error(`stand-in db: unexpected statement: ${q.slice(0, 90)}`);
}
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: {
    query: run,
    queryOne: async (sql, params) => (await run(sql, params))[0] || null,
    execute: async (sql, params) => ({ rowCount: (await run(sql, params)).length }),
  },
};

const { nseDate, nseNumber, csvFields, isBlocked } = require('../server/services/smartMoney/nse');
const { parseDeals } = require('../server/services/smartMoney/nseDeals');
const { normalizeInsider, insidersFrom, insiderAlertable } = require('../server/services/smartMoney/nseInsiders');
const { matchInvestor, INDIA_INVESTORS } = require('../server/data/indiaInvestors');
const India = require('../server/services/smartMoney/india');
const { INDIA_SMART_MONEY } = require('../server/config');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

const NOW = Date.parse('2026-10-08T14:00:00Z');

// The header and first row are as NSE served them on 2026-10-08; the rest are made up.
const BULK_CSV = [
  'Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks',
  '07-OCT-2026,AAREYDRUGS,Aarey Drugs & Pharm Ltd,VAYUMIND INNOVATIONS PRIVATE LIMITED,BUY,181007,109.00,-',
  '07-OCT-2026,RELIANCE,Reliance Industries Limited,GOVERNMENT OF SINGAPORE,BUY,"70,00,000","1,400.50",-',
  '07-OCT-2026,RELIANCE,Reliance Industries Limited,"SMITH, JONES & CO LLP",SELL,7000000,1400.50,-',
  '07-OCT-2026,TRENT,Trent Limited,SBI MUTUAL FUND A/C SBI SMALL CAP FUND,SELL,250000,5000,-',
  '07-OCT-2026,BADROW,Bad Row Ltd,SOMEONE,HOLD,10,10,-',
  '',
].join('\n');
const EMPTY_CSV = 'Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price\nNO RECORDS,,,,,,\n';

section('NSE parsing helpers:');
check('dates in the three shapes NSE uses', () => {
  assert.strictEqual(nseDate('07-OCT-2026'), '2026-10-07');
  assert.strictEqual(nseDate('13-Feb-2026'), '2026-02-13');
  assert.strictEqual(nseDate('18-Feb-2026 19:06'), '2026-02-18');
  assert.strictEqual(nseDate('NO RECORDS'), null);
  assert.strictEqual(nseDate(null), null);
});
check('numbers: Indian comma grouping, dashes and blanks', () => {
  assert.strictEqual(nseNumber('1,23,456.50'), 123456.5);
  assert.strictEqual(nseNumber('3294168'), 3294168);
  assert.strictEqual(nseNumber('-'), null);
  assert.strictEqual(nseNumber(''), null);
  assert.strictEqual(nseNumber('n/a'), null);
});
check('CSV fields keep a comma inside quotes', () => {
  assert.deepStrictEqual(csvFields('a,"B, C & CO",d'), ['a', 'B, C & CO', 'd']);
  assert.deepStrictEqual(csvFields('x,"say ""hi""",'), ['x', 'say "hi"', '']);
});
check('only a 401/403 counts as being refused', () => {
  assert.strictEqual(isBlocked(Object.assign(new Error('x'), { status: 403 })), true);
  assert.strictEqual(isBlocked(Object.assign(new Error('x'), { status: 500 })), false);
  assert.strictEqual(isBlocked(new Error('timeout')), false);
});

section('bulk / block deals:');
check('rows become deals; the header, blank line and a row with no side are dropped', () => {
  const deals = parseDeals(BULK_CSV, 'bulk');
  assert.strictEqual(deals.length, 4);
  assert.deepStrictEqual(
    { ...deals[0], source_id: undefined },
    { source_id: undefined, deal_type: 'bulk', deal_date: '2026-10-07', ticker: 'AAREYDRUGS', security_name: 'Aarey Drugs & Pharm Ltd',
      client_name: 'VAYUMIND INNOVATIONS PRIVATE LIMITED', investor_slug: null, side: 'buy', quantity: 181007, price: 109, value: 181007 * 109, remarks: null });
});
check('quoted numbers and names parse; value is quantity × price', () => {
  const [, gic, smith] = parseDeals(BULK_CSV, 'bulk');
  assert.strictEqual(gic.quantity, 7000000);
  assert.strictEqual(gic.value, 7000000 * 1400.5);
  assert.strictEqual(gic.investor_slug, 'gic-singapore');
  assert.strictEqual(smith.client_name, 'SMITH, JONES & CO LLP');
  assert.strictEqual(smith.side, 'sell');
});
check('"NO RECORDS" and junk give no deals', () => {
  assert.deepStrictEqual(parseDeals(EMPTY_CSV, 'block'), []);
  assert.deepStrictEqual(parseDeals('', 'bulk'), []);
  assert.deepStrictEqual(parseDeals('<html>blocked</html>', 'bulk'), []);
});
check('the same row always gets the same id; bulk and block ids differ', () => {
  const a = parseDeals(BULK_CSV, 'bulk')[0].source_id;
  assert.strictEqual(parseDeals(BULK_CSV, 'bulk')[0].source_id, a);
  assert.notStrictEqual(parseDeals(BULK_CSV, 'block')[0].source_id, a);
});

section('curated investors:');
check('a client name matches on a whole phrase, whatever the punctuation', () => {
  assert.strictEqual(matchInvestor('SBI MUTUAL FUND A/C SBI SMALL CAP FUND').slug, 'sbi-mf');
  assert.strictEqual(matchInvestor('Government of Singapore - E').slug, 'gic-singapore');
  assert.strictEqual(matchInvestor('VANGUARD EMERGING MARKETS STOCK INDEX FUND').slug, 'vanguard');
  assert.strictEqual(matchInvestor('REKHA RAKESH JHUNJHUNWALA').slug, 'rekha-jhunjhunwala');
});
check('look-alikes are not attributed', () => {
  assert.strictEqual(matchInvestor('SBI LIFE INSURANCE COMPANY LIMITED'), null);
  assert.strictEqual(matchInvestor('HDFC BANK LIMITED'), null);
  assert.strictEqual(matchInvestor('AVANGUARDIA CAPITAL'), null); // "vanguard" inside another word
  assert.strictEqual(matchInvestor(''), null);
});
check('slugs are unique and every investor has a match phrase', () => {
  assert.strictEqual(new Set(INDIA_INVESTORS.map((i) => i.slug)).size, INDIA_INVESTORS.length);
  assert.ok(INDIA_INVESTORS.every((i) => i.match.length && i.match.every((m) => m === m.toLowerCase() && m.length >= 6)));
});

// Field names and the first row's values are as NSE served them for RELIANCE on 2026-10-08.
const PIT_ROW = {
  acqMode: 'Off Market', acqName: 'BALANADU NARAYAN', acqfromDt: '13-Feb-2026', acqtoDt: '13-Feb-2026',
  afterAcqSharesNo: '1600', afterAcqSharesPer: '0', befAcqSharesNo: '3920', befAcqSharesPer: '0',
  company: 'Reliance Industries Limited', date: '18-Feb-2026 19:06', intimDt: '16-Feb-2026',
  personCategory: 'Other', pid: '1194033', secAcq: '2320', secType: 'Equity Shares', secVal: '3294168',
};
const promoterBuy = (over = {}) => ({
  acqMode: 'Market Purchase', acqName: 'ACME HOLDINGS PRIVATE LIMITED', acqfromDt: '05-Oct-2026', acqtoDt: '06-Oct-2026',
  befAcqSharesNo: '1000000', afterAcqSharesNo: '1200000', befAcqSharesPer: '10.00', afterAcqSharesPer: '12.00',
  company: 'Trent Limited', date: '07-Oct-2026 18:10', intimDt: '07-Oct-2026', personCategory: 'Promoters',
  pid: '900001', secAcq: '200000', secType: 'Equity Shares', secVal: '1000000000', tdpTransactionType: 'Buy', ...over,
});

section('insider trades:');
check('a row is normalized; with no stated side it is read off the holding before and after', () => {
  const t = normalizeInsider(PIT_ROW, 'RELIANCE');
  assert.deepStrictEqual({ ...t, source_id: undefined }, {
    source_id: undefined, ticker: 'RELIANCE', company: 'Reliance Industries Limited', person: 'BALANADU NARAYAN',
    category: 'Other', security_type: 'Equity Shares', mode: 'Off Market', side: 'sell', quantity: 2320, value: 3294168,
    shares_before: 3920, shares_after: 1600, pct_before: 0, pct_after: 0,
    trade_from: '2026-02-13', trade_to: '2026-02-13', intimated_at: '2026-02-16', disclosed_at: '2026-02-18',
  });
});
check('side: stated type wins, pledges are kept apart, unknown stays "other"', () => {
  assert.strictEqual(normalizeInsider(promoterBuy(), 'TRENT').side, 'buy');
  assert.strictEqual(normalizeInsider(promoterBuy({ tdpTransactionType: 'Sell' }), 'TRENT').side, 'sell');
  assert.strictEqual(normalizeInsider(promoterBuy({ tdpTransactionType: 'Pledge' }), 'TRENT').side, 'pledge');
  assert.strictEqual(normalizeInsider(promoterBuy({ tdpTransactionType: undefined, acqMode: 'Invocation of pledge' }), 'TRENT').side, 'pledge');
  assert.strictEqual(normalizeInsider(promoterBuy({ tdpTransactionType: undefined, acqMode: 'Market Sale', befAcqSharesNo: '-', afterAcqSharesNo: '-' }), 'TRENT').side, 'sell');
  assert.strictEqual(normalizeInsider({ acqName: 'X', acqMode: 'Gift' }, 'TRENT').side, 'other');
  assert.strictEqual(normalizeInsider({ company: 'no person' }, 'TRENT'), null);
  assert.strictEqual(normalizeInsider({ acqName: '-', acqMode: '-', date: '02-Apr-2026 10:00' }, 'BAJFINANCE'), null); // placeholder row
});
check('the reply is read as {data: [...]} or a bare list, and old rows are dropped', () => {
  assert.strictEqual(insidersFrom({ data: [promoterBuy(), PIT_ROW] }, 'TRENT', NOW).length, 2); // February is inside the lookback
  assert.strictEqual(insidersFrom({ data: [promoterBuy(), { ...PIT_ROW, date: '18-Feb-2025 19:06' }] }, 'TRENT', NOW).length, 1);
  assert.strictEqual(insidersFrom([promoterBuy()], 'TRENT', NOW).length, 1);
  assert.deepStrictEqual(insidersFrom(null, 'TRENT', NOW), []);
  assert.deepStrictEqual(insidersFrom({ error: 'x' }, 'TRENT', NOW), []);
});
check('alert rule: promoter / director / key manager, open market, ≥ ₹1 crore, recent', () => {
  const ok = normalizeInsider(promoterBuy(), 'TRENT');
  assert.strictEqual(insiderAlertable(ok, NOW), true);
  const not = (over, why) => assert.strictEqual(insiderAlertable(normalizeInsider(promoterBuy(over), 'TRENT'), NOW), false, why);
  not({ secVal: String(INDIA_SMART_MONEY.INSIDER_ALERT_MIN_INR - 1) }, 'below the threshold');
  not({ personCategory: 'Employees/Designated Employees' }, 'an employee');
  not({ acqMode: 'Off Market' }, 'off-market transfer');
  not({ acqMode: 'ESOP' }, 'stock options');
  not({ tdpTransactionType: 'Pledge' }, 'a pledge');
  not({ secType: 'Warrants' }, 'not equity');
  not({ date: '01-Sep-2026 10:00' }, 'disclosed too long ago');
  assert.strictEqual(insiderAlertable(normalizeInsider(promoterBuy({ personCategory: 'Director', tdpTransactionType: 'Sell', acqMode: 'Market Sale' }), 'TRENT'), NOW), true);
  assert.strictEqual(insiderAlertable(normalizeInsider(promoterBuy({ personCategory: 'Key Managerial Personnel' }), 'TRENT'), NOW), true);
});

section('money and share counts:');
check('rupees in crore and lakh', () => {
  assert.strictEqual(India.fmtInr(9803500000), '₹980 Cr');
  assert.strictEqual(India.fmtInr(27900000), '₹2.8 Cr');
  assert.strictEqual(India.fmtInr(450000), '₹4.5 L');
  assert.strictEqual(India.fmtInr(950), '₹950');
  assert.strictEqual(India.fmtShares(7000000), '70.00 L');
});

section('deal poller:');
const dealsOf = (csv) => async (type) => parseDeals(csv, type);
check('the first file of a type is stored silently', async () => {
  resetDb();
  state.holders.RELIANCE = [1];
  const r = await India.pollDealType('bulk', { fetch: dealsOf(BULK_CSV), now: NOW });
  assert.deepStrictEqual(r, { fetched: 4, inserted: 4, alerts: 0, baseline: true });
  assert.strictEqual(state.alerts.length, 0);
});
check('after that: one alert per stock, to its holders and to followers of a matched investor', async () => {
  resetDb();
  state.deals.push({ source_id: 'earlier', deal_type: 'bulk', ticker: 'X' }); // a baseline exists
  state.holders.RELIANCE = [1, 2];
  state.followers['sbi-mf'] = [3];
  state.followers['gic-singapore'] = [2]; // already a holder — told once
  const r = await India.pollDealType('bulk', { fetch: dealsOf(BULK_CSV), now: NOW });
  assert.strictEqual(r.inserted, 4);
  assert.strictEqual(r.alerts, 3);
  const rel = state.alerts.filter((a) => a.ticker === 'RELIANCE');
  assert.deepStrictEqual(rel.map((a) => a.user_id).sort(), [1, 2]);
  assert.strictEqual(rel[0].message, '🏦 Bulk deals in RELIANCE on 2026-10-07: GIC (Government of Singapore) bought 70.00 L shares at ₹1400.5 (₹980 Cr); SMITH, JONES & CO LLP sold 70.00 L shares at ₹1400.5 (₹980 Cr)');
  const trent = state.alerts.filter((a) => a.ticker === 'TRENT');
  assert.deepStrictEqual(trent.map((a) => a.user_id), [3]);
  assert.ok(/SBI Mutual Fund sold/.test(trent[0].message));
  assert.ok(!state.alerts.some((a) => a.ticker === 'AAREYDRUGS')); // nobody holds or follows it
  assert.ok(state.alerts.every((a) => a.type === 'smart_money' && a.delivery === 'realtime'));
});
check('the same file again adds nothing and alerts no one', async () => {
  const before = state.alerts.length;
  const r = await India.pollDealType('bulk', { fetch: dealsOf(BULK_CSV), now: NOW });
  assert.strictEqual(r.inserted, 0);
  assert.strictEqual(state.alerts.length, before);
});
check('a deal fetched long after its date is stored but not alerted', async () => {
  resetDb();
  state.deals.push({ source_id: 'earlier', deal_type: 'bulk', ticker: 'X' });
  state.holders.RELIANCE = [1];
  const r = await India.pollDealType('bulk', { fetch: dealsOf(BULK_CSV), now: NOW + 30 * 86400000 });
  assert.strictEqual(r.inserted, 4);
  assert.strictEqual(r.alerts, 0);
});
check('a refused deal file stops the run; another failure moves on to the next file', async () => {
  resetDb();
  const calls = [];
  const refuse = async (type) => { calls.push(type); throw Object.assign(new Error('NSE replied 403'), { status: 403 }); };
  const r = await India.pollIndiaDeals({ fetch: refuse, noDelay: true });
  assert.deepStrictEqual(calls, ['bulk']);
  assert.strictEqual(r.blocked, true);
  const flaky = async (type) => { if (type === 'bulk') throw new Error('timeout'); return parseDeals(EMPTY_CSV, type); };
  const r2 = await India.pollIndiaDeals({ fetch: flaky, noDelay: true });
  assert.deepStrictEqual(r2.errors, ['bulk: timeout']);
  assert.ok(r2.block && !r2.blocked);
});

section('insider poller:');
const tradesOf = (...rows) => async (symbol, now) => insidersFrom({ data: rows }, symbol, now);
check('first contact with a symbol is silent, even for an alert-worthy trade', async () => {
  resetDb();
  state.holders.TRENT = [1];
  const r = await India.pollInsidersFor('TRENT', { fetch: tradesOf(promoterBuy()), now: NOW });
  assert.deepStrictEqual(r, { inserted: 1, alerts: 0, baseline: true });
  assert.ok(state.sync.has('TRENT'));
});
check('later: new alert-worthy trades become ONE alert for the stock\'s holders; small ones are only stored', async () => {
  const fetch = tradesOf(
    promoterBuy(), // already stored
    promoterBuy({ pid: '900002', acqName: 'SECOND PROMOTER', secVal: '20000000', secAcq: '4000' }),
    promoterBuy({ pid: '900003', acqName: 'AN EMPLOYEE', personCategory: 'Employees/Designated Employees', secVal: '50000', acqMode: 'ESOP' }),
    promoterBuy({ pid: '900004', acqName: 'A DIRECTOR', personCategory: 'Director', tdpTransactionType: 'Sell', acqMode: 'Market Sale', secVal: '50000000', secAcq: '10000' })
  );
  const r = await India.pollInsidersFor('TRENT', { fetch, now: NOW });
  assert.deepStrictEqual(r, { inserted: 3, alerts: 1, baseline: false });
  assert.strictEqual(state.alerts.length, 1);
  assert.strictEqual(state.alerts[0].user_id, 1);
  assert.strictEqual(state.alerts[0].message, '🏛️ Insider trades in TRENT: A DIRECTOR (Director) sold 10,000 shares (₹5.0 Cr); SECOND PROMOTER (Promoters) bought 4,000 shares (₹2.0 Cr), disclosed 2026-10-07');
});
check('nobody holds the stock → trades stored, no alert', async () => {
  resetDb();
  state.sync.add('BEL');
  const r = await India.pollInsidersFor('BEL', { fetch: tradesOf(promoterBuy()), now: NOW });
  assert.deepStrictEqual(r, { inserted: 1, alerts: 0, baseline: false });
});
check('a refusal stops the symbol loop; an ordinary failure does not', async () => {
  resetDb();
  const seen = [];
  const fetch = async (symbol) => {
    seen.push(symbol);
    if (symbol === 'B') throw new Error('timeout');
    if (symbol === 'C') throw Object.assign(new Error('NSE replied 401'), { status: 401 });
    return [];
  };
  const r = await India.pollIndiaInsiders({ symbols: ['A', 'B', 'C', 'D'], fetch, noDelay: true });
  assert.deepStrictEqual(seen, ['A', 'B', 'C']);
  assert.strictEqual(r.checked, 1);
  assert.strictEqual(r.blocked, true);
  assert.deepStrictEqual(r.errors, ['B: timeout', 'C: NSE replied 401']);
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} India smart-money checks passed`);
})();
