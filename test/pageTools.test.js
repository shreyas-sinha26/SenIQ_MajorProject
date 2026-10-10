/**
 * Offline tests for the tools that let Ask read the app's other pages (services/pageTools.js):
 * which fund, politician or investor a typed name means, the rows Ask is shown, the room
 * they take, and which questions are for these pages. No database, no network.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const P = require('../server/services/pageTools');
const { TOOLS, EXECUTORS, scopeCheck } = require('../server/services/qaTools');
const { DATA_TOOLS, ASK_ONLY } = require('../server/services/dataTools');
const { INDIA_INVESTORS } = require('../server/data/indiaInvestors');
const { UNIVERSE } = require('../server/data/universe');
const { QA } = require('../server/config');
const lib = require('../eval/ask/lib');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const NAMES = ['get_fund_holdings', 'get_politician_trades', 'get_india_deals', 'get_alerts_and_brief'];
const FUNDS = [
  { name: 'Berkshire Hathaway', slug: 'berkshire-hathaway', manager: 'Warren Buffett' },
  { name: 'Scion Asset Management', slug: 'scion', manager: 'Michael Burry' },
  { name: 'Tiger Global Management', slug: 'tiger-global', manager: 'Chase Coleman' },
  { name: 'ARK Investment Management', slug: 'ark-invest', manager: 'Cathie Wood' },
];
const fundNames = (f) => [f.name, f.slug, f.manager];
const held = new Set(['NVDA', 'AAPL', 'RELIANCE']);

console.log('which fund, politician or investor a typed name means:');
check('a fund by its name, part of it, its slug, or its manager', () => {
  for (const [typed, slug] of [['Berkshire Hathaway', 'berkshire-hathaway'], ['berkshire', 'berkshire-hathaway'], ['Buffett', 'berkshire-hathaway'], ['Michael Burry', 'scion'], ['scion', 'scion'], ['ARK', 'ark-invest'], ['Cathie Wood\'s ARK Investment Management', 'ark-invest']])
    assert.strictEqual(P.pickNamed(typed, FUNDS, fundNames).item.slug, slug, typed);
});
check('a word inside another word is not a match; nothing typed and nothing found are "none"', () => {
  assert.deepStrictEqual(P.pickNamed('Vanguard', FUNDS, fundNames), { none: true });
  assert.deepStrictEqual(P.pickNamed('Berk', FUNDS, fundNames), { none: true });
  assert.deepStrictEqual(P.pickNamed('  ', FUNDS, fundNames), { none: true });
});
check('several are handed back, capped, and none is picked', () => {
  const r = P.pickNamed('Management', FUNDS, fundNames);
  assert.ok(!r.item && r.matches.length === 3);
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `John Smith ${i}` }));
  assert.strictEqual(P.pickNamed('Smith', many, (p) => [p.name, 'Smith']).matches.length, QA.PAGE_MATCHES);
});
check('a politician by surname; an Indian investor by its name or the name NSE prints', () => {
  const people = [{ name: 'Ro Khanna' }, { name: 'Mark Warner' }, { name: 'Nancy Pelosi' }];
  const names = (p) => [p.name, ...p.name.split(/\s+/).slice(-1)];
  assert.strictEqual(P.pickNamed('Pelosi', people, names).item.name, 'Nancy Pelosi');
  assert.strictEqual(P.pickNamed('ro khanna', people, names).item.name, 'Ro Khanna');
  const inv = (i) => [i.name, i.slug, ...i.match];
  assert.strictEqual(P.pickNamed('LIC', INDIA_INVESTORS, inv).item.slug, 'lic');
  assert.strictEqual(P.pickNamed('Jhunjhunwala', INDIA_INVESTORS, inv).item.slug, 'rekha-jhunjhunwala');
  assert.strictEqual(P.pickNamed('Rekha Jhunjhunwala', INDIA_INVESTORS, inv).item.slug, 'rekha-jhunjhunwala');
  assert.strictEqual(P.pickNamed('Government of Singapore', INDIA_INVESTORS, inv).item.slug, 'gic-singapore');
  assert.strictEqual(P.pickNamed('Buffett', INDIA_INVESTORS, inv).none, true);
});

console.log('the rows Ask is shown:');
check('a 13F position: its share of the fund, the change as filed, and whether the user holds it', () => {
  assert.deepStrictEqual(P.holdingRow({ ticker: 'NVDA', issuer_name: 'NVIDIA CORPORATION', value: '186580000', change_type: 'new' }, 1381198076, held),
    { issuer: 'NVIDIA CORPORATION', ticker: 'NVDA', value_usd: 186580000, pct_of_fund: 13.51, change: 'new', held_by_user: true });
  const r = P.holdingRow({ ticker: null, issuer_name: 'GOODYEAR TIRE &amp; RUBR CO', value: '9956701', change_type: 'baseline' }, 0, held);
  assert.deepStrictEqual([r.issuer, r.ticker, r.pct_of_fund, r.change, 'held_by_user' in r], ['GOODYEAR TIRE & RUBR CO', null, null, 'no earlier quarter to compare', false]);
});
check('a congressional trade keeps both dates and the amount band as disclosed', () => {
  const t = { politician: 'Nancy Pelosi', chamber: 'house', party: null, ticker: 'INTC', asset_description: 'Intel', transaction_type: 'buy', transaction_date: '2026-05-29', disclosure_date: '2026-06-24', amount_range: '$1,000,001 - $5,000,000' };
  const r = P.congressRow(t, held);
  assert.deepStrictEqual([r.action, r.amount, r.traded, r.disclosed, 'party' in r, 'held_by_user' in r], ['buy', '$1,000,001 - $5,000,000', '2026-05-29', '2026-06-24', false, false]);
  assert.strictEqual(P.congressRow({ ...t, ticker: null }, held).asset, 'Intel');
  assert.strictEqual(P.congressRow({ ...t, ticker: 'NVDA', party: 'D' }, held).held_by_user, true);
});
check('an Indian deal names the client as NSE does, and the investor when it is one SenIQ follows', () => {
  const d = { deal_type: 'bulk', deal_date: '2026-10-07', ticker: 'RELIANCE', security_name: 'Reliance Industries', client_name: 'LIFE INSURANCE CORPORATION OF INDIA', investor_slug: 'lic', side: 'buy', quantity: '1000', price: '55.64', value: '55640.4' };
  assert.deepStrictEqual(P.dealRow(d, held), { client: 'LIFE INSURANCE CORPORATION OF INDIA', investor: 'LIC', deal: 'bulk', action: 'buy', ticker: 'RELIANCE', company: 'Reliance Industries', shares: 1000, price_inr: 55.64, value_inr: 55640, traded: '2026-10-07', held_by_user: true });
  assert.ok(!('investor' in P.dealRow({ ...d, investor_slug: null, ticker: 'SUZLON' }, held)) && !('investor' in P.dealRow({ ...d, investor_slug: 'constructor' }, held)));
  const i = P.insiderRow({ ticker: 'RELIANCE', company: 'Reliance Industries Limited', person: 'A B', category: 'Promoter', mode: 'Market Purchase', side: 'buy', quantity: '960', value: null, trade_from: '2026-02-02', disclosed_at: '2026-02-09' }, held);
  assert.deepStrictEqual([i.action, i.shares, i.value_inr, i.traded, i.disclosed, i.held_by_user], ['buy', 960, null, '2026-02-02', '2026-02-09', true]);
});
check('an alert: when it was made, without the page\'s emoji, its text cut to length', () => {
  const a = P.alertRow({ ticker: 'MARKET', alert_type: 'market_event', sentiment_label: 'neutral', message: `📊 Markets: ${'x'.repeat(400)}`, read: false, delivery: 'digest', created_at: '2026-10-10T16:20:07.602Z' });
  assert.deepStrictEqual([a.when, a.ticker, a.read, a.sent], ['2026-10-10 16:20 UTC', null, false, 'digest']);
  assert.ok(a.message.startsWith('Markets: x') && a.message.length === QA.PAGE_ALERT_CHARS);
  assert.strictEqual(P.alertRow({ ticker: 'BTC', message: 'BTC — up', created_at: '2026-10-10T16:10:00Z' }).message, 'BTC — up');
});
check('the brief: its date, who wrote it, its text cut to length; none is said, never written', () => {
  const b = P.briefCard({ brief_date: '2026-10-08', headline: 'H', narrative: 'n'.repeat(5000), writer: 'deterministic' }).brief;
  assert.deepStrictEqual([b.date, b.headline, b.written_by], ['2026-10-08', 'H', 'code, from the day\'s figures']);
  assert.ok(b.text.endsWith('… [cut]') && b.text.length < QA.PAGE_BRIEF_CHARS + 10);
  assert.strictEqual(P.briefCard({ narrative: 'short', writer: 'claude' }).brief.written_by, 'the AI writer');
  const none = P.briefCard(null);
  assert.ok(none.brief === null && /No daily brief has been written/.test(none.brief_note));
});

console.log('the room a full result takes:');
const long = (n) => 'W'.repeat(n);
check('ten congressional trades, with long names, fit the tool-result allowance', () => {
  const rows = Array.from({ length: QA.PAGE_ROWS }, () => P.congressRow({ politician: long(30), chamber: 'senate', party: 'Republican', ticker: 'GOOGL', transaction_type: 'sell (partial)', transaction_date: '2026-06-15', disclosure_date: '2026-06-29', amount_range: '$1,000,001 - $5,000,000' }, new Set(['GOOGL'])));
  assert.ok(JSON.stringify(rows).length + 700 < QA.MAX_TOOL_RESULT_CHARS, String(JSON.stringify(rows).length));
});
check('five Indian deals and five insider trades, with long names, fit', () => {
  const n = Math.ceil(QA.PAGE_ROWS / 2);
  const deals = Array.from({ length: n }, () => P.dealRow({ deal_type: 'block', deal_date: '2026-10-07', ticker: 'RELIANCE', security_name: long(40), client_name: long(60), investor_slug: 'gic-singapore', side: 'sell', quantity: '19328196', price: '1055.64', value: '20403618825.44' }, held));
  const ins = Array.from({ length: n }, () => P.insiderRow({ ticker: 'RELIANCE', company: long(40), person: long(40), category: 'Promoter Group', mode: 'Revokation of Pledge', side: 'pledge', quantity: '19328196', value: '20403618825', trade_from: '2026-02-02', disclosed_at: '2026-02-09' }, held));
  assert.ok(JSON.stringify(deals).length + JSON.stringify(ins).length + 700 < QA.MAX_TOOL_RESULT_CHARS, String(JSON.stringify(deals).length + JSON.stringify(ins).length));
});
check('a fund\'s top positions and its largest changes fit', () => {
  const row = () => P.holdingRow({ ticker: 'GOOGL', issuer_name: long(40), value: '65950296923', change_type: 'unchanged' }, 299253556246, new Set(['GOOGL']));
  const rows = Array.from({ length: QA.PAGE_FUND_TOP + 3 * QA.PAGE_FUND_CHANGES }, row);
  assert.ok(JSON.stringify(rows).length + 1000 < QA.MAX_TOOL_RESULT_CHARS, String(JSON.stringify(rows).length));
});
check('the newest alerts and the brief together fit, and so do the alerts on their own', () => {
  const alert = () => P.alertRow({ ticker: 'RELIANCE', alert_type: 'sentiment_negative', sentiment_label: 'negative', message: long(400), read: false, delivery: 'realtime', created_at: '2026-10-10T16:20:07.602Z' });
  assert.ok(JSON.stringify(Array.from({ length: QA.PAGE_ALERTS }, alert)).length + 400 < QA.MAX_TOOL_RESULT_CHARS);
  const alerts = Array.from({ length: QA.PAGE_ALERTS_WITH_BRIEF }, () => P.alertRow({ ticker: 'RELIANCE', alert_type: 'sentiment_negative', sentiment_label: 'negative', message: long(400), read: false, delivery: 'realtime', created_at: '2026-10-10T16:20:07.602Z' }));
  const brief = P.briefCard({ brief_date: '2026-10-08', headline: long(160), narrative: long(5000), writer: 'deterministic' });
  assert.ok(JSON.stringify({ alerts, ...brief }).length + 400 < QA.MAX_TOOL_RESULT_CHARS, String(JSON.stringify({ alerts, ...brief }).length));
});

console.log('which questions are for these pages:');
const universe = UNIVERSE.filter((c) => c.assetClass !== 'commodity').map((c) => ({ ticker: c.ticker, name: c.name, aliases: c.aliases || [] }));
const refused = (q) => scopeCheck(q, universe, new Set(['AAPL'])).refuse;
check('a fund or an investor named beside what it did goes to the model, not to the share\'s snapshot', () => {
  for (const q of ['What does Berkshire Hathaway hold?', 'What has Goldman Sachs been buying in India?', 'Has BlackRock done any bulk deals?', 'Did any senator buy Tesla?', 'What did Morgan Stanley sell in its latest 13F?'])
    assert.ok(P.isPageQuestion(q) && !refused(q), q);
});
check('a question about the share itself still gets the snapshot, advice included', () => {
  for (const q of ['Should I buy Goldman Sachs?', 'How is Berkshire Hathaway stock doing?', 'Is Berkshire a good buy?', 'Morgan Stanley price history', 'Give me the latest news on Tesla', 'How is HDFC Bank doing?'])
    assert.ok(!P.isPageQuestion(q) && refused(q), q);
});
check('every fund a migration seeds is one the pre-check knows', () => {
  const dir = path.join(__dirname, '..', 'server', 'migrations');
  const seeded = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).flatMap((f) => {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    return [...sql.matchAll(/INSERT INTO institutions[^;]*;/g)].flatMap((m) => [...m[0].matchAll(/\('\d{10}',\s*'([^']+)'/g)].map((r) => r[1]));
  });
  assert.ok(seeded.length >= P.TRACKED_FUNDS.length, String(seeded.length));
  for (const name of seeded) assert.ok(P.isPageQuestion(`What does ${name} hold?`), name);
});

console.log('the tools:');
check('four more Ask tools, each with an executor, appended after the ones before', () => {
  assert.deepStrictEqual(TOOLS.slice(-4).map((t) => t.name), NAMES);
  for (const n of NAMES) assert.strictEqual(typeof EXECUTORS[n], 'function', n);
});
check('none takes a ticker, and none has a required argument', () => {
  for (const t of TOOLS.filter((x) => NAMES.includes(x.name))) {
    assert.ok(!('ticker' in t.input_schema.properties) && !t.input_schema.required, t.name);
  }
});
check('they are Ask only: not on /mcp or /v1', () => {
  for (const n of NAMES) assert.ok(ASK_ONLY.includes(n) && !DATA_TOOLS.some((t) => t.name === n), n);
});
check('the eval lets a page read name a stock outside the portfolio', () => {
  const c = { id: 'x', tags: ['t'], question: 'q', rubric: [], expect: { writer: 'claude', no_data_for: ['PLTR'] } };
  const run = (evidence) => lib.gradeDeterministic(c, { writer: 'claude', answer: 'ok.', tools_used: [], grounding: null, evidence }).checks.no_data_leak;
  assert.strictEqual(run(['{"kind":"fund_holdings","top_holdings":[{"ticker":"PLTR"}]}']), true);
  assert.strictEqual(run(['{"ticker":"PLTR","events":[]}']), false);
});

console.log(`\n${passed} page-tool checks passed`);
