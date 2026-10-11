/**
 * Offline tests for the Finnhub gate (services/finnhubGate.js): the two meters, the pace of
 * the background lane, the interactive lane's share of a minute, what happens on a refusal,
 * and that every Finnhub call in the server goes through it. No network, no database: the
 * gate is given its own clock and its own fetch.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FINNHUB } = require('../server/config');
const { createGate, background, currentLane, meterOf, summary } = require('../server/services/finnhubGate');
const { needsPrice } = require('../server/services/outcomes');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}

// A gate on a clock the test moves: sleeping moves it on, and each call sent is written down
// with the time it went.
function testGate({ answer = () => ({ ok: true, status: 200, json: async () => ({}) }), limits = FINNHUB, apiKey = 'k' } = {}) {
  const clock = { t: 1_000_000 };
  const sent = [];
  const warnings = [];
  const gate = createGate({
    limits,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    apiKey: () => apiKey,
    warn: (m) => warnings.push(m),
    fetchImpl: async (url, init) => { sent.push({ at: clock.t, url, init }); return answer(url, sent.length); },
  });
  return { gate, clock, sent, warnings };
}
// The most calls sent in any 60 seconds.
const busiestMinute = (stamps) => Math.max(0, ...stamps.map((t) => stamps.filter((u) => u >= t && u < t + 60_000).length));
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', 'server', ...p), 'utf8');

console.log('the limits:');

check('each meter is held under Finnhub\'s 60 a minute, both lanes together', () => {
  assert.ok(FINNHUB.PER_MINUTE < 60);
  assert.ok(60_000 / FINNHUB.BACKGROUND_GAP_MS + FINNHUB.INTERACTIVE_PER_MINUTE <= FINNHUB.PER_MINUTE);
});
check('company news is one meter, every other path the other', () => {
  assert.deepStrictEqual(['/company-news', '/quote', '/calendar/ipo'].map(meterOf), ['news', 'other', 'other']);
});

console.log('the background lane:');

check('calls go one at a time, the gap apart, in the order asked, the first at once', async () => {
  const { gate, clock, sent } = testGate();
  const start = clock.t;
  await background(() => Promise.all(['A', 'B', 'C', 'D'].map((symbol) => gate.get('/company-news', { symbol }, { purpose: 'held' }))));
  assert.deepStrictEqual(sent.map((s) => new URL(s.url).searchParams.get('symbol')), ['A', 'B', 'C', 'D']);
  assert.deepStrictEqual(sent.map((s) => s.at - start), [0, 1, 2, 3].map((n) => n * FINNHUB.BACKGROUND_GAP_MS));
});
check('a whole run of 107 news calls never has more than 30 in a minute, and none is dropped', async () => {
  const { gate, sent } = testGate();
  const answers = await background(async () => {
    const out = [];
    for (let i = 0; i < 107; i++) out.push(await gate.get('/company-news', { symbol: `T${i}` }, { purpose: 'rotation' }));
    return out;
  });
  assert.strictEqual(sent.length, 107);
  assert.ok(answers.every((a) => a.ok));
  assert.strictEqual(busiestMinute(sent.map((s) => s.at)), 60_000 / FINNHUB.BACKGROUND_GAP_MS);
});
check('a call made after a quiet spell does not wait', async () => {
  const { gate, clock, sent } = testGate();
  await background(() => gate.get('/quote', { symbol: 'A' }));
  clock.t += 10_000;
  const before = clock.t;
  await background(() => gate.get('/quote', { symbol: 'B' }));
  assert.strictEqual(sent[1].at, before);
});
check('a call is background inside background(), across awaits, and interactive anywhere else', async () => {
  assert.strictEqual(currentLane(), 'interactive');
  const inside = await background(async () => { await new Promise((r) => setImmediate(r)); return currentLane(); });
  assert.strictEqual(inside, 'background');
  assert.strictEqual(currentLane(), 'interactive');
});

console.log('the interactive lane:');

check('a page\'s calls go at once, up to its share of the minute; the next is not sent', async () => {
  const { gate, clock, sent } = testGate();
  const start = clock.t;
  const answers = await Promise.all(Array.from({ length: FINNHUB.INTERACTIVE_PER_MINUTE + 3 }, (_, i) => gate.get('/quote', { symbol: `T${i}` }, { purpose: 'quote' })));
  assert.strictEqual(sent.length, FINNHUB.INTERACTIVE_PER_MINUTE);
  assert.ok(sent.every((s) => s.at === start), 'no waiting');
  assert.deepStrictEqual(answers.slice(-3).map((a) => [a.ok, a.status, a.held]), Array(3).fill([false, 0, 'budget']));
});
check('a minute later the page has its share again', async () => {
  const { gate, clock, sent } = testGate();
  for (let i = 0; i <= FINNHUB.INTERACTIVE_PER_MINUTE; i++) await gate.get('/quote', { symbol: 'A' });
  clock.t += 60_000;
  assert.strictEqual((await gate.get('/quote', { symbol: 'A' })).ok, true);
  assert.strictEqual(sent.length, FINNHUB.INTERACTIVE_PER_MINUTE + 1);
});
check('the two meters do not share: a page out of quotes can still ask for news', async () => {
  const { gate } = testGate();
  for (let i = 0; i < FINNHUB.INTERACTIVE_PER_MINUTE; i++) await gate.get('/quote', { symbol: 'A' });
  assert.strictEqual((await gate.get('/quote', { symbol: 'A' })).held, 'budget');
  assert.strictEqual((await gate.get('/company-news', { symbol: 'A' })).ok, true);
});
check('a run and a busy page together stay inside the minute\'s limit', async () => {
  const { gate, sent } = testGate();
  // A page asks as fast as it can while the pipeline's run goes on: 5 more interactive
  // calls before each background one.
  const page = () => Promise.all(Array.from({ length: 5 }, () => gate.get('/company-news', { symbol: 'P' }, { purpose: 'lookup', lane: 'interactive' })));
  await background(async () => {
    for (let i = 0; i < 90; i++) {
      await page();
      await gate.get('/company-news', { symbol: `T${i}` }, { purpose: 'rotation' });
    }
  });
  const busiest = busiestMinute(sent.map((s) => s.at));
  assert.ok(busiest <= FINNHUB.PER_MINUTE, `busiest minute: ${busiest}`);
  assert.ok(busiest > 60_000 / FINNHUB.BACKGROUND_GAP_MS, 'the page did get calls through');
  assert.strictEqual(sent.filter((s) => s.url.includes('symbol=T')).length, 90, 'the run lost no call to the page');
});

console.log('a refusal, and a request that fails:');

check('a 429 is handed back once, counted, and logged beside the gate\'s own count', async () => {
  const { gate, sent, warnings } = testGate({ answer: () => ({ ok: false, status: 429, headers: { get: (h) => (h === 'x-ratelimit-remaining' ? '0' : null) }, json: async () => ({}) }) });
  const r = await background(() => gate.get('/company-news', { symbol: 'A' }, { purpose: 'rotation' }));
  assert.deepStrictEqual([r.ok, r.status, r.held], [false, 429, null]);
  assert.strictEqual(sent.length, 1, 'not retried');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /refused a news call \(rotation, background\): the gate had sent 1 in the last minute, its limit is 50; Finnhub says 0 left/);
  assert.strictEqual(gate.takeCounts().news.refused, 1);
});
check('a request that fails outright is status 0, and so is one that takes too long', async () => {
  const down = testGate({ answer: () => { throw new Error('network down'); } });
  assert.deepStrictEqual(await down.gate.get('/quote', { symbol: 'A' }), { ok: false, status: 0, data: null, held: null });
  const slow = createGate({ apiKey: () => 'k', fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  assert.deepStrictEqual(await slow.get('/quote', { symbol: 'A' }, { timeoutMs: 5 }), { ok: false, status: 0, data: null, held: null });
});
check('any other refusal is handed back with its status', async () => {
  const { gate } = testGate({ answer: () => ({ ok: false, status: 403, json: async () => ({}) }) });
  assert.deepStrictEqual(await gate.get('/company-news', { symbol: 'BF.B' }), { ok: false, status: 403, data: null, held: null });
});
check('no key: nothing is sent', async () => {
  const { gate, sent } = testGate({ apiKey: '' });
  assert.strictEqual((await gate.get('/quote', { symbol: 'A' })).held, 'no_key');
  assert.strictEqual(sent.length, 0);
});

console.log('what a call carries, and the run\'s log line:');

check('the key goes in a header, never in the address', async () => {
  const { gate, sent } = testGate({ apiKey: 'secret-key' });
  await gate.get('/company-news', { symbol: 'BF.B', from: '2026-10-04', to: '2026-10-11' });
  assert.strictEqual(sent[0].url, `${FINNHUB.BASE_URL}/company-news?symbol=BF.B&from=2026-10-04&to=2026-10-11`);
  assert.strictEqual(sent[0].init.headers['X-Finnhub-Token'], 'secret-key');
});
check('calls are counted by meter and purpose, and the count starts again once read', async () => {
  const { gate } = testGate();
  await background(async () => {
    await gate.get('/company-news', { symbol: 'A' }, { purpose: 'held' });
    await gate.get('/company-news', { symbol: 'B' }, { purpose: 'rotation' });
    await gate.get('/company-news', { symbol: 'C' }, { purpose: 'rotation' });
    await gate.get('/quote', { symbol: 'A' }, { purpose: 'quote' });
  });
  const counts = gate.takeCounts();
  assert.strictEqual(summary(counts), 'news 3 (held 1, rotation 2); other 1 (quote 1)');
  assert.strictEqual(summary(gate.takeCounts()), 'news 0; other 0');
  assert.strictEqual(summary({ news: { calls: 12, byPurpose: { rotation: 12 }, refused: 1, held: 0 }, other: { calls: 20, byPurpose: { quote: 20 }, refused: 0, held: 4 } }),
    'news 12 (rotation 12), 1 refused; other 20 (quote 20), 4 not sent');
});

console.log('every caller:');

check('no file but the config names Finnhub\'s address: every call goes through the gate', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  const root = path.join(__dirname, '..');
  const naming = [...walk(path.join(root, 'server')), ...walk(path.join(root, 'scripts'))]
    .filter((f) => fs.readFileSync(f, 'utf8').includes('finnhub.io'))
    .map((f) => path.relative(root, f));
  assert.deepStrictEqual(naming, ['server/config.js']);
});
check('the news fetch, the quotes and the IPO calendar each ask the gate', () => {
  assert.match(src('services', 'ingest', 'finnhub.js'), /gate\.get\('\/company-news'/);
  assert.match(src('services', 'priceService.js'), /finnhubGate\.get\('\/quote'/);
  assert.match(src('services', 'ipoWatch', 'sources', 'finnhub.js'), /finnhubGate\.get\(\s*'\/calendar\/ipo'/);
});
check('every scheduled job runs on the background lane', () => {
  const start = src('scheduler.js').split('function startScheduler() {')[1];
  const scheduled = start.match(/(?:setTimeout\(|cron\.schedule\([^,]+, )(\w+)/g) || [];
  assert.ok(scheduled.length >= 10);
  assert.ok(scheduled.every((s) => s.endsWith('job')), `not wrapped: ${scheduled.filter((s) => !s.endsWith('job')).join(' | ')}`);
  assert.match(start, /const job = \(fn\) => \(\) => finnhubGate\.background\(fn\);/);
});

console.log('prices in the outcome step:');

check('a starting price is asked for only where an event has none', () => {
  const rows = [
    { primary_ticker: 'AAPL', priced: true }, { primary_ticker: 'AAPL', priced: true },
    { primary_ticker: 'MSFT', priced: false }, { primary_ticker: 'MSFT', priced: true },
    { primary_ticker: 'NVDA', priced: false }, { primary_ticker: 'NVDA', priced: false },
  ];
  assert.deepStrictEqual(needsPrice(rows), ['MSFT', 'NVDA']);
  assert.deepStrictEqual(needsPrice(rows.filter((r) => r.priced)), []);
  const code = src('services', 'outcomes.js');
  assert.match(code, /eo\.price_at_event IS NOT NULL\) AS priced/);
  assert.match(code, /toPrice\.length \? await getQuotes\(toPrice\.map/);
});
check('a later price is asked for only once its 1-day or 3-day mark has come', () => {
  const code = src('services', 'outcomes.js');
  assert.match(code, /eo\.price_1d IS NULL AND eo\.logged_at <= now\(\) - interval '1 day'/);
  assert.match(code, /eo\.price_3d IS NULL AND eo\.logged_at <= now\(\) - interval '3 days'/);
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} Finnhub gate checks passed`);
})();
