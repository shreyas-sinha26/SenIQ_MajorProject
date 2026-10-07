/**
 * Offline tests for company filings (services/disclosures.js): parsing EDGAR's reply,
 * cleaning filing HTML, building the excerpt, and scope. No DB, no network.
 */

const assert = require('node:assert');
const D = require('../server/services/disclosures');
const { runTool, TOOLS } = require('../server/services/qaTools');
const { DISCLOSURES } = require('../server/config');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

const NOW = Date.parse('2026-10-07T00:00:00Z');
// EDGAR's submissions shape: parallel arrays, newest first.
const SUBS = { filings: { recent: {
  form: ['4', '8-K', '10-Q', '8-K/A', '8-K', '8-K'],
  accessionNumber: ['a-0', 'a-1', 'a-2', 'a-3', 'a-4', 'a-5'],
  filingDate: ['2026-10-01', '2026-09-20', '2026-08-01', '2026-07-15', '2026-05-02', '2025-12-01'],
  reportDate: ['2026-09-30', '2026-09-19', '2026-06-30', '2026-07-01', '2026-05-01', '2025-11-30'],
  items: ['', '2.02,9.01', '', '5.02', '9.01', '1.01'],
  primaryDocument: ['x.xml', 'r.htm', 'q.htm', 'a.htm', 'e.htm', 'old.htm'],
} } };

section('EDGAR parsing:');
check('only 8-K forms inside the lookback, newest first, items in plain words', () => {
  const out = D.eightKsFrom(SUBS, { sinceDays: 180, limit: 10, now: NOW });
  assert.deepStrictEqual(out.map((f) => f.accession), ['a-1', 'a-3', 'a-4']); // a-5 is older than 180 days
  assert.deepStrictEqual(out[0], { accession: 'a-1', form: '8-K', items: ['2.02', '9.01'], title: 'Results of operations (earnings)', filed_at: '2026-09-20', report_date: '2026-09-19', primary_document: 'r.htm' });
  assert.strictEqual(out[1].title, 'Director or officer change, or pay arrangement');
  assert.strictEqual(out[2].title, 'Financial statements and exhibits'); // exhibits-only filing keeps its one label
});
check('limit and malformed replies', () => {
  assert.strictEqual(D.eightKsFrom(SUBS, { sinceDays: 400, limit: 2, now: NOW }).length, 2);
  assert.deepStrictEqual(D.eightKsFrom(null), []);
  assert.deepStrictEqual(D.eightKsFrom({ filings: {} }), []);
});
check('item codes: junk dropped, unknown codes still shown, no items → the form name', () => {
  assert.deepStrictEqual(D.parseItems('2.02, 9.01;x, 12'), ['2.02', '9.01']);
  assert.strictEqual(D.titleForItems(['6.99']), 'Item 6.99');
  assert.strictEqual(D.titleForItems([], '8-K/A'), '8-K/A filing');
  assert.strictEqual(D.titleForItems(['5.02', '7.01', '9.01']), 'Director or officer change, or pay arrangement; Regulation FD disclosure');
});

section('filing text:');
check('HTML → text: scripts, styles and hidden XBRL gone, entities decoded, no tags left', () => {
  const html = '<html><head><title>x</title></head><body><ix:header><ix:hidden>secret 0001</ix:hidden></ix:header><style>p{}</style><script>alert(1)</script><p>Item&nbsp;2.02 Results &amp; Outlook</p><div>Revenue was&#160;$10&#x2014;up 5%.</div><!-- c --></body></html>';
  const t = D.htmlToText(html);
  assert.strictEqual(t, 'Item 2.02 Results & Outlook\nRevenue was $10—up 5%.');
  assert.ok(!/[<>]/.test(D.htmlToText('<p>a</p><b>b</b>')));
  assert.strictEqual(D.htmlToText(null), '');
});
check('main body starts at the first Item and stops before boilerplate', () => {
  const doc = 'UNITED STATES SECURITIES AND EXCHANGE COMMISSION\nFORM 8-K\nCommission File Number 001\nItem 2.02 Results of Operations.\n' + 'The company reported revenue growth. '.repeat(12) + '\nForward-Looking Statements\nThis report contains risks about demand and revenue.\nSIGNATURES\nJane Doe';
  const body = D.mainBody(doc);
  assert.ok(body.startsWith('Item 2.02'));
  assert.ok(!/Forward-Looking|SIGNATURES|Commission File/.test(body));
  assert.strictEqual(D.mainBody('no item heading here'), 'no item heading here');
});
check('excerpt: main text plus the press release, each clamped', () => {
  const e = D.buildExcerpt('Item 2.02 ' + 'm'.repeat(9000), 'Apple today announced ' + 'p'.repeat(9000));
  const [main, pr] = e.split('\n\nPRESS RELEASE: ');
  assert.ok(main.length <= DISCLOSURES.MAIN_TEXT_CHARS && pr.length <= DISCLOSURES.EXHIBIT_TEXT_CHARS);
  assert.ok(!D.buildExcerpt('Item 8.01 x', '').includes('PRESS RELEASE'));
  // EDGAR's document header at the top of an exhibit is dropped (seen on a real Apple 8-K).
  assert.ok(D.buildExcerpt('Item 2.02 x', 'EX-99.1 2 a8-kex991q3202606272026.htm EX-99.1 Exhibit 99.1 Apple reports third quarter results').endsWith('PRESS RELEASE: Apple reports third quarter results'));
});
check('press-release exhibit: EX-99.1 preferred, never the main document or non-HTML', () => {
  const items = [{ name: 'main.htm' }, { name: 'a-ex99_2.htm' }, { name: 'a-ex99_1.htm' }, { name: 'ex99.pdf' }, { name: 'R1.htm' }];
  assert.strictEqual(D.pickExhibit(items, 'main.htm'), 'a-ex99_1.htm');
  assert.strictEqual(D.pickExhibit([{ name: 'main.htm' }, { name: 'ex-99.htm' }], 'main.htm'), 'ex-99.htm');
  assert.strictEqual(D.pickExhibit([{ name: 'main.htm' }, { name: 'R2.htm' }], 'main.htm'), null);
  assert.strictEqual(D.pickExhibit(null, 'main.htm'), null);
});

section('coverage and scope:');
check('only US-listed equities have SEC filings', () => {
  assert.strictEqual(D.isUsEquity({ ticker: 'AAPL', asset_class: 'equity', exchange: 'US' }), true);
  assert.strictEqual(D.isUsEquity({ ticker: 'SHOP', asset_class: 'equity', exchange: null }), true); // outside the universe, no exchange → assumed US
  assert.strictEqual(D.isUsEquity({ ticker: 'RELIANCE', asset_class: 'equity', exchange: 'NSE' }), false);
  assert.strictEqual(D.isUsEquity({ ticker: 'TCS', asset_class: 'equity', exchange: null }), false); // Indian universe name even with no exchange
  assert.strictEqual(D.isUsEquity({ ticker: 'INFY', asset_class: 'equity', exchange: 'US' }), false); // the universe lists it as Indian
  assert.strictEqual(D.isUsEquity({ ticker: 'BTC', asset_class: 'crypto', exchange: null }), false);
  assert.strictEqual(D.isUsEquity(null), false);
});
check('search terms drop filler words like "filing" and "latest"', () => {
  assert.deepStrictEqual(D.filingTerms('What did the latest SEC filing say about share repurchases?'), ['share', 'repurchases']);
  assert.deepStrictEqual(D.filingTerms(''), []);
});
check('the Ask tool refuses a ticker outside the portfolio before any query', async () => {
  assert.ok(TOOLS.some((t) => t.name === 'get_disclosures'));
  const r = await runTool({ id: 'x', name: 'get_disclosures', input: { ticker: 'TSLA' } }, { userId: 1, holdings: [], heldSet: new Set(['AAPL']) });
  assert.ok(r.is_error && /not_in_portfolio: TSLA/.test(r.content));
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} checks passed`);
})();
