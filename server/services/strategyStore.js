/**
 * Saved strategies + paper deployments — the write operations, in one place.
 *
 * Shared by the web routes (routes/strategies.js, routes/paper.js) and the
 * key-authenticated transports (/mcp, /v1) so the caps, validation and the
 * deployment snapshot rule can't drift between them. Every function resolves to
 *   { ok: true, data } | { ok: false, status, error }
 * and never throws for an expected failure.
 */
const { queryOne } = require('../db');
const { STRATEGY_SERVICE } = require('../config');
const {
  callService, engineFailure, checkSymbols, isExchange, replayPaper, parseCapital, iso,
  EXCHANGES_SHOWN, SYMBOL, ENGINE_OFFLINE,
} = require('./strategyClient');
const { isId } = require('../middleware/idParam');

const MAX_SAVED_STRATEGIES = 20;
const MAX_ACTIVE_DEPLOYMENTS = 10;

const fail = (status, error) => ({ ok: false, status, error });

function strategyToJson(r) {
  return {
    id: r.id, name: r.name, kind: r.kind,
    spec: r.spec, strategy_name: r.strategy_name, params: r.params,
    symbols: r.symbols || [],
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

function deploymentToJson(r) {
  return {
    id: r.id, name: r.name, kind: r.kind,
    symbol: r.symbol, exchange: r.exchange,
    initial_cash: String(r.initial_cash),
    deployed_at: iso(r.deployed_at),
    status: r.status,
    stopped_at: r.stopped_at ? iso(r.stopped_at) : null,
  };
}

/**
 * A built-in strategy and its settings, checked against the engine's own catalog: the name
 * must be one it lists, and each setting one that strategy has, of the right kind and inside
 * its bounds. Pure. → null when fine, else the reason.
 * (A rule between two settings — a fast average shorter than the slow one — is the engine's
 * to check when the strategy runs; the catalog does not carry those.)
 */
function presetProblem(catalog, strategy, params) {
  const entry = (catalog || []).find((e) => e.name === strategy);
  if (!entry) return `There is no built-in strategy called "${String(strategy).slice(0, 60)}".`;
  if (params == null) return null;
  if (typeof params !== 'object' || Array.isArray(params)) return 'params must be an object of setting → value';
  for (const [key, value] of Object.entries(params)) {
    const spec = (entry.params || []).find((p) => p.name === key);
    if (!spec) return `${entry.label || entry.name} has no setting called "${String(key).slice(0, 40)}". It has: ${(entry.params || []).map((p) => p.name).join(', ') || 'none'}.`;
    if (spec.type === 'string') continue;
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    if (!Number.isFinite(n)) return `${key} must be a number.`;
    if (spec.type === 'int' && !Number.isInteger(n)) return `${key} must be a whole number.`;
    if (spec.min != null && n < spec.min) return `${key} is ${n}; it must be at least ${spec.min}.`;
    if (spec.max != null && n > spec.max) return `${key} is ${n}; it must be at most ${spec.max}.`;
  }
  return null;
}

// Save a Builder spec (custom) or a configured preset (strategy + params).
// `engine` is injectable for tests.
async function saveStrategy(userId, { name, custom, strategy, params, symbols } = {}, { engine = callService } = {}) {
  const cleanName = String(name || (custom && custom.name) || '').trim().slice(0, 80);
  if (!cleanName) return fail(400, 'name is required');
  if (!custom && !strategy) return fail(400, 'provide custom (Builder spec) or strategy (preset name)');
  const watch = checkSymbols(symbols);
  if (!watch.ok) return fail(400, watch.error);

  const count = await queryOne('SELECT COUNT(*)::int AS n FROM user_strategies WHERE user_id = $1', [userId]);
  if (count.n >= MAX_SAVED_STRATEGIES) {
    return fail(400, `Limit reached (${MAX_SAVED_STRATEGIES} saved strategies) — delete one first.`);
  }

  // Custom specs are validated by the engine before they're persisted, so the
  // saved list never accumulates broken strategies.
  if (custom) {
    const check = await engine('/api/strategies/validate', {
      method: 'POST', body: custom, timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS,
    });
    if (check.status !== 200) { const f = engineFailure(check); return fail(f.status, f.error); }
    if (!check.data.valid) return fail(400, 'invalid strategy: ' + (check.data.errors || []).join('; '));
  } else {
    // A preset is checked the same way: a name the engine does not have, or a setting
    // outside its bounds, used to be saved and then fail on every signal and every deploy.
    const catalog = await engine('/api/strategies', { timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS });
    if (catalog.status !== 200) { const f = engineFailure(catalog); return fail(f.status, f.error); }
    const problem = presetProblem(catalog.data.strategies, String(strategy), params);
    if (problem) return fail(400, problem);
  }

  try {
    const row = await queryOne(
      `INSERT INTO user_strategies (user_id, name, kind, spec, strategy_name, params, symbols)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [userId, cleanName, custom ? 'custom' : 'registry',
       custom ? JSON.stringify(custom) : null,
       custom ? null : String(strategy),
       custom ? null : JSON.stringify(params || {}),
       JSON.stringify(watch.symbols)]);
    return { ok: true, data: strategyToJson(row) };
  } catch (err) {
    if (String(err.message).includes('user_strategies_user_id_name_key')) {
      return fail(400, `You already have a strategy named “${cleanName}” — pick another name.`);
    }
    throw err;
  }
}

// Deploy a saved strategy on virtual money. No orders go anywhere: the
// deployment is a record, and its state is a replay from deployed_at.
//
// Before anything is stored the deployment is replayed once, as it would be on its first
// day. A symbol with no price data, a market the engine does not know or a strategy it
// cannot run used to be accepted: it then counted toward the limit, failed every time the
// page opened and made the daily job exit with an error. `replay` is injectable for tests.
async function deployPaper(userId, { strategy_id, symbol, exchange, initial_cash } = {}, { replay = replayPaper } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!strategy_id || !sym) return fail(400, 'strategy_id and symbol are required');
  if (!SYMBOL.test(sym)) return fail(400, `"${sym.slice(0, 30)}" does not look like a symbol.`);
  const market = String(exchange || 'US').trim().toUpperCase();
  if (!isExchange(market)) return fail(400, `Unknown market "${market.slice(0, 20)}". Use ${EXCHANGES_SHOWN}.`);
  const capital = parseCapital(initial_cash);
  if (!capital.ok) return fail(400, 'initial_cash must be between 1,000 and 100,000,000');
  const cash = Number(capital.value);
  if (!isId(typeof strategy_id === 'number' ? strategy_id : String(strategy_id))) return fail(404, 'saved strategy not found');

  const active = await queryOne(
    `SELECT COUNT(*)::int AS n FROM paper_deployments WHERE user_id = $1 AND status = 'active'`, [userId]);
  if (active.n >= MAX_ACTIVE_DEPLOYMENTS) {
    return fail(400, `Limit reached (${MAX_ACTIVE_DEPLOYMENTS} active deployments) — stop one first.`);
  }

  const strat = await queryOne(
    'SELECT * FROM user_strategies WHERE id = $1 AND user_id = $2', [strategy_id, userId]);
  if (!strat) return fail(404, 'saved strategy not found');

  const trial = await replay({
    kind: strat.kind, spec: strat.spec, strategy_name: strat.strategy_name, params: strat.params,
    symbol: sym, exchange: market, initial_cash: cash, deployed_at: new Date(), status: 'active', stopped_at: null,
  });
  if (trial.status !== 200) {
    const f = engineFailure(trial, 'the strategy engine refused it');
    if (f.status === 503) return fail(503, `${ENGINE_OFFLINE} A deployment is checked against the engine before it is created.`);
    return fail(f.status === 502 ? 502 : 400, f.status === 502 ? f.error : `This cannot be deployed: ${f.error}`);
  }

  // Snapshot the definition so later edits/deletes of the saved strategy
  // can't rewrite this deployment's track record.
  const row = await queryOne(
    `INSERT INTO paper_deployments
       (user_id, name, kind, spec, strategy_name, params, symbol, exchange, initial_cash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, strat.name, strat.kind,
     strat.spec ? JSON.stringify(strat.spec) : null,
     strat.strategy_name, strat.params ? JSON.stringify(strat.params) : null,
     sym, market, cash]);
  return { ok: true, data: deploymentToJson(row) };
}

// Freeze a deployment (its state then replays deploy → stopped_at).
async function stopPaper(userId, id) {
  if (!isId(typeof id === 'number' ? id : String(id))) return fail(404, 'active deployment not found');
  const row = await queryOne(
    `UPDATE paper_deployments SET status = 'stopped', stopped_at = CURRENT_DATE
     WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING *`,
    [id, userId]);
  if (!row) return fail(404, 'active deployment not found');
  return { ok: true, data: deploymentToJson(row) };
}

module.exports = {
  saveStrategy, deployPaper, stopPaper, presetProblem, strategyToJson, deploymentToJson,
  MAX_SAVED_STRATEGIES, MAX_ACTIVE_DEPLOYMENTS,
};
