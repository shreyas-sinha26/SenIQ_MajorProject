/**
 * Offline tests for the fixes that came out of the QA pass on v1.17 / v2.18 and have no
 * better home: each check names the finding it holds shut. No network; the database is an
 * in-memory stand-in that records every statement and answers the few that need rows.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');

// ── In-memory stand-in for server/db.js (installed before anything requires it) ──
const db = { calls: [], answers: [] };
function resetDb(answers = []) { db.calls = []; db.answers = answers; }
async function run(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  db.calls.push({ sql: q, params });
  for (const [pattern, rows] of db.answers) if (pattern.test(q)) return typeof rows === 'function' ? rows(params, q) : rows;
  return [];
}
const called = (pattern) => db.calls.filter((c) => pattern.test(c.sql));
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: {
    query: run,
    queryOne: async (sql, params) => (await run(sql, params))[0] || null,
    execute: async (sql, params) => ({ rowCount: (await run(sql, params)).length }),
  },
};

const { QA } = require('../server/config');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  });
}
const section = (title) => pending.push(async () => console.log(`\n${title}`));

// The clause every reader of 13F rows uses to keep to a fund's newest filing.
const LATEST_FILING = /f\.id = \(SELECT l\.id FROM institution_filings l WHERE l\.institution_id = i\.id ORDER BY l\.period_of_report DESC NULLS LAST, l\.id DESC LIMIT 1\)/;

section('v1 H1 / M16 — the company brief and the daily brief:');
check('the company brief reads each fund\'s latest filing only, and real congressional rows only', async () => {
  resetDb([
    [/FROM congress_trades WHERE is_sample = false/, [{ n: 225 }]],
    [/FROM institution_holdings h/, [{ name: 'Citadel Advisors', pct_of_portfolio: 2.7, change_type: 'reduced' }]],
    [/FROM congress_trades WHERE ticker = \$1/, (params) => (params[2] === false ? [{ politician: 'Jane Doe', chamber: 'house', party: 'D', transaction_type: 'sell', transaction_date: '2026-06-01' }] : [{ politician: 'Sample Member' }])],
  ]);
  const { buildCompanyBrief } = require('../server/services/onboarding');
  const brief = await buildCompanyBrief(7, 'NVDA');
  const funds = called(/FROM institution_holdings h/)[0];
  assert.ok(LATEST_FILING.test(funds.sql), funds.sql);
  const congress = called(/FROM congress_trades WHERE ticker = \$1/)[0];
  assert.ok(/is_sample = \$3/.test(congress.sql));
  assert.strictEqual(congress.params[2], false); // real rows exist, so sample rows are left out
  assert.deepStrictEqual(brief.smart_money.congress.map((c) => c.politician), ['Jane Doe']);
  assert.ok(!('congress_sample' in brief.smart_money));
});
check('with no real disclosures the brief uses the sample rows and marks them', async () => {
  resetDb([
    [/FROM congress_trades WHERE is_sample = false/, [{ n: 0 }]],
    [/FROM congress_trades WHERE ticker = \$1/, (params) => (params[2] === true ? [{ politician: 'Sample Member', transaction_type: 'buy' }] : [])],
  ]);
  const brief = await require('../server/services/onboarding').buildCompanyBrief(7, 'NVDA');
  assert.strictEqual(brief.smart_money.congress_sample, true);
  assert.strictEqual(brief.smart_money.congress.length, 1);
});
check('the daily brief\'s packet reads each fund\'s latest filing only', async () => {
  resetDb([[/FROM congress_trades WHERE is_sample = false/, [{ n: 1 }]]]);
  process.env.INDIA_SMART_MONEY = process.env.INDIA_SMART_MONEY || '1';
  await require('../server/services/grounding').smartMoneyContext(7);
  assert.ok(LATEST_FILING.test(called(/FROM institution_holdings h/)[0].sql));
});

section('v1 H1 / H2 / L3 / L4 / L5 / M5 / M11 — the smart-money routes and the 13F reader:');
check('?limit= is a row count from 1 to 200, never a negative slice', () => {
  const { listLimit } = require('../server/routes/smartMoney');
  assert.deepStrictEqual(['-5', '0', 'abc', undefined, '60', '9999', '2.9', '1e2'].map(listLimit), [50, 50, 50, 50, 60, 200, 2, 100]);
});
check('a webhook subscribes to known event types only', () => {
  const { webhookTypes } = require('../server/routes/smartMoney');
  assert.strictEqual(webhookTypes(undefined), 'smart_money');
  assert.strictEqual(webhookTypes(''), 'smart_money');
  assert.strictEqual(webhookTypes(' smart_money.congress_trade , * ,smart_money.congress_trade'), 'smart_money.congress_trade,*');
  for (const bad of ['<b>everything</b>', 'smart_money.nope', ',', { a: 1 }, 7]) assert.strictEqual(webhookTypes(bad), null, String(bad));
});
check('the 13F reader leaves option rows out of a position and stores names decoded', () => {
  const { parseInfoTable, decodeXml } = require('../server/services/smartMoney/edgar');
  const row = (name, value, shares, putCall = '') => `<infoTable><nameOfIssuer>${name}</nameOfIssuer><cusip>67066G104</cusip><value>${value}</value><shrsOrPrnAmt><sshPrnamt>${shares}</sshPrnamt></shrsOrPrnAmt>${putCall && `<putCall>${putCall}</putCall>`}</infoTable>`;
  const xml = `<informationTable>${row('NVIDIA CORPORATION', 1000, 10)}${row('NVIDIA CORPORATION', 9000, 90, 'Call')}${row('NVIDIA CORPORATION', 7000, 70, 'Put')}${row('NVIDIA CORPORATION', 500, 5)}</informationTable>`;
  assert.deepStrictEqual(parseInfoTable(xml, '2026-06-30').map((h) => [h.value, h.shares]), [[1500, 15]]);
  const named = parseInfoTable(`<informationTable>${row('JOHNSON &amp; JOHNSON', 1, 1)}</informationTable>`, '2026-06-30');
  assert.strictEqual(named[0].issuer_name, 'JOHNSON & JOHNSON');
  // A name stored before the fix carries "&amp;"; the page then showed "&amp;amp;".
  assert.strictEqual(decodeXml('STATE STR SPDR S&amp;P 500 ETF T'), 'STATE STR SPDR S&P 500 ETF T');
  assert.strictEqual(decodeXml('A &amp;lt; B'), 'A &lt; B'); // decoded once, not twice
});

section('v1 L8 / L17 — the account:');
check('a display name loses control characters and the marks that reorder text', () => {
  const { cleanName } = require('../server/routes/auth');
  assert.strictEqual(cleanName('evil‮nimda '), 'evilnimda');
  assert.strictEqual(cleanName('  José Ünal\t'), 'José Ünal');
  assert.strictEqual(cleanName('​⁦'), '');
  assert.strictEqual(cleanName({ name: 'x' }), '');
});

section('v1 M17 / v2 M8 — a tool result that overruns is cut by whole rows:');
check('fitRows drops rows from the end, counts them, and leaves a fitting result alone', () => {
  const { fitRows } = require('../server/services/qaTools');
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
  const small = fitRows({ shape: 'a', rows, after: 'kept' }, 'rows', 10000);
  assert.ok(small.rows.length === 6 && !('rows_not_shown' in small));
  const cut = fitRows({ shape: 'a', rows, after: 'kept' }, 'rows', 400);
  assert.ok(JSON.stringify(cut).length <= 400, String(JSON.stringify(cut).length));
  assert.deepStrictEqual([cut.rows.length, cut.rows_not_shown, cut.after], [2, 4, 'kept']);
  assert.strictEqual(rows.length, 6); // the caller's rows are not touched
  assert.strictEqual(fitRows({ rows }, 'rows', 10).rows.length, 1); // never emptied
});
check('get_disclosures with six of the longest filings is whole JSON inside the limit', async () => {
  const filing = (i) => ({ id: i, ticker: 'NVDA', form: '8-K', items: '2.02,7.01,9.01', title: 'Results of operations; Regulation FD disclosure; Financial statements and exhibits',
    filed: `2026-0${i}-15`, event_date: `2026-0${i}-14`, url: `https://www.sec.gov/Archives/edgar/data/1045810/00010458102600000${i}/nvda-2026${i}15x8k.htm`, excerpt: 'w '.repeat(400) });
  resetDb([
    [/FROM disclosures WHERE ticker = ANY/, [1, 2, 3, 4, 5, 6].map(filing)],
    [/FROM disclosure_sync/, [{ ticker: 'NVDA', source_id: '1045810' }]],
  ]);
  const { runTool } = require('../server/services/qaTools');
  const r = await runTool({ id: 't', name: 'get_disclosures', input: {} }, { userId: 1, holdings: [], heldSet: new Set(['NVDA', 'RELIANCE', 'BTC']) });
  assert.ok(!r.is_error && r.content.length <= QA.MAX_TOOL_RESULT_CHARS && !/truncated\]$/.test(r.content), String(r.content.length));
  const out = JSON.parse(r.content);
  assert.strictEqual(out.filings.length + (out.filings_not_shown || 0), 6);
  assert.ok(out.answer_shape && out.no_filings_available_for.length === 2);
});
check('list_strategy_presets keeps the SenIQ templates and signals when the built-in list is long', async () => {
  const { runTool } = require('../server/services/qaTools');
  const { STRATEGY_EXECUTORS } = require('../server/services/strategyTools');
  const strategies = Array.from({ length: 15 }, (_, i) => ({ name: `Template${i}`, label: `Template number ${i}`, description: 'long words '.repeat(40), category: 'trend',
    params: [{ name: 'fast', default: 12 }, { name: 'slow', default: 26 }, { name: 'signal', default: 9 }] }));
  const callService = async () => ({ status: 200, data: { strategies, builder: { seniq_metrics: ['sentiment_avg', 'sentiment_zscore', 'news_volume', 'congress_net_buys'] } } });
  const r = await runTool({ id: 't', name: 'list_strategy_presets', input: {} }, { userId: 1, tier: 'pro', heldSet: new Set(), callService }, STRATEGY_EXECUTORS);
  assert.ok(!r.is_error && r.content.length <= QA.MAX_TOOL_RESULT_CHARS && !/truncated\]$/.test(r.content), String(r.content.length));
  const out = JSON.parse(r.content);
  assert.ok(out.seniq_presets.length > 0 && out.seniq_signals_for_custom_strategies.length === 4 && out.how_to_test);
  assert.strictEqual(out.presets.length + (out.presets_not_shown || 0), 15);
});

section('v1 M6 / M7 — the Free plan\'s "top event only":');
check('a top-only plan gets the engine\'s figures for its one most important story and no other', () => {
  const { topImpactOnly } = require('../server/routes/news');
  const { TIERS } = require('../server/config');
  const story = (id, impact) => ({ id, title: `s${id}`, impact, impact_level: impact == null ? null : 'high', direction: impact == null ? null : 'negative', exposure_pct: impact == null ? null : 12.5, sentiment: { label: 'negative', score: 0.3 } });
  const stories = [story(1, 0.2), story(2, 0.9), story(3, null), story(4, 0.5)];
  const free = topImpactOnly(stories, TIERS.free);
  assert.deepStrictEqual(free.map((s) => s.impact), [null, 0.9, null, null]);
  assert.deepStrictEqual(free.map((s) => [s.impact_level, s.direction, s.exposure_pct]).filter((x) => x.some((v) => v != null)), [['high', 'negative', 12.5]]);
  assert.deepStrictEqual(free.map((s) => s.title), ['s1', 's2', 's3', 's4']); // the stories and their order stay
  assert.ok(free.every((s) => s.sentiment.label === 'negative'));             // and each one's own tone
  assert.strictEqual(topImpactOnly(stories, TIERS.plus), stories);
  assert.strictEqual(stories[0].impact, 0.2);                                  // the input is not changed
});
check('the leftover live-lookup route is gone', () => {
  const router = require('../server/routes/news');
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes('/sentiment/:ticker/drivers') && !paths.includes('/sentiment/:ticker'), paths.join(' '));
});

section('v1 M1 / M2 / L7 / L25 / L28, v2 L16 — a bad request is answered as one:');
check('a path that cannot be decoded, and other client errors Express raises, are 4xx and are not logged', () => {
  const { clientErrors } = require('../server/middleware/errors');
  const reply = (err) => { const out = { passed: false }; clientErrors(err, {}, { status: (c) => ({ json: (b) => { out.status = c; out.body = b; } }) }, () => { out.passed = true; }); return out; };
  const decode = Object.assign(new URIError("Failed to decode param '%E0%A4%A'"), { status: 400, statusCode: 400 });
  assert.deepStrictEqual(reply(decode), { passed: false, status: 400, body: { error: 'That address is not valid' } });
  assert.strictEqual(reply({ type: 'entity.too.large' }).status, 413);
  assert.strictEqual(reply({ type: 'entity.parse.failed', body: '{"password":"secret"' }).body.error, 'The request body is not valid JSON');
  assert.strictEqual(reply({ status: 400, expose: true, message: 'Bad Request' }).status, 400); // the static-file server's own
  // A failure of ours is not dressed up as the caller's: it goes on to the 500 handler.
  assert.strictEqual(reply(new Error('boom')).passed, true);
  assert.strictEqual(reply(Object.assign(new Error('db'), { status: 400 })).passed, true); // a status nobody meant to show
});
check('a conversation id too long for its column is "not found" without asking the database', async () => {
  resetDb();
  const threads = require('../server/services/askThreads');
  for (const id of ['9999999999999999999999', 1e22, '1.5', '0x10', 'abc', -1, null, {}]) {
    assert.strictEqual(await threads.getThread(7, id), null, String(id));
    assert.strictEqual(await threads.getMessages(7, id), null, String(id));
    assert.strictEqual(await threads.deleteThread(7, id), false, String(id));
  }
  assert.strictEqual(db.calls.length, 0);
  resetDb([[/FROM ask_threads WHERE id = \$1/, [{ id: '12', title: 't' }]]]);
  assert.deepStrictEqual((await threads.getThread(7, '12')).id, 12);
});
check('a quantity or cost typed as text is plain decimal; "0x10" and "1e3" are refused', () => {
  const { parseOptionalNumber, INVALID } = require('../server/routes/portfolio');
  assert.deepStrictEqual(['10', ' 2.5 ', '.5', 16, 0, '', null, undefined].map(parseOptionalNumber), [10, 2.5, 0.5, 16, 0, null, null, null]);
  for (const bad of ['0x10', '1e3', '-5', 'abc', '1,000', '5.', {}, [], true, 1e13, -1]) assert.strictEqual(parseOptionalNumber(bad), INVALID, String(bad));
});
check('a named exchange must be a real one, for a stock, in the company\'s own country', () => {
  const { exchangeProblem } = require('../server/routes/portfolio');
  assert.strictEqual(exchangeProblem(null, 'equity', null, 'IBM'), null);
  assert.strictEqual(exchangeProblem('NYSE', 'equity', { country: 'US' }, 'IBM'), null);
  assert.strictEqual(exchangeProblem('BSE', 'equity', { country: 'IN' }, 'TCS'), null);
  assert.strictEqual(exchangeProblem('NSE', 'equity', null, 'OBSCURE'), null); // not in the reference: taken at its word
  assert.strictEqual(exchangeProblem('NSE', 'equity', { country: 'US' }, 'IBM'), 'IBM is listed in the US, not on NSE.');
  assert.strictEqual(exchangeProblem('NASDAQ', 'equity', { country: 'IN' }, 'TCS'), 'TCS is listed in India, not on NASDAQ.');
  assert.match(exchangeProblem('MARS', 'equity', null, 'IBM'), /Unknown exchange "MARS"/);
  assert.match(exchangeProblem('NSE', 'crypto', null, 'BTC'), /applies to stocks only/);
});
check('a search with no word in it finds nothing, and says so, instead of listing the top stories', async () => {
  resetDb([[/FROM articles a/, [{ id: 1, title: 'A top story', summary: 's', source: 'x', published_at: new Date(), event_id: null, tickers: ['AAPL'] }]]]);
  const { searchNews } = require('../server/services/newsSearch');
  for (const q of ['%%%___', 'a', '  ', '!!']) {
    assert.deepStrictEqual(await searchNews({ query: q, tickers: ['AAPL'] }), { mode: 'none', results: [] }, q);
  }
  assert.strictEqual(called(/FROM articles a/).length, 0);
  const { runTool } = require('../server/services/qaTools');
  const r = await runTool({ id: 't', name: 'search_news', input: { query: '%%%___' } }, { userId: 1, holdings: [], heldSet: new Set(['AAPL']) });
  const out = JSON.parse(r.content);
  assert.ok(!r.is_error && out.search_mode === 'none' && out.results.length === 0 && /no word to search for/.test(out.note));
});
check('explain_strategy_signal refuses an id no saved strategy can have, before any query', async () => {
  resetDb();
  const { runTool } = require('../server/services/qaTools');
  const { STRATEGY_EXECUTORS } = require('../server/services/strategyTools');
  for (const strategy_id of ['99999999999999999999', 1e30, 'abc', 0, undefined]) {
    const r = await runTool({ id: 't', name: 'explain_strategy_signal', input: { strategy_id } }, { userId: 1, tier: 'pro', heldSet: new Set() }, STRATEGY_EXECUTORS);
    assert.ok(r.is_error && /strategy_id must be an id from list_my_strategies/.test(r.content), String(strategy_id));
  }
  assert.strictEqual(db.calls.length, 0);
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} QA-finding checks passed`);
})();
