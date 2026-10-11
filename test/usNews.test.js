/**
 * Offline tests for US coverage (services/usNews.js): the rule that a US listed name is
 * tagged only on a story from its own ticker's feed, the rotation's fetch and what ends it,
 * the feeds a story carries through de-duplication, and which stories the rotation brings in
 * are kept. No network, no database.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FEATURES, US_NEWS, FINNHUB } = require('../server/config');
const { buildResolver, universeRows, isUsListed } = require('../server/services/entityResolver');
const { fetchRotation, fetchRun } = require('../server/services/ingest/finnhub');
const { createGate, background } = require('../server/services/finnhubGate');
const { dedupe } = require('../server/services/ingest');
const U = require('../server/services/usNews');

const { companies, executives } = universeRows();
const { resolve } = buildResolver(companies, executives);
const tk = (title, summary, held, feeds) => resolve(title, summary, held.map((ticker) => ({ ticker })), feeds).tickers.sort();

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}

console.log('a US listed name and its own feed:');

check('which names the rule is for: US listed, not Indian listed, not curated, not unknown', () => {
  assert.ok(isUsListed('DLB') && isUsListed('CL') && isUsListed('cmi'));
  assert.ok(!isUsListed('COLPAL') && !isUsListed('BANKBARODA'));
  assert.ok(!isUsListed('AAPL') && !isUsListed('RELIANCE') && !isUsListed('NOTATICKER'));
});
check('written exactly like its Indian namesake, in a story from a general feed, it is not tagged', () => {
  const title = 'Colgate-Palmolive shares slip 2% after weak Q2 volume growth';
  assert.deepStrictEqual(tk(title, '', ['CL'], []), []);
  assert.deepStrictEqual(tk(title, '', ['CL'], ['AAPL']), []);         // another ticker's feed is not its own
  assert.deepStrictEqual(tk(title, '', ['CL'], ['CL']), ['CL']);
  assert.deepStrictEqual(tk(title, '', ['CL'], null), ['CL']);         // feeds not known: as it was
  assert.deepStrictEqual(tk(title, '', ['CL']), ['CL']);
});
check('a passing mention in a general feed\'s summary is not tagged', () => {
  const pvr = ['PVR Inox opens 5-screen multiplex at MyMoon, Kochi', 'The cinema is equipped with 4K laser projection, Dolby Atmos immersive sound and RealD 3D.'];
  const kirloskar = ['Is Kirloskar Oil Engines stock running ahead of fundamentals after 25% jump this week?', 'Kirloskar Oil Engines shares hit a 52-week high after breaking into a segment dominated by Cummins.'];
  assert.deepStrictEqual(tk(...pvr, ['DLB'], []), []);
  assert.deepStrictEqual(tk(...kirloskar, ['CMI'], []), []);
  assert.deepStrictEqual(tk(...pvr, ['DLB'], null), ['DLB']);          // what it did before
});
check('its own feed is not enough: the story must name it', () => {
  assert.deepStrictEqual(tk('Tech stocks rally as yields ease', 'The Nasdaq rose 1.2%.', ['DLB'], ['DLB']), []);
  assert.deepStrictEqual(tk('Dolby Laboratories raises its dividend', '', ['DLB'], ['DLB']), ['DLB']);
});
check('the rule is for US listed names only', () => {
  // An Indian listed name, a curated name and a holding outside the reference match as before.
  assert.deepStrictEqual(tk('Bank of Baroda eases for fifth straight session', '', ['BANKBARODA'], []), ['BANKBARODA']);
  assert.deepStrictEqual(tk('Apple unveils a new iPhone', '', ['DLB'], []), ['AAPL']);
  assert.deepStrictEqual(resolve('Zerodha files for an IPO', '', [{ ticker: 'ZERODHA', name: 'Zerodha' }], []).tickers, ['ZERODHA']);
  // A second share class is the same company as the curated one, whatever the feed.
  assert.deepStrictEqual(tk('Google unveils new Gemini model', '', ['GOOG'], []), ['GOOG', 'GOOGL']);
});
check('a story from a US name\'s feed about a curated company is that company\'s', () => {
  assert.deepStrictEqual(tk('Apple and Dolby extend their Atmos licence', '', ['DLB'], ['DLB']), ['AAPL', 'DLB']);
  assert.deepStrictEqual(tk('Apple cuts iPhone prices in India', 'Analysts see margin pressure.', ['DLB'], ['DLB']), ['AAPL']);
});

console.log('the rotation:');

check('off unless US_LISTED_NEWS=1, and the size of a run', () => {
  assert.strictEqual(FEATURES.US_LISTED_NEWS, process.env.US_LISTED_NEWS === '1');
  assert.strictEqual(US_NEWS.PER_RUN, 90);
  // A whole run's news calls go out, at the background lane's pace, before the next run starts.
  assert.ok(FINNHUB.NEWS_CALLS_PER_RUN * FINNHUB.BACKGROUND_GAP_MS < 10 * 60_000, 'a run every 10 minutes');
  assert.ok(US_NEWS.PER_RUN < FINNHUB.NEWS_CALLS_PER_RUN);
});
check('a run takes what is left of its calls after the held and IPO tickers', () => {
  const limits = { PER_RUN: 30, CALLS_PER_RUN: 50 };
  assert.strictEqual(U.batchSize(0, limits), 30);
  assert.strictEqual(U.batchSize(20, limits), 30);
  assert.strictEqual(U.batchSize(35, limits), 15);
  assert.strictEqual(U.batchSize(50, limits), 0);
  assert.strictEqual(U.batchSize(400, limits), 0);
  // As configured: all 90 beside today's 8 held and 9 IPO Watch tickers, fewer past about 150.
  assert.strictEqual(U.batchSize(17), 90);
  assert.strictEqual(U.batchSize(FINNHUB.NEWS_CALLS_PER_RUN - 40), 40);
  assert.strictEqual(U.batchSize(FINNHUB.NEWS_CALLS_PER_RUN), 0);
});
check('the curated names have a few of a run\'s places to themselves, and keep their share as it shrinks', () => {
  assert.ok(US_NEWS.CURATED_PER_RUN > 0 && US_NEWS.CURATED_PER_RUN < US_NEWS.PER_RUN, 'both queues move');
  const limits = { PER_RUN: 30, CURATED_PER_RUN: 5 };
  assert.deepStrictEqual([30, 15, 6, 3, 2, 1, 0].map((n) => U.curatedShare(n, limits)), [5, 3, 1, 1, 0, 0, 0]);
  // About 100 curated names and 1,400 others: the curated ones come round about three times as often.
  assert.ok(100 / U.curatedShare(US_NEWS.PER_RUN) < 1400 / (US_NEWS.PER_RUN - U.curatedShare(US_NEWS.PER_RUN)) / 2);
});
check('a run\'s names are picked from the two queues, curated first, spare places to the rest', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'usNews.js'), 'utf8');
  assert.match(src, /const curated = await pick\(CURATED, curatedShare\(n\)\);/);
  assert.match(src, /pick\(THE_REST, n - curated\.length\)/);
  assert.match(src, /const THE_REST = "tier IS DISTINCT FROM 'curated'"/);   // the listed tier and graduated IPOs
});
const story = (id, headline) => ({ id, headline, summary: '', source: 'Yahoo', url: `https://example.com/${id}`, image: '', datetime: 1791000000 });
const answers = (byTicker, asked = []) => async (url) => {
  const sym = new URL(url).searchParams.get('symbol');
  asked.push(sym);
  const a = byTicker[sym];
  if (a === 'throw') throw new Error('network down');
  if (typeof a === 'number') return { ok: false, status: a, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => a };
};
// A gate that answers from `byTicker` and never waits (its pacing has its own tests).
const gateFor = (byTicker, asked, apiKey = 'k') => createGate({ fetchImpl: answers(byTicker, asked), apiKey: () => apiKey, sleep: async () => {}, warn: () => {} });
const rotate = (tickers, byTicker, apiKey) => background(() => fetchRotation(tickers, { gate: gateFor(byTicker, [], apiKey) }));
check('each story says whose feed it came from and that the rotation brought it', async () => {
  const r = await rotate(['DLB', 'CMI'], { DLB: [story(1, 'Dolby raises dividend')], CMI: [] });
  assert.deepStrictEqual(r.checked, ['DLB', 'CMI']);
  assert.strictEqual(r.stopped, null);
  assert.deepStrictEqual(r.articles.map((a) => [a.external_id, a.feeds, a.rotationOnly]), [['finnhub_1', ['DLB'], true]]);
});
check('a rate-limit refusal ends the run, and the names not reached are not checked', async () => {
  const r = await rotate(['A', 'AA', 'AAL', 'AAON'], { A: [story(1, 'x')], AA: [], AAL: 429, AAON: [story(2, 'y')] });
  assert.deepStrictEqual(r.checked, ['A', 'AA']);
  assert.strictEqual(r.stopped, 'rate_limit');
  assert.strictEqual(r.articles.length, 1);
});
check('a request that fails outright ends the run too; any other refusal counts as checked', async () => {
  const down = await rotate(['A', 'AA'], { A: 'throw', AA: [] });
  assert.deepStrictEqual([down.checked, down.stopped], [[], 'unreachable']);
  // A ticker Finnhub refuses for itself (403) must not hold up the queue.
  const odd = await rotate(['BF.B', 'AA'], { 'BF.B': 403, AA: [story(3, 'z')] });
  assert.deepStrictEqual([odd.checked, odd.stopped, odd.articles.length], [['BF.B', 'AA'], null, 1]);
});
check('no key, no calls', async () => {
  const asked = [];
  const r = await background(() => fetchRotation(['A'], { gate: gateFor({ A: [] }, asked, '') }));
  assert.deepStrictEqual([r.checked, r.articles, r.stopped, asked], [[], [], null, []]);
});
check('a ticker gives at most its newest ten', async () => {
  const many = Array.from({ length: 25 }, (_, i) => story(100 + i, `story ${i}`));
  const r = await rotate(['A'], { A: many });
  assert.strictEqual(r.articles.length, US_NEWS.STORIES_PER_NAME);
});
check('a run asks in a fixed order: held, then IPO Watch, then the rotation, which alone is marked', async () => {
  const asked = [];
  const gate = gateFor({ AAPL: [story(1, 'a')], NEWCO: [story(2, 'b')], DLB: [story(3, 'c')], CMI: [] }, asked);
  const r = await background(() => fetchRun({ held: ['AAPL'], ipo: ['NEWCO'], rotation: ['DLB', 'CMI'] }, { gate }));
  assert.deepStrictEqual(asked, ['AAPL', 'NEWCO', 'DLB', 'CMI']);
  assert.deepStrictEqual(r.checked, { held: ['AAPL'], ipo: ['NEWCO'], rotation: ['DLB', 'CMI'] });
  assert.deepStrictEqual(r.articles.map((a) => [a.feeds[0], !!a.rotationOnly]), [['AAPL', false], ['NEWCO', false], ['DLB', true]]);
  assert.deepStrictEqual(gate.takeCounts().news.byPurpose, { held: 1, ipo: 1, rotation: 2 });
});
check('a refusal stops the whole run: nothing after it is asked for, and nothing is asked twice', async () => {
  const asked = [];
  const gate = gateFor({ AAPL: [], MSFT: 429, NEWCO: [], DLB: [] }, asked);
  const r = await background(() => fetchRun({ held: ['AAPL', 'MSFT', 'NVDA'], ipo: ['NEWCO'], rotation: ['DLB'] }, { gate }));
  assert.deepStrictEqual(asked, ['AAPL', 'MSFT']);
  assert.deepStrictEqual([r.checked, r.stopped], [{ held: ['AAPL'], ipo: [], rotation: [] }, 'rate_limit']);
});
check('a page\'s call the gate does not send ends its list as not sent', async () => {
  const asked = [];
  const gate = createGate({ fetchImpl: answers({ A: [], B: [] }, asked), apiKey: () => 'k', limits: { ...FINNHUB, INTERACTIVE_PER_MINUTE: 1 }, warn: () => {} });
  const r = await fetchRun({ held: ['A', 'B'], purpose: 'lookup' }, { gate });      // not inside background()
  assert.deepStrictEqual([asked, r.checked.held, r.stopped], [['A'], ['A'], 'not_sent']);
});

console.log('the feeds a story carries:');

check('the same story from two feeds is one story with both', () => {
  const a = { external_id: 'finnhub_1', title: 'Apple and Dolby extend licence', url: 'https://x/1', feeds: ['AAPL'] };
  const b = { external_id: 'finnhub_1', title: 'Apple and Dolby extend licence', url: 'https://x/1', feeds: ['DLB'], rotationOnly: true };
  const [one, ...rest] = dedupe([a, b]);
  assert.strictEqual(rest.length, 0);
  assert.deepStrictEqual(one.feeds, ['AAPL', 'DLB']);
  assert.ok(!one.rotationOnly, 'a held ticker fetched it too');
  assert.deepStrictEqual(a.feeds, ['AAPL'], 'the caller\'s article is not changed');
});
check('brought in by the rotation alone only while every copy was', () => {
  const r1 = { external_id: 'finnhub_2', title: 't', url: 'https://x/2', feeds: ['DLB'], rotationOnly: true };
  const r2 = { external_id: 'finnhub_2', title: 't', url: 'https://x/2', feeds: ['CMI'], rotationOnly: true };
  assert.deepStrictEqual(dedupe([r1, r2]).map((x) => [x.feeds, x.rotationOnly]), [[['DLB', 'CMI'], true]]);
  const rss = { external_id: 'rss_9', title: 't', url: 'https://x/2' };            // the same link from a general feed
  assert.deepStrictEqual(dedupe([r1, rss]).map((x) => [x.feeds, !!x.rotationOnly]), [[['DLB'], false]]);
  assert.deepStrictEqual(dedupe([rss, r1]).map((x) => [x.feeds, !!x.rotationOnly]), [[['DLB'], false]]);
});
check('a stored story that turns up in a US listed name\'s feed is read once more for it', () => {
  const stored = [{ external_id: 'finnhub_1', feeds: ['AAPL'] }, { external_id: 'finnhub_2', feeds: ['AAPL', 'DLB'] }, { external_id: 'finnhub_3', feeds: [] }];
  const fetched = [
    { external_id: 'finnhub_1', feeds: ['AAPL', 'DLB'] },   // DLB's feed is new
    { external_id: 'finnhub_2', feeds: ['DLB'] },           // already recorded
    { external_id: 'finnhub_3', feeds: ['AAPL'] },          // a curated name's feed changes nothing
    { external_id: 'finnhub_4', feeds: ['CMI'] },           // not stored yet
    { external_id: 'rss_1' },
  ];
  assert.deepStrictEqual([...U.gainedFeeds(fetched, stored)], [['finnhub_1', ['DLB']]]);
});

console.log('what the rotation brings in:');

check('a story about a company is kept; one about none is dropped before its tone is read', () => {
  const rot = (title) => ({ title, rotationOnly: true });
  assert.ok(U.worthReading(rot('Dolby Laboratories raises its dividend'), ['DLB'], ['DLB']));
  assert.ok(!U.worthReading(rot('Fed holds rates as war fears lift oil'), [], []));
  // A roundup lists companies and is about none of them.
  assert.ok(!U.worthReading(rot('Stocks to watch: Apple, Dolby, Cummins'), ['AAPL', 'DLB', 'CMI'], ['AAPL', 'DLB', 'CMI']));
  // Under a broad-market headline, a company named only in the summary is a passing mention.
  assert.ok(!U.worthReading(rot('Wall Street ends higher as tech rallies'), ['DLB'], []));
});
check('a story a held ticker or a general feed brought in is never dropped here', () => {
  assert.ok(U.worthReading({ title: 'Fed holds rates as war fears lift oil' }, [], []));
  assert.ok(U.worthReading({ title: 'Stocks to watch: Apple, Dolby', feeds: ['AAPL'] }, ['AAPL'], ['AAPL']));
});

console.log('the pipeline and the table:');

check('migration 0044 adds the two columns the pipeline writes', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'migrations', '0044_us_news.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE companies ADD COLUMN IF NOT EXISTS news_checked_at TIMESTAMPTZ/);
  assert.match(sql, /ALTER TABLE articles\s+ADD COLUMN IF NOT EXISTS feeds TEXT\[\] NOT NULL DEFAULT '\{\}'/);
  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'server', 'scheduler.js'), 'utf8');
  assert.match(scheduler, /is_relevant, sectors, feeds\)/);
});
check('outcome logging stays on curated names and holdings', () => {
  // Each ticker logged costs a price quote when its event is new; the listed names nobody holds would add hundreds.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'outcomes.js'), 'utf8');
  assert.match(sql, /c\.tier = 'curated'/);
  assert.match(sql, /FROM portfolio p WHERE p\.ticker = e\.primary_ticker/);
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} US coverage checks passed`);
})();
