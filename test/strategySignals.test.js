/**
 * Offline tests for SenIQ signals in strategies: the presets, the with/without-SenIQ
 * comparison (against a stand-in engine), and the 13F / CUSIP plumbing. No DB, no engine.
 */

const assert = require('node:assert');
const S = require('../server/services/strategySignals');
const { fundHoldings } = require('../server/services/signalHistory');
const { cusipToTicker, CUSIP_TO_TICKER } = require('../server/services/smartMoney/cusipMap');
const { UNIVERSE } = require('../server/data/universe');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

const SPEC = {
  name: 'Mixed',
  factors: [
    { id: 'ema_f', fn: 'ema', params: { period: 20 } },
    { id: 'ema_s', fn: 'ema', params: { period: 50 } },
    { id: 'sz', source: 'seniq', metric: 'sentiment_zscore' },
    { id: 'cb', source: 'seniq', metric: 'congress_buyers', params: { window_days: 45 } },
  ],
  entry: { all: [{ crossover: ['ema_f', 'ema_s'] }, { any: [{ gt: ['sz', 0] }, { gte: ['cb', 2] }] }] },
  exit: { any: [{ crossunder: ['ema_f', 'ema_s'] }, { lt: ['sz', -1] }, { stop_loss_pct: 8 }] },
  sizing: { type: 'percent_equity', value: 25 },
};

section('presets:');
check('four presets, each with a data-depth note and only known SenIQ metrics', () => {
  const known = new Set(['sentiment_avg', 'sentiment_acute', 'sentiment_zscore', 'news_volume', 'congress_net_buys', 'congress_buys', 'congress_sells', 'congress_buyers', 'funds_holding', 'funds_net_adds', 'funds_new_positions']);
  const list = S.listPresets();
  assert.strictEqual(list.length, 4);
  assert.strictEqual(new Set(list.map((p) => p.id)).size, 4);
  for (const p of S.PRESETS_DOC.presets) {
    assert.ok(p.data_depth && p.data_depth.length > 20, p.id);
    const used = p.spec.factors.filter((f) => f.source === 'seniq').map((f) => f.metric);
    assert.ok(used.length && used.every((m) => known.has(m)), p.id);
    assert.deepStrictEqual([...new Set(used)].sort(), [...p.signals].sort(), p.id);
    assert.ok(p.spec.entry && p.spec.exit && p.spec.sizing, p.id);
  }
  assert.ok(!('spec' in list[0])); // listings stay small
});
check('inputs are filled into the spec; a required one is enforced', () => {
  const out = S.instantiatePreset('follow-a-politician', { politician: '  Jane   Doe ' });
  assert.strictEqual(out.spec.name, 'Follow Jane Doe');
  assert.deepStrictEqual(out.spec.factors.map((f) => f.params.politician), ['Jane Doe', 'Jane Doe']);
  assert.ok(!JSON.stringify(out.spec).includes('{{'));
  assert.ok(/politician is required/.test(S.instantiatePreset('follow-a-politician', {}).error));
  assert.ok(/unknown preset/.test(S.instantiatePreset('nope').error));
});
check('an input cannot reshape the spec', () => {
  const out = S.instantiatePreset('follow-a-politician', { politician: 'x"}, {"metric": "evil"}' });
  assert.strictEqual(out.spec.factors.length, 2);
  assert.ok(!/["{}]/.test(out.spec.factors[0].params.politician));
  assert.ok(out.spec.factors[0].params.politician.length <= 80);
});
check('instantiating does not mutate the stored preset', () => {
  S.instantiatePreset('follow-a-politician', { politician: 'A B' });
  assert.ok(JSON.stringify(S.PRESETS_DOC.presets.find((p) => p.id === 'follow-a-politician').spec).includes('{{politician}}'));
});

section('strip SenIQ conditions:');
check('SenIQ rules and factors go, price rules and risk exits stay, empty groups collapse', () => {
  const r = S.stripSeniq(SPEC);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, 3);
  assert.deepStrictEqual(r.spec.factors.map((f) => f.id), ['ema_f', 'ema_s']);
  assert.deepStrictEqual(r.spec.entry, { all: [{ crossover: ['ema_f', 'ema_s'] }] });
  assert.deepStrictEqual(r.spec.exit, { any: [{ crossunder: ['ema_f', 'ema_s'] }, { stop_loss_pct: 8 }] });
  assert.deepStrictEqual(r.spec.sizing, SPEC.sizing);
  assert.ok(r.spec.name.endsWith('(without SenIQ signals)'));
  assert.strictEqual(SPEC.factors.length, 4); // input untouched
});
check('nothing comparable left → a clear refusal, not a silent empty strategy', () => {
  const onlySeniqEntry = { ...SPEC, entry: { all: [{ gt: ['sz', 0] }] } };
  assert.ok(/Every entry rule/.test(S.stripSeniq(onlySeniqEntry).error));
  const onlySeniqExit = { ...SPEC, exit: { any: [{ lt: ['sz', -1] }] } };
  assert.ok(/Every exit rule/.test(S.stripSeniq(onlySeniqExit).error));
  const riskOnlyExit = { ...SPEC, exit: { any: [{ lt: ['sz', -1] }, { stop_loss_pct: 5 }] } };
  assert.deepStrictEqual(S.stripSeniq(riskOnlyExit).spec.exit, { any: [{ stop_loss_pct: 5 }] });
  assert.ok(/no SenIQ signals/.test(S.stripSeniq({ ...SPEC, factors: SPEC.factors.slice(0, 2) }).error));
  assert.ok(S.stripSeniq(null).error);
});

section('with / without comparison (stand-in engine):');
const reply = (ret, trades, coveragePct) => ({ status: 200, data: {
  // The engine reports returns as fractions (0.08 = 8%); `ret` here is in percent for readability.
  report: { metrics: { total_return_pct: String(ret / 100), max_drawdown_pct: '-0.055', sharpe: '0.9', final_equity: '108000' }, trades: Array(trades).fill({}), benchmark: { benchmark_total_return_pct: '0.06' } },
  seniq_coverage: coveragePct == null ? null : { pct: coveragePct, first_signal_date: '2026-09-21' },
} });
const ARGS = { custom: SPEC, symbol: 'nvda', start_date: '2025-01-01', end_date: '2026-10-01' };
check('two backtests: the original with SenIQ data, the stripped one without', async () => {
  const calls = [];
  const engine = async (path, opts) => { calls.push(opts.body); return opts.body.seniq_data ? reply(8, 12, 80) : reply(3, 20, null); };
  const out = await S.compareWithoutSeniq(ARGS, { engine, seniqData: async () => ({ sentiment: [1] }) });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].custom.factors.length, 4);
  assert.strictEqual(calls[1].custom.factors.length, 2);
  assert.strictEqual(calls[1].seniq_data, null);
  assert.deepStrictEqual([calls[0].symbol, calls[0].start_date, calls[0].end_date], [calls[1].symbol, calls[1].start_date, calls[1].end_date]);
  const d = out.data;
  assert.deepStrictEqual([d.with_seniq.return_pct, d.without_seniq.return_pct, d.difference.return_pct, d.difference.trades], [8, 3, 5, -8]);
  assert.deepStrictEqual([d.buy_hold_return_pct, d.seniq_conditions_removed, d.symbol], [6, 3, 'NVDA']);
  assert.ok(d.notes.some((n) => /not a forecast/.test(n)));
  assert.ok(!d.notes.some((n) => /only \d/.test(n))); // 80% coverage: no low-coverage warning
});
check('low coverage and few trades are called out', async () => {
  const engine = async (path, opts) => (opts.body.seniq_data ? reply(1, 2, 3.1) : reply(4, 20, null));
  const d = (await S.compareWithoutSeniq(ARGS, { engine, seniqData: async () => ({}) })).data;
  assert.ok(d.notes.some((n) => /only 3.1% of the bars/.test(n) && /trading less/.test(n)));
  assert.ok(d.notes.some((n) => /2 trade\(s\)/.test(n)));
  const none = (await S.compareWithoutSeniq(ARGS, { engine: async () => reply(0, 0, null), seniqData: async () => ({}) })).data;
  assert.ok(none.notes.some((n) => /never traded/.test(n)) && none.notes.some((n) => /no SenIQ coverage/.test(n)));
});
check('engine offline / rejected / bad input come back as errors, never numbers', async () => {
  const off = await S.compareWithoutSeniq(ARGS, { engine: async () => ({ status: 503, data: {} }), seniqData: async () => null });
  assert.deepStrictEqual([off.ok, off.status], [false, 503]);
  const bad = await S.compareWithoutSeniq(ARGS, { engine: async () => ({ status: 400, data: { detail: 'no data for symbol' } }), seniqData: async () => null });
  assert.deepStrictEqual([bad.ok, bad.status, bad.error], [false, 400, 'no data for symbol']);
  let called = 0;
  const missing = await S.compareWithoutSeniq({ custom: SPEC }, { engine: async () => { called++; return reply(1, 1, 1); } });
  assert.deepStrictEqual([missing.ok, missing.status, called], [false, 400, 0]);
  const noSeniq = await S.compareWithoutSeniq({ ...ARGS, custom: { ...SPEC, factors: SPEC.factors.slice(0, 2) } }, { engine: async () => { called++; return reply(1, 1, 1); } });
  assert.deepStrictEqual([noSeniq.ok, called], [false, 0]);
});

section('13F plumbing:');
check('one statement per fund and filing: adding outranks trimming outranks no change', () => {
  const rows = [
    { fund: 'a', date: '2026-08-14', change: 'unchanged' }, { fund: 'a', date: '2026-08-14', change: 'added' },
    { fund: 'a', date: '2026-05-15', change: 'reduced' }, { fund: 'b', date: '2026-08-14', change: 'baseline' },
  ];
  assert.deepStrictEqual(fundHoldings(rows).sort((x, y) => (x.fund + x.date).localeCompare(y.fund + y.date)), [
    { fund: 'a', date: '2026-05-15', change: 'reduced' }, { fund: 'a', date: '2026-08-14', change: 'added' }, { fund: 'b', date: '2026-08-14', change: 'baseline' },
  ]);
  assert.deepStrictEqual(fundHoldings(null), []);
});
check('every US universe name has exactly one CUSIP in the map', () => {
  const byTicker = {};
  for (const [cusip, t] of Object.entries(CUSIP_TO_TICKER)) (byTicker[t] = byTicker[t] || []).push(cusip);
  const us = UNIVERSE.filter((c) => c.country === 'US').map((c) => c.ticker);
  assert.strictEqual(us.length, 100);
  assert.deepStrictEqual(us.filter((t) => !byTicker[t]), []);
  assert.deepStrictEqual(us.filter((t) => byTicker[t].length !== 1), []);
  assert.ok(Object.keys(CUSIP_TO_TICKER).every((c) => /^[0-9A-Z]{9}$/.test(c)));
});
check('lookups: case-insensitive; ETFs and other share classes stay unmapped', () => {
  assert.strictEqual(cusipToTicker('09290d101'), 'BLK');
  assert.strictEqual(cusipToTicker('464287655'), null); // iShares Russell 2000 — not BlackRock stock
  assert.strictEqual(cusipToTicker('594972AQ4'), null); // a Strategy convertible note — not MSTR stock
  assert.strictEqual(cusipToTicker(null), null);
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} checks passed`);
})();
