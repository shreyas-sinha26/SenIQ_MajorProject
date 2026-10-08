/**
 * Offline logic tests for E2 — event typing + the 6-factor impact score. No DB.
 * Run via `npm test` (alongside entityResolver.test.js).
 */

const assert = require('node:assert');
const { classifyEventType } = require('../server/services/eventTyping');
const { impactForEvent, holdingRegion, coverageMult, tagMarketStories, collapseStories } = require('../server/services/impactScoring');
const { IMPACT } = require('../server/config');
const { classifyStance } = require('../server/services/eventTyping');
const { planDeliveries, inQuietWindow, isPostWatermark, holdingMateriality, typeFactor, storyTokens, regionOf, sameStory, groupStories, regionExposure, scoreStory } = require('../server/services/materiality');

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

check('a market-wide story ranks below an equally strong story about a sizeable holding', () => {
  const book = [
    { ticker: 'TCS', exposure_pct: 25, sector: 'IT', region: 'IN' },
    { ticker: 'RELIANCE', exposure_pct: 20, sector: 'Energy', region: 'IN' },
    { ticker: 'AAPL', exposure_pct: 40, sector: 'Technology', region: 'US' },
    { ticker: 'BTC', exposure_pct: 15, sector: 'Crypto', region: 'GLOBAL' },
  ];
  const market = { event_id: 10, event_type: 'macro', sectors: [], last_seen: fresh, tickers: {}, isMacro: true, macroScore: 0.1, region: 'IN' };
  const direct = { event_id: 11, event_type: 'earnings', sectors: [], last_seen: fresh, tickers: { TCS: { score: 0.1, confidence: 0.9 } } };
  const m = impactForEvent(market, book, {}, now);
  const d = impactForEvent(direct, book, {}, now);
  assert.ok(d.impact > m.impact, `direct ${d.impact} > market ${m.impact}`);
  // It reaches only the India-listed holdings (45%), at the market-wide relevance.
  assert.strictEqual(m.exposure_pct, Math.round(45 * IMPACT.MACRO_BROAD_FACTOR * 10) / 10);
});
check('a market-wide story about one country does not touch a portfolio held elsewhere', () => {
  const usOnly = [{ ticker: 'AAPL', exposure_pct: 100, sector: 'Technology', region: 'US' }];
  const india = { event_id: 12, event_type: 'macro', sectors: [], last_seen: fresh, tickers: {}, isMacro: true, macroScore: 0.1, region: 'IN' };
  assert.strictEqual(impactForEvent(india, usOnly, {}, now).impact, 0);
  assert.ok(impactForEvent({ ...india, region: 'GLOBAL' }, usOnly, {}, now).impact > 0);
  assert.ok(impactForEvent({ ...india, region: 'US' }, usOnly, {}, now).impact > 0);
});
check('a story that reaches a holding only as market news counts at market severity, whatever its type', () => {
  const book = [{ ticker: 'TCS', exposure_pct: 100, sector: 'IT', region: 'IN' }];
  const base = { event_id: 13, sectors: [], last_seen: fresh, tickers: {}, isMacro: true, macroScore: 0.9, region: 'IN' };
  assert.strictEqual(impactForEvent({ ...base, event_type: 'legal' }, book, {}, now).impact, impactForEvent({ ...base, event_type: 'macro' }, book, {}, now).impact);
});
check('holdingRegion: stocks by listing, crypto and commodities belong to no one market', () => {
  assert.strictEqual(holdingRegion({ asset_class: 'equity', exchange: 'NSE' }, null), 'IN');
  assert.strictEqual(holdingRegion({ asset_class: 'equity', exchange: null }, 'IN'), 'IN');
  assert.strictEqual(holdingRegion({ asset_class: 'equity', exchange: null }, 'US'), 'US');
  assert.strictEqual(holdingRegion({ asset_class: 'equity', exchange: null }, undefined), 'US');
  assert.strictEqual(holdingRegion({ asset_class: 'crypto' }, 'GLOBAL'), 'GLOBAL');
  assert.strictEqual(holdingRegion({ asset_class: 'commodity' }, undefined), 'GLOBAL');
});
check('a market story many outlets cover counts for more, up to a cap', () => {
  assert.strictEqual(coverageMult(1), 1);
  assert.strictEqual(coverageMult(undefined), 1);
  assert.strictEqual(coverageMult(4), 2);
  assert.strictEqual(coverageMult(8), 2.5);
  assert.strictEqual(coverageMult(1000), IMPACT.MACRO_COVERAGE_MAX);
});
check('related market headlines are grouped, and the big story outranks the lone one', () => {
  const mk = (id, title, extra = {}) => ({ event_id: id, title, source: 'livemint.com', event_type: 'macro', sectors: [], tickers: {}, isMacro: true, macroScore: 0.1, region: 'IN', source_count: 1, importance: 0.6, last_seen: fresh, first_seen: fresh, ...extra });
  const events = tagMarketStories([
    mk(20, 'Sensex crashes 780 points as selloff deepens'),
    mk(21, 'Why Sensex crashed today: selloff explained'),
    mk(22, 'Sensex selloff: crash wipes out investor wealth'),
    mk(23, 'Sensex crash and selloff: what analysts expect'),
    mk(24, 'Baby products maker gets regulator nod for IPO'),
    { ...mk(25, 'TCS beats estimates'), isMacro: false, tickers: { TCS: { score: 0.9, confidence: 0.9 } } },
  ]);
  assert.deepStrictEqual(events.slice(0, 5).map((e) => e.story_coverage), [4, 4, 4, 4, 1]);
  assert.strictEqual(events[5].story_coverage, undefined);
  const book = [{ ticker: 'TCS', exposure_pct: 100, sector: 'IT', region: 'IN' }];
  const crash = impactForEvent(events[0], book, {}, now);
  const ipo = impactForEvent(events[4], book, {}, now);
  assert.strictEqual(crash.exposure_pct, 100 * IMPACT.MACRO_BROAD_FACTOR * 2);
  assert.ok(Math.abs(crash.impact - ipo.impact * 2) < 0.002, `${crash.impact} vs ${ipo.impact}`);
});
check('the feed carries one row per story and counts the headlines folded into it', () => {
  const row = (title, tier, ticker, impact) => ({ title, source: 'livemint.com', relevance_tier: tier, primary_ticker: ticker, impact_score: impact });
  const feed = collapseStories([
    row('TCS Q2 results today: revenue triggers to watch', 'holding', 'TCS', 0.13),
    row('TCS Q2 results: revenue estimates from the street', 'holding', 'TCS', 0.12),
    row('Infosys Q2 results: revenue estimates from the street', 'holding', 'INFY', 0.11),
    row('Sensex crashes 780 points as selloff deepens', 'market', null, 0.10),
    row('TCS Q2 results preview: revenue triggers and estimates', 'holding', 'TCS', 0.09),
    row('Why Sensex crashed today: selloff explained', 'market', null, 0.08),
    row('TCS wins a large cloud deal in Europe', 'holding', 'TCS', 0.07),
  ]);
  assert.deepStrictEqual(feed.map((r) => [r.primary_ticker || 'market', r.related]), [['TCS', 2], ['INFY', 0], ['market', 1], ['TCS', 0]]);
  assert.strictEqual(feed[0].impact_score, 0.13);
  assert.strictEqual(collapseStories(feed, 2).length, 2);
});
check('stance: a reported event, someone\'s view of one, and a round-up are told apart', () => {
  const isCompany = (text) => /tata motors|reliance|elon musk/i.test(text);
  const stance = (t) => classifyStance(t, isCompany);
  for (const t of [
    'TCS beats estimates as Q2 profit rises 9%', 'Reliance to acquire a 40% stake in a solar firm',
    'Tata Motors Says It Will Cut 5,000 Jobs', 'Elon Musk says Tesla will open a plant in India',
    'RBI MPC meeting October 2026: Repo rate hiked by 25 bps to 5.50%', 'SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips',
    'Bitcoin drops over 3% to $83,000',
  ]) assert.strictEqual(stance(t), 'event', t);
  for (const t of [
    'Hunter Biden Says America’s Dollar Is ‘Fake’ Under Fiat System', 'Peter Schiff Warns Bitcoin Vulnerable to Tech Stock Pullback',
    'Scott Galloway: “Apple Wins by Showing Up Late”', 'TCS Q2 Results 2026 Today: 5 triggers could decide share price\'s next move',
    'Will SpaceX\'s $40B Nvidia Bet Help or Hurt the Stock After a 16% Run?', 'Prediction: A $1,000 Investment in Qualcomm Today Could Be Worth This Much by 2030',
    'Why is the stock market down today? 3 factors behind Sensex fall', 'TCS Q2 preview: what to expect',
    'Should Dell Stock Be Part Of Your Portfolio?', 'ET Alpha Wealth Summit 2.0: The ideas, trends and opportunities', 'Here\'s 1 of the Best AI Stocks Investors Should Consider Buying in October', 'NVIDIA (NVDA) vs. Apple (AAPL): Which Stock Wins the Valuation Race?',
  ]) assert.strictEqual(stance(t), 'commentary', t);
  for (const t of [
    'Stocks to watch: TCS, Paytm, Tata Power, Ola', 'Top stocks to watch today: TCS, Tata Steel, Reliance',
    'Which dow jones stocks are moving on Wednesday? Top movers', 'Stock Market LIVE: Sensex at day\'s low',
    'Zacks Earnings Trends Highlights: Micron, Nvidia, Alphabet',
    'Zacks.com featured highlights Seagate Technology, Western Digital and Dell', 'Dan Ives Names 5 Tech Stocks for 2027',
  ]) assert.strictEqual(stance(t), 'roundup', t);
});
check('commentary and round-ups count for less than the event they talk about', () => {
  const book = [{ ticker: 'AAPL', exposure_pct: 100, sector: 'Technology', region: 'US' }];
  const base = impactForEvent({ ...earnings, stance: 'event' }, book, {}, now).impact;
  const view = impactForEvent({ ...earnings, stance: 'commentary' }, book, {}, now).impact;
  const list = impactForEvent({ ...earnings, stance: 'roundup' }, book, {}, now).impact;
  assert.ok(Math.abs(view - base * IMPACT.STANCE_FACTOR.commentary) < 0.002 && Math.abs(list - base * IMPACT.STANCE_FACTOR.roundup) < 0.002);
  assert.strictEqual(impactForEvent(earnings, book, {}, now).impact, base);
});
check('market headlines that share one topic word are one story in the feed; alerts keep the stricter rule', () => {
  const m = (title) => ({ tokens: storyTokens(title), region: 'IN' });
  const rbi = m('RBI rate hike: your EMI may not move'), rupee = m('Rupee undervalued, RBI governor says');
  assert.strictEqual(sameStory(rbi, rupee), false);
  assert.strictEqual(sameStory(rbi, rupee, { anchors: true }), true);
  assert.strictEqual(sameStory(m('Fed holds rates'), { ...m('Fed signals a pause'), region: 'US' }, { anchors: true }), false);
  assert.strictEqual(sameStory(m('Auto sales climb in September'), m('Cement makers lift prices'), { anchors: true }), false);
  const row = (title, tier, ticker) => ({ title, source: 'livemint.com', relevance_tier: tier, primary_ticker: ticker });
  const feed = collapseStories([row('RBI rate hike: your EMI may not move', 'market', null), row('Rupee undervalued, RBI governor says', 'market', null),
    row('RBI fines TCS over a filing lapse', 'holding', 'TCS'), row('RBI clears payments licence for Tata Consultancy', 'holding', 'TCS')]);
  assert.deepStrictEqual(feed.map((r) => r.related), [1, 0, 0]);
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

check('not realtime-eligible → digest even with budget left', () => {
  const cands = [{ ...mk(1, 'AAPL', 0.9), realtimeEligible: false }, mk(1, 'MSFT', 0.2)];
  planDeliveries(cands, { budget, nowHour: 12 });
  assert.deepStrictEqual(cands.map((c) => [c.ticker, c.delivery]).sort(), [['AAPL', 'digest'], ['MSFT', 'realtime']]);
});

check('market alerts have their own smaller cap; holdings keep the rest', () => {
  const b2 = { ...budget, MAX_REALTIME_PER_DAY: 5, MAX_BROAD_REALTIME_PER_DAY: 2 };
  const cands = [mk(1, 'MARKET', 0.9), mk(1, 'MARKET', 0.8), mk(1, 'MARKET', 0.7), mk(1, 'AAPL', 0.1)];
  planDeliveries(cands, { budget: b2, nowHour: 12 });
  assert.deepStrictEqual(cands.map((c) => c.delivery), ['realtime', 'realtime', 'digest', 'realtime']);
});

check('market cap counts what was already sent today', () => {
  const b2 = { ...budget, MAX_REALTIME_PER_DAY: 5, MAX_BROAD_REALTIME_PER_DAY: 2 };
  const cands = [mk(1, 'MARKET', 0.9)];
  planDeliveries(cands, { budget: b2, nowHour: 12, sentTodayByUser: { 1: 2 }, sentBroadTodayByUser: { 1: 2 } });
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

console.log('\nholding materiality (threshold calibration):');
{
  const { MATERIALITY } = require('../server/config');
  const ev = (type, score, confidence, sourceCount = 1) => ({ eventType: type, sourceCount, tickers: { AAPL: { score, confidence } } });
  const m = (cluster, exposure, z = null) => holdingMateriality(cluster, { AAPL: exposure }, { AAPL: z }).score;

  check('10% position + strong, confident earnings news → alerts', () => {
    assert.ok(m(ev('earnings', 0.95, 0.9), 10) >= MATERIALITY.HOLDING_THRESHOLD);
  });
  check('same news as an opinion piece on a 10% position → does not', () => {
    assert.ok(m(ev('other', 0.95, 0.9), 10) < MATERIALITY.HOLDING_THRESHOLD);
  });
  check('5% position: ordinary news no, surprising + widely covered serious news yes', () => {
    assert.ok(m(ev('earnings', 0.95, 0.9), 5) < MATERIALITY.HOLDING_THRESHOLD);
    assert.ok(m(ev('legal', 0.02, 0.9, 4), 5, -3) >= MATERIALITY.HOLDING_THRESHOLD);
  });
  check('mild sentiment on a big position → does not', () => {
    assert.ok(m(ev('other', 0.58, 0.9), 40) < MATERIALITY.HOLDING_THRESHOLD);
  });
  check('a stock the user does not hold never scores', () => {
    assert.strictEqual(holdingMateriality(ev('ma', 1, 1), { MSFT: 100 }, {}).score, 0);
  });
  check('M&A outranks an analyst rating', () => assert.ok(typeFactor('ma') > typeFactor('earnings') && typeFactor('earnings') > typeFactor('rating')));
  check('low-confidence news reports its confidence (kept out of real time)', () => {
    assert.ok(holdingMateriality(ev('earnings', 1, 0.3), { AAPL: 100 }, {}).topConfidence < MATERIALITY.REALTIME_MIN_CONFIDENCE);
  });
}

console.log('\nmarket stories:');
{
  const E = (title, importance = 0.7, source = 'economictimes.indiatimes.com', sourceCount = 1) => ({ title, importance, source, sourceCount, firstSeen: '2026-10-07T05:00:00Z', tier: 'market' });
  const rbi = [
    E('RBI MPC meeting October 2026: Repo rate hiked by 25 bps to 5.50%', 0.8),
    E('RBI hikes interest rates by 25 bps: What next for the markets?'),
    E('Bond yields rise to 7.27%, rupee declines as RBI hikes rates by 25 bps'),
    E('Rate hike not to significantly impact earnings or growth: Ambareesh Baliga'),
  ];
  const fed = E('Fed hikes rates by 25 bps as inflation stays hot', 0.8, 'Reuters');
  const ipo = E('FirstCry-backed Swara Baby Products gets Sebi nod for IPO');

  check('story tokens drop filler and numbers, keep the subject', () => {
    const t = storyTokens('RBI hikes interest rates by 25 bps: What next for the markets?');
    assert.ok(t.has('rbi') && t.has('rat') && t.has('hik'));          // stems: rate(s) → rat, hike(s/d) → hik
    assert.deepStrictEqual([...storyTokens('hike hikes hiked hiking')], ['hik']);
    assert.ok(!t.has('market') && !t.has('what') && !t.has('bps') && !t.has('25'));
  });
  check('region: RBI/Indian source → IN, Fed → US, neither → GLOBAL', () => {
    assert.strictEqual(regionOf(rbi[0].title, rbi[0].source), 'IN');
    assert.strictEqual(regionOf(fed.title, fed.source), 'US');
    assert.strictEqual(regionOf('Oil jumps as OPEC surprises with a cut', 'Reuters'), 'GLOBAL');
  });
  check('four RBI headlines are ONE story led by the most important', () => {
    const stories = groupStories([...rbi].reverse());
    assert.strictEqual(stories.length, 1);
    assert.strictEqual(stories[0].lead.title, rbi[0].title);
    assert.strictEqual(stories[0].coverage, 4);
  });
  check('a Fed hike the same day is a different story (other market)', () => {
    assert.strictEqual(groupStories([...rbi, fed]).length, 2);
  });
  check('an unrelated headline stays its own story', () => {
    assert.strictEqual(groupStories([...rbi, ipo]).length, 2);
  });

  const story = groupStories(rbi)[0];
  check('confirmed story + real exposure to that market → may push', () => {
    assert.strictEqual(scoreStory(story, 40).realtimeEligible, true);
  });
  check('same story, no money in that market → recorded, never pushed', () => {
    assert.strictEqual(scoreStory(story, 0).realtimeEligible, false);
  });
  check('single unconfirmed headline → recorded, never pushed', () => {
    assert.strictEqual(scoreStory(groupStories([ipo])[0], 100).realtimeEligible, false);
  });
  check('weak story → no alert at all', () => {
    assert.strictEqual(scoreStory(groupStories([E('Monetary policy shifts gear', 0.42)])[0], 100), null);
  });
  check('exposure raises priority', () => assert.ok(scoreStory(story, 80).priority > scoreStory(story, 10).priority));
  check('a GLOBAL story concerns everyone', () => {
    const oil = groupStories([E('Oil jumps as OPEC surprises with a cut', 0.8, 'Reuters', 4)])[0];
    assert.strictEqual(scoreStory(oil, 0).realtimeEligible, true);
  });
  check('region exposure: NSE → IN, US → US, crypto/commodity → GLOBAL', () => {
    const r = regionExposure([
      { ticker: 'RELIANCE', exchange: 'NSE', asset_class: 'equity', exposure_pct: 30 },
      { ticker: 'AAPL', exchange: 'US', asset_class: 'equity', exposure_pct: 50 },
      { ticker: 'BTC', asset_class: 'crypto', exposure_pct: 15 },
      { ticker: 'XAU', asset_class: 'commodity', exposure_pct: 5 },
    ]);
    assert.deepStrictEqual(r, { IN: 30, US: 50, GLOBAL: 20 });
  });
  check('a follow-up headline matches a story the user was already told about', () => {
    const told = { tokens: storyTokens(rbi[0].title), region: 'IN' };
    const later = { tokens: storyTokens('RBI rate hike impact: Bank, NBFC shares rebound'), region: 'IN' };
    assert.strictEqual(sameStory(told, later), true);
  });
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
