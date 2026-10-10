/**
 * Offline tests for news retention (services/retention.js) and the read path it depends on
 * (signalHistory.js): the two ages, which IPO issues are finished, the roll-up that a pruned
 * story leaves behind, and the archive file. The point of the roll-up tests is one claim —
 * a strategy's sentiment history is the same before and after stories are pruned.
 * No network, no database.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { RETENTION, SENTIMENT, NEWS_SEARCH, QA, IPO_WATCH, FEATURES } = require('../server/config');
const R = require('../server/services/retention');
const { dailySentiment, sentimentSums } = require('../server/services/signalHistory');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}

console.log('retention:');

check('the ages cover everything that reads a stored story', () => {
  // Nothing the app shows may lose a story it still reads.
  assert.ok(RETENTION.USED_DAYS >= SENTIMENT.BASELINE_DAYS, 'the z-score baseline reads this far back');
  assert.ok(RETENTION.USED_DAYS >= NEWS_SEARCH.WINDOW_DAYS, 'news search reads this far back');
  assert.ok(RETENTION.USED_DAYS >= QA.NEWS_DAYS_MAX, 'Ask reads this far back');
  // A newly seen issue is matched against stories fetched this long ago; an unused one must still be there.
  assert.ok(RETENTION.UNUSED_DAYS >= IPO_WATCH.LINK_BACKFILL_DAYS);
  assert.ok(RETENTION.UNUSED_DAYS <= RETENTION.USED_DAYS);
  assert.strictEqual(FEATURES.RETENTION, process.env.RETENTION === '1');   // the job runs on that switch and nothing else
});

check('cutoffs: a story must have been held since before these dates', () => {
  const c = R.cutoffs(new Date('2026-10-10T12:00:00Z'));
  assert.strictEqual(c.unused.toISOString(), '2026-09-10T12:00:00.000Z');   // 30 days
  assert.strictEqual(c.used.toISOString(), '2026-04-13T12:00:00.000Z');     // 180 days
  const own = R.cutoffs(new Date('2026-10-10T12:00:00Z'), { unusedDays: 7, usedDays: 60 });
  assert.deepStrictEqual([own.unused.toISOString().slice(0, 10), own.used.toISOString().slice(0, 10)], ['2026-10-03', '2026-08-11']);
});

check('IPO: only an issue that is finished and off the calendar gives up its stories', () => {
  const ipos = [
    { id: 1, withdrawn: false, listing_date: '2026-05-01' },   // listed long ago, off the calendar
    { id: 2, withdrawn: false, listing_date: '2026-09-30' },   // listed, still shown
    { id: 3, withdrawn: true, listing_date: null },            // withdrawn, off
    { id: 4, withdrawn: false, listing_date: null },           // never listed, aged off: it can still come to market
    { id: 5, withdrawn: true, listing_date: null },            // withdrawn, still shown
  ];
  assert.deepStrictEqual(R.finishedIpoIds(ipos, new Set([2, 5])), [1, 3]);
  assert.deepStrictEqual(R.finishedIpoIds(ipos, new Set([1, 2, 3, 4, 5])), []);
});

// Readings in the shape the live query returns them (READING_COLS), with their ticker.
const day = (d) => `2026-0${d[0]}-${d.slice(1)}`;
const reading = (ticker, date, score, confidence, source, platform = 'news') => ({ ticker, date, score, confidence, source, platform });
const READINGS = [
  reading('AAPL', day('401'), 0.9, 1, 'Reuters'), reading('AAPL', day('401'), 0.1, 1, 'r/stocks', 'reddit'),
  reading('AAPL', day('401'), 0.55, 0.4, 'someblog'), reading('AAPL', day('402'), 0.5, 0, 'someblog'),
  reading('AAPL', day('403'), 0.72, 0.81, 'livemint.com'), reading('AAPL', day('515'), 0.31, 0.66, 'Bloomberg'),
  reading('NVDA', day('401'), 0.8, 0.9, 'Reuters'), reading('NVDA', day('402'), 0.2, 0.7, 'cnbc.com'),
  reading('NVDA', day('402'), 0.33, 0.2, 'x', 'x'), reading('__MARKET__', day('402'), 0.45, 0.5, 'Reuters'),
];
const of = (ticker, rows = READINGS) => rows.filter((r) => r.ticker === ticker);
// sentiment_daily rows as the read query returns them for one ticker.
const stored = (rollup, ticker) => rollup.filter((r) => r.ticker === ticker).map((r) => ({ date: r.day, n_articles: r.n_articles, score_sum: r.score_sum, w_sum: r.w_sum, w_score: r.w_score }));
function same(a, b) {
  assert.strictEqual(a.length, b.length);
  a.forEach((x, i) => {
    assert.deepStrictEqual([x.date, x.n_articles], [b[i].date, b[i].n_articles]);
    for (const k of ['avg_score', 'w_sum', 'w_score']) assert.ok(Math.abs(x[k] - b[i][k]) < 1e-9, `${x.date} ${k}: ${x[k]} vs ${b[i][k]}`);
  });
}

check('roll-up: one row per ticker per day, as sums', () => {
  const rows = R.rollupRows(READINGS);
  assert.deepStrictEqual(rows.map((r) => `${r.ticker} ${r.day} ${r.n_articles}`).sort(),
    ['AAPL 2026-04-01 3', 'AAPL 2026-04-02 1', 'AAPL 2026-04-03 1', 'AAPL 2026-05-15 1', 'NVDA 2026-04-01 1', 'NVDA 2026-04-02 2', '__MARKET__ 2026-04-02 1']);
  const a = rows.find((r) => r.ticker === 'AAPL' && r.day === '2026-04-01');
  assert.ok(Math.abs(a.score_sum - 1.55) < 1e-9);
  assert.deepStrictEqual(R.rollupRows([]), []);
});

check('the history is the same when every story of a ticker has been pruned', () => {
  for (const t of ['AAPL', 'NVDA', '__MARKET__']) same(dailySentiment([], stored(R.rollupRows(READINGS), t)), dailySentiment(of(t)));
});

check('the history is the same when a day is split: some of its stories pruned, some still stored', () => {
  // Pruned by how long a story was held, not by its day, so one day can be in both places.
  for (const cut of [1, 2, 3, 5, 7, 9]) {
    const pruned = READINGS.filter((_, i) => i % cut === 0);
    const kept = READINGS.filter((_, i) => i % cut !== 0);
    for (const t of ['AAPL', 'NVDA']) same(dailySentiment(of(t, kept), stored(R.rollupRows(pruned), t)), dailySentiment(of(t)));
  }
});

check('the history is the same when a day is pruned in two runs (the second adds to the first)', () => {
  const first = R.rollupRows(READINGS.slice(0, 2));
  const second = R.rollupRows(READINGS.slice(2, 5));
  // What the database does on the second run: ON CONFLICT (ticker, day) add each sum.
  const table = new Map();
  for (const r of [...first, ...second]) {
    const k = `${r.ticker}|${r.day}`;
    const cur = table.get(k);
    table.set(k, cur ? { ...cur, n_articles: cur.n_articles + r.n_articles, score_sum: cur.score_sum + r.score_sum, w_sum: cur.w_sum + r.w_sum, w_score: cur.w_score + r.w_score } : r);
  }
  same(dailySentiment(of('AAPL', READINGS.slice(5)), stored([...table.values()], 'AAPL')), dailySentiment(of('AAPL')));
});

check('a ticker with nothing pruned reads as it always did, oldest day first', () => {
  const live = dailySentiment(of('AAPL'));
  same(dailySentiment(of('AAPL'), []), live);
  assert.deepStrictEqual(live.map((d) => d.date), ['2026-04-01', '2026-04-02', '2026-04-03', '2026-05-15']);
  // A pruned day older than every stored one still comes first.
  const out = dailySentiment(of('AAPL').slice(4), stored(R.rollupRows(of('AAPL').slice(0, 4)), 'AAPL'));
  assert.deepStrictEqual(out.map((d) => d.date), live.map((d) => d.date));
  assert.deepStrictEqual(sentimentSums([]), []);
});

check('IPO news summary: what the page last showed, in one row', () => {
  const news = {
    stories: [{ day: '2026-10-09' }, { day: '2026-10-07' }, { day: '2026-10-08' }],
    tone: { score: 0.7, label: 'positive', stories: 2 },
    arc: [{ day: '2026-10-07', stories: 1, score: 0.62 }, { day: '2026-10-09', stories: 1, score: 0.78 }],
  };
  assert.deepStrictEqual(R.ipoSummary(2, news), {
    ipo_id: 2, stories: 3, stories_read: 2, tone_score: 0.7, tone_label: 'positive',
    first_story: '2026-10-07', last_story: '2026-10-09', by_day: news.arc,
  });
  assert.deepStrictEqual(R.ipoSummary(9, { stories: [{ day: '2026-10-03' }], tone: null, arc: [] }),
    { ipo_id: 9, stories: 1, stories_read: 0, tone_score: null, tone_label: null, first_story: '2026-10-03', last_story: '2026-10-03', by_day: [] });
  assert.strictEqual(R.ipoSummary(9, null).stories, 0);
});

check('ingest: with a horizon, a story published before it is not stored again', () => {
  const cutoff = new Date('2026-04-13T12:00:00Z');
  const fetched = [
    { external_id: 'new', published_at: '2026-10-09T08:00:00Z' },
    { external_id: 'old', published_at: '2024-08-30T08:00:00Z' },     // a feed that still lists a two-year-old item
    { external_id: 'edge', published_at: '2026-04-13T12:00:00Z' },    // on the line: kept
    { external_id: 'undated', published_at: null },
  ];
  assert.deepStrictEqual(R.dropTooOld(fetched, cutoff).map((a) => a.external_id), ['new', 'edge', 'undated']);
  assert.strictEqual(R.dropTooOld(fetched, null), fetched);            // nothing ever pruned: everything is let in
});

check('archive: a story is written with its readings, its IPO links and why it went', () => {
  const row = { id: '41', title: 'T', summary: 'S', source: 'livemint.com', published_at: '2026-04-01T08:00:00.000Z', sentiments: [{ ticker: 'AAPL', score: 0.7 }], ipo_links: [] };
  const rec = R.archiveRecord(row, false);
  assert.deepStrictEqual(Object.keys(rec), ['id', 'title', 'summary', 'source', 'published_at', 'class', 'sentiments', 'ipo_links']);
  assert.deepStrictEqual([rec.class, rec.sentiments.length], ['used', 1]);
  assert.strictEqual(R.archiveRecord({ id: '42', title: 'T' }, true).class, 'unused');
  assert.strictEqual(R.archiveName(new Date('2026-10-10T04:45:07.123Z')), 'articles-20261010T044507Z.jsonl.gz');
  assert.ok(path.isAbsolute(R.archiveDirOf()) && R.archiveDirOf().endsWith(path.join('data', 'archive')));
  assert.strictEqual(R.archiveDirOf('/tmp/elsewhere'), '/tmp/elsewhere');
});

check('archive: read back and counted; a file cut short or holding something else is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seniq-retention-'));
  const lines = [41, 42, 43].map((id) => JSON.stringify(R.archiveRecord({ id: String(id), title: `Story ${id}` }, id === 42)));
  const good = path.join(dir, 'good.jsonl.gz');
  fs.writeFileSync(good, zlib.gzipSync(`${lines.join('\n')}\n`));
  assert.deepStrictEqual(await R.readArchive(good), { lines: 3, ids: [41, 42, 43] });
  const noNewline = path.join(dir, 'tail.jsonl.gz');
  fs.writeFileSync(noNewline, zlib.gzipSync(lines.join('\n')));
  assert.strictEqual((await R.readArchive(noNewline)).lines, 3);
  const cut = path.join(dir, 'cut.jsonl.gz');
  fs.writeFileSync(cut, zlib.gzipSync(`${lines[0]}\n${lines[1].slice(0, 20)}`));
  await assert.rejects(() => R.readArchive(cut));
  const halfFile = path.join(dir, 'half.jsonl.gz');                       // the file itself cut off, as a full disk leaves it
  const whole = zlib.gzipSync(`${lines.join('\n')}\n`);
  fs.writeFileSync(halfFile, whole.subarray(0, whole.length - 12));
  await assert.rejects(() => R.readArchive(halfFile));
  await assert.rejects(() => R.readArchive(path.join(dir, 'missing.jsonl.gz')), /ENOENT/);
  const other = path.join(dir, 'other.jsonl.gz');
  fs.writeFileSync(other, zlib.gzipSync('{"not":"a story"}\n'));
  await assert.rejects(() => R.readArchive(other), /is not a story/);
  fs.rmSync(dir, { recursive: true });
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} retention checks passed`);
})();
