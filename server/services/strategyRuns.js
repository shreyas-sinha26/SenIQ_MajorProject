/**
 * One-off runs on the strategy engine — a backtest and the robustness check — in one place.
 *
 * Shared by the web routes (routes/strategies.js) and the key-authenticated transports
 * (/v1, /mcp), so what is checked before the engine is asked cannot drift between them:
 * the symbol and market, the dates, the starting capital, the number of folds, and a
 * built-in strategy's settings (the same check saving one gets). Every function resolves to
 *   { ok: true, data } | { ok: false, status, error }
 * and never throws for an expected failure. `engine` and `seniqData` are injectable for tests.
 */
const { callService, engineFailure, checkRun, parseCapital, parseSplits } = require('./strategyClient');
const { presetRefusal } = require('./strategyStore');

const SCHEMES = ['anchored', 'rolling'];
const fail = (status, error) => ({ ok: false, status, error });
const defaultSeniqData = (...args) => require('./signalHistory').seniqDataIfNeeded(...args); // lazy: it needs the DB

// What both runs share: what to run, on what, over which dates. → { ok, body } | a failure.
async function prepare(input, { engine, seniqData }) {
  const { strategy, custom, params, symbol, start_date, end_date } = input || {};
  if ((!strategy && !custom) || !symbol || !start_date || !end_date) {
    return fail(400, 'strategy (or custom), symbol, start_date and end_date are required');
  }
  if (custom != null && (typeof custom !== 'object' || Array.isArray(custom))) return fail(400, 'custom must be a Builder spec');
  if (!custom && typeof strategy !== 'string') return fail(400, 'strategy must be the name of a built-in strategy');
  const target = checkRun(input);
  if (!target.ok) return fail(400, target.error);
  // A Builder spec is checked by the engine as part of the run. A built-in strategy's
  // settings are checked here first: "fast: 12.7" and a setting it does not have used to run.
  if (!custom) {
    const refusal = await presetRefusal(strategy, params, engine);
    if (refusal) return fail(refusal.status, refusal.error);
  }
  return {
    ok: true,
    body: {
      strategy: custom ? null : strategy,
      custom: custom || null,
      params: custom ? {} : (params || {}),
      symbol: target.symbol,
      exchange: target.exchange,
      start_date,
      end_date,
      // Builder specs with SenIQ factors get that ticker's raw signal history pushed along;
      // the engine derives and aligns the series.
      seniq_data: custom ? await seniqData(custom, target.symbol) : null,
    },
  };
}

// Body: { strategy | custom, params?, symbol, exchange?, start_date, end_date, initial_cash? }
async function runBacktest(input, { engine = callService, seniqData = defaultSeniqData } = {}) {
  const capital = parseCapital((input || {}).initial_cash);
  if (!capital.ok) return fail(400, capital.error);
  const ready = await prepare(input, { engine, seniqData });
  if (!ready.ok) return ready;
  const out = await engine('/api/backtest', { method: 'POST', body: { ...ready.body, initial_cash: capital.value } });
  if (out.status === 200) return { ok: true, data: out.data };
  const f = engineFailure(out, 'invalid backtest request');
  return fail(f.status, f.error);
}

// The backtest body plus n_splits? (2–12, default 4) and scheme? (anchored | rolling).
async function runWalkForward(input, { engine = callService, seniqData = defaultSeniqData } = {}) {
  const splits = parseSplits((input || {}).n_splits);
  if (!splits.ok) return fail(400, splits.error);
  const scheme = (input || {}).scheme == null || (input || {}).scheme === '' ? 'anchored' : (input || {}).scheme;
  if (!SCHEMES.includes(scheme)) return fail(400, 'scheme must be "anchored" or "rolling".');
  const ready = await prepare(input, { engine, seniqData });
  if (!ready.ok) return ready;
  const out = await engine('/api/walk-forward', { method: 'POST', body: { ...ready.body, n_splits: splits.value, scheme } });
  if (out.status === 200) return { ok: true, data: out.data };
  const f = engineFailure(out);
  return fail(f.status, f.error);
}

module.exports = { runBacktest, runWalkForward };
