/**
 * Strategies routes (Phase 7) — thin proxy to the Python strategy service.
 *
 * SenIQ owns auth + tier gating here; the service owns the engine. When the
 * service is unreachable these routes return 503 with a friendly message and
 * the rest of the app is unaffected (teammates without the service just see
 * "engine offline" on the Backtest page).
 *
 * Per STRATEGY_PLAN.md: backtest = Plus+. Catalog is open to any logged-in
 * user so Free users can browse strategies (the tier table gives Free
 * "list + descriptions").
 */
const express = require('express');
const { query, queryOne, execute } = require('../db');
const { authMiddleware } = require('./auth');
const { attachTier, requireTier } = require('../middleware/tier');
const { STRATEGY_SERVICE } = require('../config');
const { seniqDataIfNeeded, seniqDataForWatchlist } = require('../services/signalHistory');

const MAX_SAVED_STRATEGIES = 20;
const MAX_WATCH_SYMBOLS = 5;

const router = express.Router();
router.use(authMiddleware, attachTier);

function serviceHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (STRATEGY_SERVICE.SECRET) h['X-Service-Secret'] = STRATEGY_SERVICE.SECRET;
  return h;
}

// Calls the service and normalizes transport failures to 503. Service-level
// errors (400/404 param problems) pass through with their detail so the UI
// can show the real reason.
async function callService(path, { method = 'GET', body, timeoutMs } = {}) {
  const url = `${STRATEGY_SERVICE.URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || STRATEGY_SERVICE.TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: serviceHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { detail: 'strategy engine is offline' }, transportError: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/strategies/catalog — strategy list + param schemas (any tier).
router.get('/catalog', async (req, res) => {
  const out = await callService('/api/strategies', { timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS });
  if (out.status !== 200) {
    return res.status(503).json({ error: 'Strategy engine is offline — try again later.' });
  }
  res.json(out.data);
});

// POST /api/strategies/validate — check a Builder spec without running it
// (any tier; validation is free and the Builder uses it for live feedback).
router.post('/validate', async (req, res) => {
  const out = await callService('/api/strategies/validate', {
    method: 'POST',
    body: req.body || {},
    timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS,
  });
  if (out.status !== 200) {
    return res.status(503).json({ error: 'Strategy engine is offline — try again later.' });
  }
  res.json(out.data);
});

// POST /api/strategies/backtest — run one backtest (Plus+). Either a registry
// strategy (`strategy` + `params`) or a Builder spec (`custom`).
router.post('/backtest', requireTier('plus'), async (req, res) => {
  const { strategy, custom, params, symbol, exchange, start_date, end_date, initial_cash } = req.body || {};
  if ((!strategy && !custom) || !symbol || !start_date || !end_date) {
    return res.status(400).json({ error: 'strategy (or custom), symbol, start_date and end_date are required' });
  }
  // Builder specs with SenIQ factors get that ticker's raw signal history
  // pushed along; the service derives + aligns the series.
  const seniqData = custom ? await seniqDataIfNeeded(custom, symbol) : null;

  const out = await callService('/api/backtest', {
    method: 'POST',
    body: {
      strategy: strategy || null,
      custom: custom || null,
      params: params || {},
      symbol,
      exchange: exchange || 'US',
      start_date,
      end_date,
      initial_cash: String(initial_cash || '100000'),
      seniq_data: seniqData,
    },
  });
  if (out.status === 200) return res.json(out.data);
  if (out.status === 400 || out.status === 404 || out.status === 422) {
    // 422 = FastAPI/pydantic validation; its detail is an array of field errors.
    const detail = Array.isArray(out.data.detail)
      ? out.data.detail.map((d) => `${(d.loc || []).join('.')}: ${d.msg}`).join('; ')
      : out.data.detail;
    return res.status(out.status === 422 ? 400 : out.status).json({ error: detail || 'invalid backtest request' });
  }
  return res.status(503).json({ error: 'Strategy engine is offline — try again later.' });
});

// ─── Saved strategies (Your Strategies) — all Plus+ ─────────

// Normalizes + bounds a client watchlist: [{symbol, exchange}], max 5.
function cleanSymbols(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => ({
      symbol: String((s && s.symbol) || '').trim().toUpperCase().slice(0, 20),
      exchange: String((s && s.exchange) || 'US').trim().toUpperCase().slice(0, 12),
    }))
    .filter((s) => /^[A-Z0-9.\-&]{1,20}$/.test(s.symbol))
    .slice(0, MAX_WATCH_SYMBOLS);
}

function rowToJson(r) {
  return {
    id: r.id, name: r.name, kind: r.kind,
    spec: r.spec, strategy_name: r.strategy_name, params: r.params,
    symbols: r.symbols || [],
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

// GET /api/strategies/saved — the user's saved strategies.
router.get('/saved', requireTier('plus'), async (req, res) => {
  const rows = await query(
    'SELECT * FROM user_strategies WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ strategies: rows.map(rowToJson), max: MAX_SAVED_STRATEGIES });
});

// POST /api/strategies/saved — save a Builder spec or a configured preset.
router.post('/saved', requireTier('plus'), async (req, res) => {
  const { name, custom, strategy, params, symbols } = req.body || {};
  const cleanName = String(name || (custom && custom.name) || '').trim().slice(0, 80);
  if (!cleanName) return res.status(400).json({ error: 'name is required' });
  if (!custom && !strategy) return res.status(400).json({ error: 'provide custom (Builder spec) or strategy (preset name)' });

  const count = await queryOne('SELECT COUNT(*)::int AS n FROM user_strategies WHERE user_id = $1', [req.user.id]);
  if (count.n >= MAX_SAVED_STRATEGIES) {
    return res.status(400).json({ error: `Limit reached (${MAX_SAVED_STRATEGIES} saved strategies) — delete one first.` });
  }

  // Custom specs are validated by the engine before they're persisted, so the
  // saved list never accumulates broken strategies.
  if (custom) {
    const check = await callService('/api/strategies/validate', {
      method: 'POST', body: custom, timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS,
    });
    if (check.status !== 200) return res.status(503).json({ error: 'Strategy engine is offline — try again later.' });
    if (!check.data.valid) return res.status(400).json({ error: 'invalid strategy: ' + (check.data.errors || []).join('; ') });
  }

  try {
    const row = await queryOne(
      `INSERT INTO user_strategies (user_id, name, kind, spec, strategy_name, params, symbols)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id, cleanName, custom ? 'custom' : 'registry',
       custom ? JSON.stringify(custom) : null,
       custom ? null : String(strategy),
       custom ? null : JSON.stringify(params || {}),
       JSON.stringify(cleanSymbols(symbols))]);
    res.status(201).json(rowToJson(row));
  } catch (err) {
    if (String(err.message).includes('user_strategies_user_id_name_key')) {
      return res.status(400).json({ error: `You already have a strategy named “${cleanName}” — pick another name.` });
    }
    throw err;
  }
});

// PUT /api/strategies/saved/:id — rename / edit watchlist.
router.put('/saved/:id', requireTier('plus'), async (req, res) => {
  const { name, symbols } = req.body || {};
  const row = await queryOne(
    'SELECT * FROM user_strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'strategy not found' });
  const newName = name != null ? String(name).trim().slice(0, 80) : row.name;
  if (!newName) return res.status(400).json({ error: 'name cannot be empty' });
  const newSymbols = symbols != null ? cleanSymbols(symbols) : row.symbols;
  const updated = await queryOne(
    `UPDATE user_strategies SET name = $1, symbols = $2, updated_at = now()
     WHERE id = $3 AND user_id = $4 RETURNING *`,
    [newName, JSON.stringify(newSymbols), req.params.id, req.user.id]);
  res.json(rowToJson(updated));
});

// DELETE /api/strategies/saved/:id
router.delete('/saved/:id', requireTier('plus'), async (req, res) => {
  const out = await execute(
    'DELETE FROM user_strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (out.rowCount === 0) return res.status(404).json({ error: 'strategy not found' });
  res.json({ deleted: true });
});

// POST /api/strategies/saved/:id/signal — live rule state across the watchlist.
router.post('/saved/:id/signal', requireTier('plus'), async (req, res) => {
  const row = await queryOne(
    'SELECT * FROM user_strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'strategy not found' });
  const symbols = row.symbols || [];
  if (!symbols.length) return res.json({ signals: [], has_protective_exits: false, note: 'no symbols watched' });

  const out = await callService('/api/signal', {
    method: 'POST',
    body: row.kind === 'custom'
      ? { custom: row.spec, symbols, seniq_data: await seniqDataForWatchlist(row.spec, symbols) }
      : { strategy: row.strategy_name, params: row.params || {}, symbols },
  });
  if (out.status === 200) return res.json(out.data);
  if (out.status === 400 || out.status === 404) {
    return res.status(out.status).json({ error: out.data.detail || 'signal evaluation failed' });
  }
  return res.status(503).json({ error: 'Strategy engine is offline — try again later.' });
});

module.exports = router;
