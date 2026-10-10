/**
 * Offline tests for Ask's price history (services/priceHistory.js): reading the two sources'
 * replies, the figures worked out from the bars, and which route a company's history takes.
 * No database, no network.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const H = require('../server/services/priceHistory');
const { TOOLS, EXECUTORS, runTool } = require('../server/services/qaTools');
const { DATA_TOOLS, ASK_ONLY } = require('../server/services/dataTools');
const { QA } = require('../server/config');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const ts = (date, hour = 4) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`) / 1000;
const yahoo = (rows, meta = { currency: 'INR', gmtoffset: 19800 }) => ({ chart: { result: [{ meta, timestamp: rows.map((r) => ts(r[0])), indicators: { quote: [{ close: rows.map((r) => r[1]), volume: rows.map((r) => r[2]) }] } }] } });
// One bar a weekday from `from` for `n` sessions, closing at f(i).
function sessions(from, n, f, vol = () => 1000) {
  const out = [];
  for (let d = Date.parse(`${from}T00:00:00Z`), i = 0; i < n; d += 86400e3) {
    const day = new Date(d).getUTCDay();
    if (day === 0 || day === 6) continue;
    out.push({ date: new Date(d).toISOString().slice(0, 10), close: f(i), volume: vol(i) });
    i++;
  }
  return out;
}

(async () => {
  console.log('reading the replies:');
  check('Yahoo: the exchange\'s own dates, days without a close dropped, volume kept', () => {
    const { currency, bars } = H.parseYahoo(yahoo([['2026-10-07', 5004, 400000], ['2026-10-08', null, 0], ['2026-10-09', 4895.456, 0]]));
    assert.strictEqual(currency, 'INR');
    assert.deepStrictEqual(bars, [{ date: '2026-10-07', close: 5004, volume: 400000 }, { date: '2026-10-09', close: 4895.46, volume: null }]);
    assert.deepStrictEqual(H.parseYahoo({ chart: { result: null } }), { currency: null, bars: [] });
  });
  check('Yahoo: a late-evening UTC stamp lands on the exchange\'s next day', () => {
    const json = yahoo([['2026-10-08', 100, 1]]);
    json.chart.result[0].timestamp = [Date.parse('2026-10-08T22:00:00Z') / 1000];
    assert.strictEqual(H.parseYahoo(json).bars[0].date, '2026-10-09');
  });
  check('Yahoo: a price in US cents becomes dollars', () => {
    const { currency, bars } = H.parseYahoo(yahoo([['2026-10-09', 20.25, 9]], { currency: 'USX', gmtoffset: 0 }));
    assert.deepStrictEqual([currency, bars[0].close], ['USD', 0.2025]);
  });
  check('CoinGecko: one bar a day, the last reading of a day wins, volume in dollars', () => {
    const ms = (d, h) => Date.parse(`${d}T${h}:00:00Z`);
    const { currency, bars } = H.parseCoinGecko({ prices: [[ms('2026-10-08', '00'), 80000], [ms('2026-10-09', '00'), 81000], [ms('2026-10-09', '14'), 82971.789]], total_volumes: [[ms('2026-10-08', '00'), 3.2e10], [ms('2026-10-09', '14'), 2.9e10]] });
    assert.strictEqual(currency, 'USD');
    assert.deepStrictEqual(bars, [{ date: '2026-10-08', close: 80000, volume: 32000000000 }, { date: '2026-10-09', close: 82971.79, volume: 29000000000 }]);
    assert.deepStrictEqual(H.parseCoinGecko({}).bars, []);
  });

  console.log('the figures:');
  const year = sessions('2025-10-09', 262, (i) => 100 + i, (i) => (i >= 242 ? 2000 : 1000));   // to 2026-10-09
  const s = H.summarize(year);
  check('the period, and the last close', () => {
    assert.deepStrictEqual(s.period, { from: '2025-10-09', to: '2026-10-09', sessions: 262 });
    assert.deepStrictEqual(s.last_close, { date: '2026-10-09', close: 361 });
    assert.ok(!('history_starts' in s));
  });
  check('each change is measured from the last session on or before the day that far back', () => {
    assert.deepStrictEqual(s.changes['1_week'], { from: '2026-10-02', from_close: 356, change_pct: 1.4 });
    // 30 days before Fri 9 Oct is Wed 9 Sep; 91 days before is Fri 10 Jul.
    assert.strictEqual(s.changes['1_month'].from, '2026-09-09');
    assert.strictEqual(s.changes['3_months'].from, '2026-07-10');
    assert.deepStrictEqual(s.changes['1_year'], { from: '2025-10-09', from_close: 100, change_pct: 261 });
    assert.deepStrictEqual(Object.keys(s.changes), [...QA.PRICE_HISTORY_PERIODS.map((p) => p[0]), 'year_to_date']);
  });
  check('"this year" is the calendar year, from the last close of the year before', () => {
    const dec31 = year.find((b) => b.date === '2025-12-31');
    assert.deepStrictEqual(s.changes.year_to_date, { from: '2025-12-31', from_close: dec31.close, change_pct: Math.round(((361 - dec31.close) / dec31.close) * 10000) / 100 });
    assert.strictEqual(H.summarize(year.filter((b) => b.date >= '2026-02-02')).changes.year_to_date, null);   // listed this year
  });
  check('a day with no session falls back to the session before it, never forward', () => {
    const gap = year.filter((b) => b.date !== '2026-10-02');
    assert.strictEqual(H.summarize(gap).changes['1_week'].from, '2026-10-01');
  });
  check('a year of bars that starts a weekend short still gives the 1-year change', () => {
    const late = year.filter((b) => b.date >= '2025-10-13');    // Monday: four days short
    assert.deepStrictEqual([H.summarize(late).changes['1_year'].from, 'history_starts' in H.summarize(late)], ['2025-10-13', false]);
  });
  check('a period the history does not reach is null, and the start is said', () => {
    const young = year.filter((b) => b.date >= '2026-08-03');
    const y = H.summarize(young);
    assert.ok(y.changes['1_week'] && y.changes['1_month'] && y.changes['3_months'] === null && y.changes['6_months'] === null && y.changes['1_year'] === null);
    assert.strictEqual(y.history_starts, '2026-08-03');
  });
  check('highest and lowest close with their dates', () => {
    const bars = sessions('2026-09-01', 10, (i) => [50, 55, 70, 65, 40, 45, 60, 62, 61, 63][i]);
    const r = H.summarize(bars);
    assert.deepStrictEqual([r.highest_close, r.lowest_close], [{ date: '2026-09-03', close: 70 }, { date: '2026-09-07', close: 40 }]);
  });
  check('average volume: the recent sessions and the period; none when the source gives none', () => {
    assert.deepStrictEqual(s.avg_daily_volume, { last_20_sessions: 2000, period: Math.round((242 * 1000 + 20 * 2000) / 262) });
    assert.strictEqual(H.summarize(year.map((b) => ({ ...b, volume: null }))).avg_daily_volume, null);
  });
  check('the two runs of closes: the latest sessions, and each earlier month\'s last close', () => {
    assert.strictEqual(s.recent_closes.length, QA.PRICE_HISTORY_RECENT);
    assert.deepStrictEqual(s.recent_closes[s.recent_closes.length - 1], ['2026-10-09', 361]);
    assert.strictEqual(s.month_end_closes.length, 12);
    assert.strictEqual(s.month_end_closes[11][0], '2026-09-30');
    assert.ok(s.month_end_closes.every(([d]) => d < '2026-10-01'));
  });
  check('fewer than two bars is no history', () => {
    assert.strictEqual(H.summarize([]), null);
    assert.strictEqual(H.summarize([{ date: '2026-10-09', close: 5, volume: 1 }]), null);
  });

  console.log('the tool result:');
  const company = { ticker: 'HEROMOTOCO', name: 'Hero MotoCorp', asset_class: 'equity', exchange: 'NSE' };
  check('it fits the tool-result allowance with room to spare, and says what not to do with it', () => {
    const r = H.buildHistory(company, { currency: 'INR', bars: sessions('2025-10-09', 262, (i) => 4000.55 + i * 3.37, (i) => 500000 + i * 997), volumeUnit: 'shares a day' });
    assert.ok(JSON.stringify(r).length < QA.MAX_TOOL_RESULT_CHARS / 2);
    assert.deepStrictEqual([r.kind, r.ticker, r.held, r.currency, r.volume_unit], ['price_history', 'HEROMOTOCO', false, 'INR', 'shares a day']);
    assert.ok(/do not call a trend, forecast/.test(r.note) && /do not work out a change over any other period/.test(r.note));
    assert.ok(JSON.stringify(r).startsWith('{"kind":"price_history"'));    // the eval's leak check reads this
  });
  check('no bars: it says there is no history and not to fill it from memory', () => {
    const r = H.buildHistory(company, { currency: null, bars: [], volumeUnit: null }, { held: true });
    assert.deepStrictEqual([r.history, r.held], [null, true]);
    assert.ok(/do not describe its past prices from memory/.test(r.note));
  });

  console.log('where a history comes from:');
  check('an Indian share tries its own exchange first; a US share is its ticker', () => {
    assert.deepStrictEqual(H.sourceFor({ ticker: 'TCS', asset_class: 'equity', exchange: 'NSE' }), { yahoo: ['TCS.NS', 'TCS.BO'] });
    assert.deepStrictEqual(H.sourceFor({ ticker: 'XYZLTD', asset_class: 'equity', exchange: 'BSE' }), { yahoo: ['XYZLTD.BO', 'XYZLTD.NS'] });
    assert.deepStrictEqual(H.sourceFor({ ticker: 'SUZLON', asset_class: 'equity' }, { SUZLON: 'NSE' }), { yahoo: ['SUZLON.NS', 'SUZLON.BO'] });
    assert.deepStrictEqual(H.sourceFor({ ticker: 'TSLA', asset_class: 'equity', exchange: 'US' }), { yahoo: ['TSLA'] });
  });
  check('a commodity is its futures symbol; a coin goes to CoinGecko by its id, never a guessed symbol', () => {
    assert.deepStrictEqual(H.sourceFor({ ticker: 'XAU', asset_class: 'commodity' }), { yahoo: ['GC=F'] });
    assert.deepStrictEqual(H.sourceFor({ ticker: 'BTC', asset_class: 'crypto' }), { coin: 'bitcoin' });
    assert.strictEqual(H.sourceFor({ ticker: 'NOSUCHCOIN', asset_class: 'crypto' }), null);
    assert.strictEqual(H.sourceFor({ ticker: 'EURUSD', asset_class: 'fx' }), null);
  });

  console.log('the tool:');
  check('it is one of Ask\'s tools and is Ask only: no price bars on /mcp or /v1', () => {
    assert.ok(TOOLS.find((x) => x.name === 'get_price_history') && typeof EXECUTORS.get_price_history === 'function');
    assert.ok(ASK_ONLY.includes('get_price_history') && !DATA_TOOLS.some((t) => t.name === 'get_price_history'));
  });
  await checkAsync('no name is an error the model can read, and nothing is fetched', async () => {
    const r = await runTool({ id: 't1', name: 'get_price_history', input: { name: '  ' } }, { heldSet: new Set(), holdings: [] });
    assert.ok(r.is_error && /name is required/.test(r.content));
  });

  console.log(`\n${passed} price-history checks passed`);
})();
