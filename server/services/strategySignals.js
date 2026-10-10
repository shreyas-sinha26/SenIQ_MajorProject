/**
 * SenIQ signals in strategies — two things the Builder alone can't answer:
 *
 *   presets   Ready-made Builder specs (data/seniqPresets.json) that combine price rules
 *             with SenIQ signals. Templates to backtest, never recommendations.
 *
 *   compare   "Did the SenIQ signal help?" The same strategy is backtested twice over the
 *             same symbol and dates: as written, and with every SenIQ condition removed.
 *             The difference is the signal's measured contribution on that one run — with
 *             the coverage figure beside it, because a gate that had data on 3% of the bars
 *             mostly measures "trading less".
 *
 * Nothing here saves or deploys. Both engine calls are ordinary backtests.
 */

const PRESETS_DOC = require('../data/seniqPresets.json');
const { callService, flattenDetail, parseCapital } = require('./strategyClient');
const { seniqDataIfNeeded } = require('./signalHistory');

const COMBINATORS = new Set(['all', 'any']);
const RISK_KEYS = new Set(['stop_loss_pct', 'take_profit_pct']);

// ── Presets ──

/** Preset cards without the spec (for listings). Pure. */
function listPresets() {
  return PRESETS_DOC.presets.map((p) => ({
    id: p.id, name: p.name, description: p.description, signals: p.signals,
    inputs: p.inputs || [], data_depth: p.data_depth,
  }));
}

/**
 * A preset's Builder spec with its inputs filled in. Returns { ok, spec } or { ok:false, error }.
 * Inputs are plain text dropped into string fields only; quotes and braces are stripped so
 * an input can't reshape the spec. Pure.
 */
function instantiatePreset(id, inputs = {}) {
  const preset = PRESETS_DOC.presets.find((p) => p.id === id);
  if (!preset) return { ok: false, error: `unknown preset ${String(id).slice(0, 60)}` };
  const values = {};
  for (const inp of preset.inputs || []) {
    const v = String(inputs[inp.name] ?? '').replace(/["{}\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (inp.required && !v) return { ok: false, error: `${inp.name} is required for this template — enter the ${inp.label.toLowerCase()}.` };
    values[inp.name] = v;
  }
  const fill = (node) => {
    if (typeof node === 'string') return node.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? '');
    if (Array.isArray(node)) return node.map(fill);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v)]));
    return node;
  };
  return { ok: true, spec: fill(preset.spec), preset: { id: preset.id, name: preset.name, data_depth: preset.data_depth } };
}

// ── With / without ──

/**
 * The same spec with every SenIQ condition removed: SenIQ factors dropped, any rule that
 * reads one deleted, emptied groups collapsed. Risk exits (stop / target) stay.
 * Returns { ok:true, spec, removed } or { ok:false, error } when nothing comparable is left.
 * Pure.
 */
function stripSeniq(spec) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.factors)) return { ok: false, error: 'spec with factors is required' };
  const seniq = new Set(spec.factors.filter((f) => f && f.source === 'seniq').map((f) => f.id));
  if (!seniq.size) return { ok: false, error: 'This strategy uses no SenIQ signals, so there is nothing to compare.' };
  let removed = 0;
  const prune = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const [key] = Object.keys(node);
    const value = node[key];
    if (COMBINATORS.has(key)) {
      const kids = (Array.isArray(value) ? value : []).map(prune).filter(Boolean);
      return kids.length ? { [key]: kids } : null;
    }
    if (RISK_KEYS.has(key)) return node;
    if (Array.isArray(value) && value.some((x) => typeof x === 'string' && seniq.has(x))) { removed++; return null; }
    return node;
  };
  const entry = prune(spec.entry);
  const exit = prune(spec.exit);
  if (!entry) return { ok: false, error: 'Every entry rule in this strategy is a SenIQ signal, so there is no price-only version to compare with. Compare it with buy-and-hold instead (it is in every backtest).' };
  if (!exit) return { ok: false, error: 'Every exit rule in this strategy is a SenIQ signal, so the price-only version would never exit. Add a stop-loss or a price exit first.' };
  return {
    ok: true,
    removed,
    spec: {
      ...spec,
      name: `${String(spec.name || 'Strategy').slice(0, 50)} (without SenIQ signals)`,
      factors: spec.factors.filter((f) => !(f && f.source === 'seniq')),
      entry,
      exit,
    },
  };
}

const num = (x, d = 2) => {
  const n = Number(x);
  return x == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
};

// The engine's *_pct fields are FRACTIONS despite the name (0.0425 = 4.25%); convert once here.
const pct = (x) => {
  const n = Number(x);
  return x == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 100;
};

/** The figures worth comparing from one engine backtest reply, returns in percent. Pure. */
function runSummary(data) {
  const report = (data && data.report) || {};
  const m = report.metrics || {};
  return {
    return_pct: pct(m.total_return_pct),
    max_drawdown_pct: pct(m.max_drawdown_pct),
    sharpe: num(m.sharpe),
    trades: Array.isArray(report.trades) ? report.trades.length : null,
    final_equity: num(m.final_equity, 0),
  };
}

/** Plain-language caveats for a comparison. Pure. */
function comparisonNotes(withRun, withoutRun, coverage) {
  const notes = [];
  if (!coverage || coverage.pct == null) notes.push('The engine reported no SenIQ coverage for this run, so the SenIQ conditions may never have had data.');
  else if (coverage.pct < 50) notes.push(`SenIQ signals had data on only ${coverage.pct}% of the bars (from ${coverage.first_signal_date}). On the rest the SenIQ conditions were simply false, so the difference mostly reflects trading less, not better signals.`);
  if (withRun.trades != null && withRun.trades < 5) notes.push(`The SenIQ version made ${withRun.trades} trade(s). That is too few to tell skill from luck.`);
  if (withRun.trades === 0) notes.push('The SenIQ version never traded, so its return is just cash.');
  notes.push('One symbol, one period, past data. A difference here is a measurement of this run, not a forecast.');
  return notes;
}

/**
 * Backtest a Builder spec with and without its SenIQ conditions.
 * Resolves to { ok:true, data } | { ok:false, status, error } — never throws for an expected failure.
 * `engine` is injectable for tests.
 */
async function compareWithoutSeniq({ custom, symbol, exchange, start_date, end_date, initial_cash } = {}, { engine = callService, seniqData = seniqDataIfNeeded } = {}) {
  if (!custom || !symbol || !start_date || !end_date) return { ok: false, status: 400, error: 'custom (Builder spec), symbol, start_date and end_date are required' };
  const stripped = stripSeniq(custom);
  if (!stripped.ok) return { ok: false, status: 400, error: stripped.error };

  const capital = parseCapital(initial_cash);
  if (!capital.ok) return { ok: false, status: 400, error: capital.error };
  const base = { params: {}, strategy: null, symbol, exchange: exchange || 'US', start_date, end_date, initial_cash: capital.value };
  const [a, b] = await Promise.all([
    engine('/api/backtest', { method: 'POST', body: { ...base, custom, seniq_data: await seniqData(custom, symbol) } }),
    engine('/api/backtest', { method: 'POST', body: { ...base, custom: stripped.spec, seniq_data: null } }),
  ]);
  for (const out of [a, b]) {
    if (out.status === 200) continue;
    if ([400, 404, 422].includes(out.status)) return { ok: false, status: 400, error: flattenDetail(out.data) || 'invalid backtest request' };
    return { ok: false, status: 503, error: 'Strategy engine is offline — try again later.' };
  }

  const withRun = runSummary(a.data);
  const withoutRun = runSummary(b.data);
  const benchmark = ((a.data.report || {}).benchmark || {}).benchmark_total_return_pct;
  const coverage = a.data.seniq_coverage || null;
  const diff = (x, y) => (x == null || y == null ? null : num(x - y));
  return {
    ok: true,
    data: {
      symbol: String(symbol).toUpperCase(), start_date, end_date,
      with_seniq: withRun,
      without_seniq: withoutRun,
      difference: {
        return_pct: diff(withRun.return_pct, withoutRun.return_pct),
        max_drawdown_pct: diff(withRun.max_drawdown_pct, withoutRun.max_drawdown_pct),
        trades: diff(withRun.trades, withoutRun.trades),
      },
      buy_hold_return_pct: pct(benchmark),
      seniq_conditions_removed: stripped.removed,
      seniq_coverage: coverage,
      price_only_spec: stripped.spec,
      notes: comparisonNotes(withRun, withoutRun, coverage),
    },
  };
}

module.exports = { listPresets, instantiatePreset, stripSeniq, runSummary, comparisonNotes, compareWithoutSeniq, PRESETS_DOC };
