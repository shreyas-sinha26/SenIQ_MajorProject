/**
 * Offline tests for the snapshot of a stock the user does not hold (services/stockSnapshot.js):
 * which company a typed name means, what the snapshot holds, and the code-written answer
 * that replaced the fixed refusal. No database, no network.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const S = require('../server/services/stockSnapshot');
const { TOOLS, EXECUTORS, runTool } = require('../server/services/qaTools');
const { QA } = require('../server/config');
const lib = require('../eval/ask/lib');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const HERO = { ticker: 'HEROMOTOCO', name: 'Hero MotoCorp', aliases: ['Hero Moto'], asset_class: 'equity', exchange: 'NSE', tier: 'curated' };
const SUZLON = { ticker: 'SUZLON', name: 'Suzlon Energy Ltd.', aliases: null, asset_class: 'equity', exchange: 'NSE', tier: 'listed' };
const NOW = new Date('2026-10-10T10:00:00Z');
const reading = (count, score = 0.5, z = null, points = 12) => ({ label: score > 0.6 ? 'positive' : score < 0.4 ? 'negative' : 'neutral', acute: { score, count }, baseline: { z, points } });

(async () => {
  console.log('which company a typed name means:');
  check('an exact ticker wins over names that merely contain it', () => {
    const rows = [{ ticker: 'AMD', name: 'Advanced Micro Devices' }, { ticker: 'AMDX', name: 'Amdocs Extra' }];
    assert.strictEqual(S.pickCompany('amd', rows).company.ticker, 'AMD');
    assert.strictEqual(S.pickCompany('$AMD', rows).company.ticker, 'AMD');
  });
  check('an exact name or alias wins; a lone loose match is taken', () => {
    const rows = [{ ticker: 'TATAPOWER', name: 'Tata Power Company Ltd.' }, HERO, { ticker: 'HEROX', name: 'Hero MotoCorp Finance' }];
    assert.strictEqual(S.pickCompany('Hero MotoCorp', rows).company.ticker, 'HEROMOTOCO');
    assert.strictEqual(S.pickCompany('hero moto', rows).company.ticker, 'HEROMOTOCO');
    assert.strictEqual(S.pickCompany('Suzlon', [SUZLON]).company.ticker, 'SUZLON');
  });
  check('several loose matches are handed back, capped, and nothing is picked', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ ticker: `TATA${i}`, name: `Tata Thing ${i}`, exchange: 'NSE' }));
    const r = S.pickCompany('Tata', rows);
    assert.ok(!r.company && r.matches.length === QA.SNAPSHOT_MATCHES);
    assert.deepStrictEqual(Object.keys(r.matches[0]), ['ticker', 'name', 'exchange']);
  });
  check('nothing typed or nothing found is "none"', () => {
    assert.deepStrictEqual(S.pickCompany('', [HERO]), { none: true });
    assert.deepStrictEqual(S.pickCompany('Zzyzx', []), { none: true });
  });

  console.log('what a snapshot holds:');
  check('price, day change, and a reading with the stories behind it', () => {
    const s = S.buildSnapshot(HERO, { price: 4895.5, currency: 'INR', changePct: 0.8 }, reading(2), { now: NOW });
    assert.deepStrictEqual([s.kind, s.ticker, s.held, s.price, s.currency, s.day_change_pct], ['stock_snapshot', 'HEROMOTOCO', false, 4895.5, 'INR', 0.8]);
    assert.deepStrictEqual(s.sentiment, { label: 'neutral', score: 0.5, stories: 2, window_hours: 72, z_note: 'too little history for a z-score' });
    assert.ok(/no news detail, smart money or impact/.test(s.note));
  });
  check('a z-score is given when there is one', () => {
    const s = S.buildSnapshot(HERO, null, reading(7, 0.71, 1.4), { now: NOW });
    assert.strictEqual(s.sentiment.z_vs_90d, 1.4);
    assert.ok(!('z_note' in s.sentiment));
  });
  check('no stories is "no reading", never neutral', () => {
    const s = S.buildSnapshot(HERO, { price: 10, currency: 'INR', changePct: 0 }, reading(0), { now: NOW });
    assert.strictEqual(s.sentiment, null);
    assert.ok(/^no reading: no stories in the last 72 hours/.test(s.sentiment_note));
    assert.ok(!/neutral/.test(JSON.stringify(s)));
  });
  check('a listed name nobody holds is "not tracked yet"; with stories it has a reading', () => {
    assert.ok(/^not tracked yet/.test(S.buildSnapshot(SUZLON, null, reading(0, 0.5, null, 0), { now: NOW }).sentiment_note));
    assert.ok(/^no reading/.test(S.buildSnapshot(SUZLON, null, reading(0, 0.5, null, 4), { now: NOW }).sentiment_note));
    assert.strictEqual(S.buildSnapshot(SUZLON, null, reading(3, 0.7, null, 3), { now: NOW }).sentiment.stories, 3);
  });
  check('no quote: the price is null and said to be missing', () => {
    const s = S.buildSnapshot(HERO, null, reading(2), { now: NOW });
    assert.deepStrictEqual([s.price, s.currency, s.day_change_pct, s.price_note], [null, null, null, 'no live price available right now']);
  });
  check('a held company is marked held and pointed at the holding tools', () => {
    const s = S.buildSnapshot(HERO, null, reading(2), { held: true, now: NOW });
    assert.ok(s.held && /IS in the user's portfolio/.test(s.note));
  });
  check('a price under one unit keeps its small digits', () => {
    assert.strictEqual(S.buildSnapshot({ ticker: 'PEPE', name: 'Pepe', asset_class: 'crypto', tier: 'curated' }, { price: 0.00001234, currency: 'USD', changePct: -3.456 }, null, { now: NOW }).price, 0.000012);
    assert.strictEqual(S.priceText(4895.5, 'INR'), '₹4,895.50');
    assert.strictEqual(S.priceText(1234567.891, 'USD'), '$1,234,567.89');
    assert.strictEqual(S.priceText(12.5, 'CHF'), '12.50 CHF');
  });

  console.log('the code-written answer:');
  check('one name: price, move, reading with its story count, and how to get the rest', () => {
    const a = S.snapshotAnswer([S.buildSnapshot(HERO, { price: 4895.5, currency: 'INR', changePct: 0.8 }, reading(2), { now: NOW })]);
    assert.ok(/^HEROMOTOCO isn't in your portfolio, so SenIQ has only its price and sentiment reading\./.test(a));
    assert.ok(a.includes('Hero MotoCorp (HEROMOTOCO): Price ₹4,895.50, up 0.80% today.'));
    assert.ok(a.includes('News sentiment neutral (0.50 on a 0 to 1 scale, 0.5 is neutral) from 2 stories in the last 72 hours; too little history to compare with its usual level.'));
    assert.ok(/Add it to your portfolio \(Portfolio page, "Add Asset"\) for news, smart money and the impact on your holdings\.$/.test(a));
  });
  check('a fall, one story, a z-score; no price; no stories', () => {
    const fall = S.snapshotLine(S.buildSnapshot(HERO, { price: 100, currency: 'USD', changePct: -1.234 }, reading(1, 0.3, -1.8), { now: NOW }));
    assert.ok(fall.includes('Price $100.00, down 1.23% today.') && fall.includes('from 1 story in') && fall.includes('z-score -1.8 against its own 90-day normal'));
    const bare = S.snapshotLine(S.buildSnapshot(HERO, null, reading(0), { now: NOW }));
    assert.ok(bare.includes('There is no live price for it right now.') && bare.includes('No sentiment reading: SenIQ has no stories on it from the last 72 hours.'));
    assert.ok(!/neutral/.test(bare));
    assert.ok(S.snapshotLine(S.buildSnapshot(SUZLON, null, null, { now: NOW })).includes('SenIQ does not read the news for it yet'));
  });
  check('several names, and the ones past the cap are named as not shown', () => {
    const snaps = ['TSLA', 'MSFT'].map((t) => S.buildSnapshot({ ticker: t, name: t, tier: 'curated' }, { price: 1, currency: 'USD', changePct: 0 }, reading(1), { now: NOW }));
    const a = S.snapshotAnswer(snaps, ['AMD']);
    assert.ok(/^TSLA, MSFT, AMD aren't in your portfolio, so SenIQ has only their price/.test(a));
    assert.ok(a.includes('unchanged today') && a.includes('Not shown here: AMD. Ask about it separately.') && /Add them to your portfolio/.test(a));
    assert.strictEqual(S.snapshotAnswer([]), null);
  });
  check('the answer gives no advice and no news', () => {
    const a = S.snapshotAnswer([S.buildSnapshot(HERO, { price: 4895.5, currency: 'INR', changePct: 0.8 }, reading(9, 0.9, 2.5), { now: NOW })]);
    assert.ok(lib.adviceCheck ? lib.adviceCheck(a).pass : !/\b(buy|sell|hold|should)\b/i.test(a));
  });

  console.log('a question that asks what to do, or about the past:');
  check('advice asked: the answer says SenIQ does not advise, first, and still gives the figures', () => {
    for (const q of ['Should I buy Hero MotoCorp?', 'Is Tesla a good buy right now?', 'Is it a good time to sell Microsoft?', 'Will Tesla go up next week?', 'What is the price target for AMD?', 'Tesla: buy or sell?', 'Is Infosys worth buying?', 'Can you recommend Tesla?'])
      assert.ok(S.asksForAdvice(q), q);
    for (const q of ['How is Microsoft\'s sentiment looking?', 'Give me the latest news on Tesla', 'What is the price of AMD?', 'Did insiders sell Tesla shares?', 'How has Tesla done this year?'])
      assert.ok(!S.asksForAdvice(q), q);
    const snap = S.buildSnapshot(HERO, { price: 4895.5, currency: 'INR', changePct: 0.8 }, reading(2), { now: NOW });
    const a = S.snapshotAnswer([snap], [], { advice: true });
    assert.ok(a.startsWith("SenIQ doesn't give buy, sell or hold advice, or predictions. Here is what it has.\nHEROMOTOCO isn't in your portfolio"));
    assert.ok(a.includes('Price ₹4,895.50') && !S.snapshotAnswer([snap]).includes('advice'));
  });
  check('the past asked: what the price did is added under each name', () => {
    for (const q of ['How has Tesla done this year?', 'Tesla performance over the last 6 months', 'What is the 52-week high of AMD?', 'How did Microsoft do last month?', 'Tesla price history'])
      assert.ok(S.asksAboutHistory(q), q);
    for (const q of ['What is the price of AMD?', 'How is Microsoft\'s sentiment looking?', 'Should I buy Hero MotoCorp?'])
      assert.ok(!S.asksAboutHistory(q), q);
    const h = { currency: 'INR', last_close: { date: '2026-10-09', close: 4895.5 }, highest_close: { date: '2025-12-05', close: 6350.5 }, lowest_close: { date: '2026-06-08', close: 4775.5 },
      changes: { '1_week': { change_pct: -5.27 }, '1_month': { change_pct: -6.18 }, '3_months': { change_pct: 1.5 }, '6_months': null, '1_year': null, year_to_date: null }, history_starts: '2026-06-01' };
    const line = S.historyLine(h);
    assert.strictEqual(line, 'Closing prices to 2026-10-09 (its history here starts 2026-06-01): 1 week -5.27%, 1 month -6.18%, 3 months +1.50%. Highest close in the period ₹6,350.50 on 2025-12-05, lowest ₹4,775.50 on 2026-06-08.');
    assert.strictEqual(S.historyLine({ history: null }), 'There is no price history for it right now.');
    const snap = S.buildSnapshot(HERO, { price: 4895.5, currency: 'INR', changePct: 0.8 }, reading(2), { now: NOW });
    const a = S.snapshotAnswer([snap], [], { histories: { HEROMOTOCO: h } }).split('\n');
    assert.ok(/price and sentiment reading, and what the price did over the past year\.$/.test(a[0]));
    assert.ok(a[1].startsWith('Hero MotoCorp (HEROMOTOCO): Price') && a[2] === line);
  });

  console.log('the tool:');
  check('it is one of Ask\'s tools, with an executor, and takes a name', () => {
    const t = TOOLS.find((x) => x.name === 'get_stock_snapshot');
    assert.ok(t && typeof EXECUTORS.get_stock_snapshot === 'function');
    assert.deepStrictEqual(t.input_schema.required, ['name']);
    // Appended after the tools that were there before: the cached prefix ahead of them is unchanged.
    assert.deepStrictEqual(TOOLS.slice(-2).map((x) => x.name), ['get_stock_snapshot', 'get_price_history']);
  });
  await checkAsync('no name is an error the model can read, and no lookup is made', async () => {
    const r = await runTool({ id: 't1', name: 'get_stock_snapshot', input: {} }, { heldSet: new Set() });
    assert.ok(r.is_error && /name is required/.test(r.content));
  });
  check('the eval lets a snapshot name a stock outside the portfolio, and nothing else', () => {
    const c = { id: 'x', tags: ['t'], question: 'q', rubric: [], expect: { writer: 'claude', no_data_for: ['AMD'] } };
    const snap = JSON.stringify(S.buildSnapshot({ ticker: 'AMD', name: 'AMD', tier: 'curated' }, null, reading(1), { now: NOW }));
    const run = (evidence) => lib.gradeDeterministic(c, { writer: 'claude', answer: 'ok.', tools_used: [], grounding: null, evidence });
    assert.strictEqual(run([snap]).checks.no_data_leak, true);
    assert.strictEqual(run([snap, '{"ticker":"AMD","events":[]}']).checks.no_data_leak, false);
  });

  console.log(`\n${passed} stock-snapshot checks passed`);
})();
