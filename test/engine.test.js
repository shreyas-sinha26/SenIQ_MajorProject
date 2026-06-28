/**
 * Offline logic tests for E2 — event typing + the 6-factor impact score. No DB.
 * Run via `npm test` (alongside entityResolver.test.js).
 */

const assert = require('node:assert');
const { classifyEventType } = require('../server/services/eventTyping');
const { impactForEvent } = require('../server/services/impactScoring');
const { planDeliveries, inQuietWindow, isPostWatermark } = require('../server/services/materiality');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('eventTyping:');
const ty = (t, tier = 'holding') => classifyEventType(t, '', tier);
check('M&A', () => assert.strictEqual(ty('Reliance to acquire stake in startup'), 'ma'));
check('legal', () => assert.strictEqual(ty('SEBI probe into company books'), 'legal'));
check('disruption', () => assert.strictEqual(ty('Factory fire halts production'), 'disruption'));
check('executive', () => assert.strictEqual(ty('TCS CEO resigns unexpectedly'), 'executive'));
check('earnings', () => assert.strictEqual(ty('Infosys Q1 net profit jumps 12%'), 'earnings'));
check('guidance', () => assert.strictEqual(ty('Company cuts FY25 guidance'), 'guidance'));
check('rating (analyst target ≠ guidance)', () => assert.strictEqual(ty('Brokerage downgrades stock, cuts target price'), 'rating'));
check('product', () => assert.strictEqual(ty('Apple unveils new iPhone'), 'product'));
check('macro from market tier', () => assert.strictEqual(ty('Sensex tanks 700 pts on selloff', 'market'), 'macro'));
check('other fallback', () => assert.strictEqual(ty('Company hosts annual general meeting'), 'other'));

console.log('\nimpactForEvent (6-factor):');
const now = Date.UTC(2026, 5, 23, 12, 0, 0);
const fresh = new Date(now - 3600 * 1000).toISOString(); // 1h old
// Direct holding, big negative earnings miss, surprising (z=-2.5)
const earnings = { event_id: 1, event_type: 'earnings', sectors: [], last_seen: fresh, tickers: { AAPL: { score: 0.1, confidence: 0.9 } }, isMacro: false };
const holdAAPL = [{ ticker: 'AAPL', exposure_pct: 50, sector: 'Technology' }];

check('direct holding produces impact + negative direction', () => {
  const r = impactForEvent(earnings, holdAAPL, { AAPL: -2.5 }, now);
  assert.ok(r.impact > 0, `impact ${r.impact}`);
  assert.strictEqual(r.direction, 'negative');
  assert.ok(r.exposure_pct === 50, `exposure ${r.exposure_pct}`);
});

check('higher severity type scores higher than low severity, all else equal', () => {
  const ma = { ...earnings, event_type: 'ma' };
  const rating = { ...earnings, event_type: 'rating' };
  const hi = impactForEvent(ma, holdAAPL, {}, now).impact;
  const lo = impactForEvent(rating, holdAAPL, {}, now).impact;
  assert.ok(hi > lo, `ma ${hi} should beat rating ${lo}`);
});

check('z-surprise amplifies (novelty)', () => {
  const surprising = impactForEvent(earnings, holdAAPL, { AAPL: -3 }, now).impact;
  const expected = impactForEvent(earnings, holdAAPL, { AAPL: 0 }, now).impact;
  assert.ok(surprising > expected, `surprising ${surprising} > expected ${expected}`);
});

check('recency: older event scores lower', () => {
  const old = { ...earnings, last_seen: new Date(now - 14 * 24 * 3600 * 1000).toISOString() };
  assert.ok(impactForEvent(earnings, holdAAPL, {}, now).impact > impactForEvent(old, holdAAPL, {}, now).impact);
});

check('sector event touches a holding in that sector (diluted)', () => {
  const sectorEvt = { event_id: 2, event_type: 'macro', sectors: ['Technology'], last_seen: fresh, tickers: {}, isMacro: true, macroScore: 0.15 };
  const r = impactForEvent(sectorEvt, holdAAPL, {}, now);
  assert.ok(r.impact > 0, 'sector holding should be impacted');
  // but less than the same-magnitude DIRECT hit
  const direct = impactForEvent({ ...earnings, event_type: 'macro' }, holdAAPL, {}, now);
  assert.ok(r.impact < direct.impact, `sector ${r.impact} < direct ${direct.impact}`);
});

check('unrelated holding gets zero impact', () => {
  const r = impactForEvent(earnings, [{ ticker: 'XOM', exposure_pct: 100, sector: 'Energy' }], {}, now);
  assert.strictEqual(r.impact, 0);
});

console.log('\nplanDeliveries (alert budgets):');
const budget = { MAX_REALTIME_PER_DAY: 3, PER_TICKER_COOLDOWN_HOURS: 12, QUIET_HOURS_ENABLED: false, QUIET_START: 22, QUIET_END: 7 };
const mk = (user_id, ticker, priority) => ({ user_id, ticker, priority });
const deliveries = (cands, state) => planDeliveries(cands, { budget, ...state }).map((c) => c.delivery);

check('top MAX go realtime, rest digest (by priority)', () => {
  const cands = [mk(1, 'AAPL', 0.1), mk(1, 'MSFT', 0.9), mk(1, 'NVDA', 0.5), mk(1, 'TSLA', 0.7), mk(1, 'AMZN', 0.3)];
  planDeliveries(cands, { budget, nowHour: 12 });
  const rt = cands.filter((c) => c.delivery === 'realtime').map((c) => c.ticker).sort();
  assert.deepStrictEqual(rt, ['MSFT', 'NVDA', 'TSLA']); // top 3 by priority
});

check('per-ticker cooldown forces digest', () => {
  const cands = [mk(1, 'AAPL', 0.9)];
  planDeliveries(cands, { budget, nowHour: 12, cooldownByUser: { 1: new Set(['AAPL']) } });
  assert.strictEqual(cands[0].delivery, 'digest');
});

check('daily budget already spent → digest', () => {
  const cands = [mk(1, 'AAPL', 0.9)];
  planDeliveries(cands, { budget, nowHour: 12, sentTodayByUser: { 1: 3 } });
  assert.strictEqual(cands[0].delivery, 'digest');
});

check('MARKET alerts skip cooldown but count to budget', () => {
  const cands = [mk(1, 'MARKET', 0.9), mk(1, 'MARKET', 0.8)];
  planDeliveries(cands, { budget, nowHour: 12, cooldownByUser: { 1: new Set(['MARKET']) } });
  assert.deepStrictEqual(cands.map((c) => c.delivery), ['realtime', 'realtime']); // cooldown ignored for MARKET
});

check('quiet hours hold everything to digest', () => {
  const qb = { ...budget, QUIET_HOURS_ENABLED: true, QUIET_START: 22, QUIET_END: 7 };
  const cands = [mk(1, 'AAPL', 0.9)];
  planDeliveries(cands, { budget: qb, nowHour: 23 });
  assert.strictEqual(cands[0].delivery, 'digest');
});

check('inQuietWindow overnight wrap', () => {
  const b = { QUIET_HOURS_ENABLED: true, QUIET_START: 22, QUIET_END: 7 };
  assert.ok(inQuietWindow(23, b) && inQuietWindow(3, b) && !inQuietWindow(12, b));
});

console.log('\nisPostWatermark (E4 monitoring-since gate):');
const T0 = '2026-06-20T00:00:00Z';
const T1 = '2026-06-25T00:00:00Z';
check('no watermark → allow', () => assert.strictEqual(isPostWatermark(T0, null), true));
check('event after watermark → allow', () => assert.strictEqual(isPostWatermark(T1, T0), true));
check('event before watermark → suppress', () => assert.strictEqual(isPostWatermark(T0, T1), false));
check('event exactly at watermark → allow', () => assert.strictEqual(isPostWatermark(T0, T0), true));
check('unknown event age → allow', () => assert.strictEqual(isPostWatermark(null, T1), true));

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
