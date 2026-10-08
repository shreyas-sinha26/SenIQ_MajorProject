/**
 * Offline tests for the Analytics page's sentiment breakdown (no DB, no network).
 * Run: node test/sentimentBreakdown.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('assert');
const { buildSentimentBreakdown } = require('../server/services/sentimentBreakdown');
const { computeWindowedSentiment } = require('../server/services/sentimentScoring');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('sentimentBreakdown.test.js');
const NOW = Date.parse('2026-10-12T12:00:00Z');
const H = 3_600_000;
let id = 0;
const art = (hoursAgo, score, extra = {}) => ({ id: ++id, event_id: id, title: `Story ${id}`, url: '#', source: 'reuters', platform: 'news', confidence: 0.9, score, published_at: new Date(NOW - hoursAgo * H).toISOString(), ...extra });
// AAA: a steady 0.7 for weeks, then a bad three days. BBB: upbeat today, no history. CCC: silent.
const rows = {
  AAA: [...Array.from({ length: 20 }, (_, i) => art(24 * (10 + i), 0.7)), art(5, 0.1), art(20, 0.2), art(40, 0.2), art(60, 0.7)],
  BBB: [art(2, 0.9), art(30, 0.8)],
};
const holdings = [
  { ticker: 'AAA', company_name: 'Alpha', exposure_pct: 70, change_pct: -1.2 },
  { ticker: 'BBB', company_name: 'Beta', exposure_pct: 20, change_pct: 0.4 },
  { ticker: 'CCC', company_name: 'Gamma', exposure_pct: 10, change_pct: null },
];
const full = buildSentimentBreakdown(holdings, rows, { full: true, now: NOW });
const [aaa, bbb, ccc] = full.holdings;

check('each holding carries the engine\'s own score and label', () => {
  const engine = computeWindowedSentiment(rows.AAA, NOW);
  assert.strictEqual(aaa.score, Math.round(engine.acute.score * 100));
  assert.strictEqual(aaa.label, engine.acute.label);
  assert.strictEqual(aaa.articles, 4);
});
check('the article split counts only the acute window and adds up to the article count', () => {
  assert.deepStrictEqual(aaa.split, { positive: 1, neutral: 0, negative: 3 });
  assert.deepStrictEqual(bbb.split, { positive: 2, neutral: 0, negative: 0 });
  assert.strictEqual(aaa.split.positive + aaa.split.neutral + aaa.split.negative, aaa.articles);
});
check('a holding with history gets its own normal and a z below it; one without gets none', () => {
  assert.ok(aaa.baseline.usual >= 60 && aaa.baseline.z < -1, JSON.stringify(aaa.baseline));
  assert.deepStrictEqual([bbb.baseline.usual, bbb.baseline.z], [null, null]);
});
check('drivers name the stories, in the right unit, and the worst news leads', () => {
  assert.strictEqual(aaa.driver_unit, 'sigma');
  assert.strictEqual(bbb.driver_unit, 'points');
  assert.ok(aaa.drivers.length === 3 && aaa.drivers[0].direction === 'down' && aaa.drivers[0].contribution < 0);
  assert.ok(bbb.drivers.every((d) => d.direction === 'up' && d.contribution > 0));
});
check('the daily trend is one point per day, oldest first, on the 0–100 scale', () => {
  assert.ok(aaa.trend.length >= 4);
  assert.deepStrictEqual(aaa.trend.map((d) => d.date), aaa.trend.map((d) => d.date).slice().sort());
  assert.ok(aaa.trend.every((d) => d.score >= 0 && d.score <= 100 && d.articles >= 1));
});
check('a holding with no recent articles is marked, and left out of the portfolio figures', () => {
  assert.deepStrictEqual([ccc.has_news, ccc.articles, ccc.score], [false, 0, 50]);
  assert.deepStrictEqual([full.portfolio.holdings, full.portfolio.with_news], [3, 2]);
});
check('the weighted score leans toward the larger position; lift and drag are named', () => {
  const p = full.portfolio;
  assert.strictEqual(p.score, Math.round((aaa.score + bbb.score) / 2));
  assert.strictEqual(p.weighted_score, Math.round((aaa.score * 70 + bbb.score * 20) / 90));
  assert.ok(p.weighted_score < p.score);
  assert.deepStrictEqual([p.biggest_drag.ticker, p.biggest_lift.ticker], ['AAA', 'BBB']);
  assert.deepStrictEqual([p.positive, p.neutral, p.negative], [1, 0, 1]);
});
check('the basic depth (Free) leaves out the normal and the stories', () => {
  const basic = buildSentimentBreakdown(holdings, rows, { full: false, now: NOW });
  assert.strictEqual(basic.depth, 'basic');
  assert.ok(basic.holdings.every((h) => h.baseline === undefined && h.drivers === undefined));
  assert.strictEqual(basic.holdings[0].score, aaa.score);
});
check('no holdings gives an empty, well-formed answer', () => {
  const none = buildSentimentBreakdown([], {}, { now: NOW });
  assert.deepStrictEqual([none.holdings.length, none.portfolio.weighted_score, none.portfolio.label], [0, null, 'neutral']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
