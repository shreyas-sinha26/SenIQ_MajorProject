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
const { callService, cleanSymbols, iso } = require('./strategyClient');

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

// Save a Builder spec (custom) or a configured preset (strategy + params).
async function saveStrategy(userId, { name, custom, strategy, params, symbols } = {}) {
  const cleanName = String(name || (custom && custom.name) || '').trim().slice(0, 80);
  if (!cleanName) return fail(400, 'name is required');
  if (!custom && !strategy) return fail(400, 'provide custom (Builder spec) or strategy (preset name)');

  const count = await queryOne('SELECT COUNT(*)::int AS n FROM user_strategies WHERE user_id = $1', [userId]);
  if (count.n >= MAX_SAVED_STRATEGIES) {
    return fail(400, `Limit reached (${MAX_SAVED_STRATEGIES} saved strategies) — delete one first.`);
  }

  // Custom specs are validated by the engine before they're persisted, so the
  // saved list never accumulates broken strategies.
  if (custom) {
    const check = await callService('/api/strategies/validate', {
      method: 'POST', body: custom, timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS,
    });
    if (check.status !== 200) return fail(503, 'Strategy engine is offline — try again later.');
    if (!check.data.valid) return fail(400, 'invalid strategy: ' + (check.data.errors || []).join('; '));
  }

  try {
    const row = await queryOne(
      `INSERT INTO user_strategies (user_id, name, kind, spec, strategy_name, params, symbols)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [userId, cleanName, custom ? 'custom' : 'registry',
       custom ? JSON.stringify(custom) : null,
       custom ? null : String(strategy),
       custom ? null : JSON.stringify(params || {}),
       JSON.stringify(cleanSymbols(symbols))]);
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
async function deployPaper(userId, { strategy_id, symbol, exchange, initial_cash } = {}) {
  const sym = String(symbol || '').trim().toUpperCase().slice(0, 20);
  if (!strategy_id || !sym) return fail(400, 'strategy_id and symbol are required');
  const cash = Number(initial_cash || 100000);
  if (!(cash >= 1000 && cash <= 100000000)) return fail(400, 'initial_cash must be between 1,000 and 100,000,000');

  const active = await queryOne(
    `SELECT COUNT(*)::int AS n FROM paper_deployments WHERE user_id = $1 AND status = 'active'`, [userId]);
  if (active.n >= MAX_ACTIVE_DEPLOYMENTS) {
    return fail(400, `Limit reached (${MAX_ACTIVE_DEPLOYMENTS} active deployments) — stop one first.`);
  }

  const strat = await queryOne(
    'SELECT * FROM user_strategies WHERE id = $1 AND user_id = $2', [strategy_id, userId]);
  if (!strat) return fail(404, 'saved strategy not found');

  // Snapshot the definition so later edits/deletes of the saved strategy
  // can't rewrite this deployment's track record.
  const row = await queryOne(
    `INSERT INTO paper_deployments
       (user_id, name, kind, spec, strategy_name, params, symbol, exchange, initial_cash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, strat.name, strat.kind,
     strat.spec ? JSON.stringify(strat.spec) : null,
     strat.strategy_name, strat.params ? JSON.stringify(strat.params) : null,
     sym, String(exchange || 'US').trim().toUpperCase().slice(0, 12), cash]);
  return { ok: true, data: deploymentToJson(row) };
}

// Freeze a deployment (its state then replays deploy → stopped_at).
async function stopPaper(userId, id) {
  const row = await queryOne(
    `UPDATE paper_deployments SET status = 'stopped', stopped_at = CURRENT_DATE
     WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING *`,
    [id, userId]);
  if (!row) return fail(404, 'active deployment not found');
  return { ok: true, data: deploymentToJson(row) };
}

module.exports = {
  saveStrategy, deployPaper, stopPaper, strategyToJson, deploymentToJson,
  MAX_SAVED_STRATEGIES, MAX_ACTIVE_DEPLOYMENTS,
};
