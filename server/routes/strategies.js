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
const { asyncRouter } = require('../middleware/asyncRouter');
const { query, queryOne, execute } = require('../db');
const { authMiddleware } = require('./auth');
const { attachTier, requireTier } = require('../middleware/tier');
const { STRATEGY_SERVICE } = require('../config');
const { seniqDataIfNeeded, seniqDataForWatchlist } = require('../services/signalHistory');

const { saveStrategy, strategyToJson, MAX_SAVED_STRATEGIES } = require('../services/strategyStore');
const { callService, engineFailure, checkSymbols, parseCapital } = require('../services/strategyClient');
const { idParam } = require('../middleware/idParam');
const { userRateLimit, LIMITS } = require('../middleware/rateLimit');
const { listPresets, instantiatePreset, compareWithoutSeniq } = require('../services/strategySignals');

const router = asyncRouter();
router.use(authMiddleware, attachTier);
router.param('id', idParam('strategy not found')); // a saved strategy's id; presets use :presetId

// An engine reply that is not a 200, as this route's answer.
const refuse = (res, out, fallback) => { const f = engineFailure(out, fallback); return res.status(f.status).json({ error: f.error }); };

// Runs on the engine are bounded per user (API keys have their own hourly budget).
const engineLimit = userRateLimit(LIMITS.ENGINE);

// GET /api/strategies/seniq-presets — ready-made specs that use SenIQ signals (any tier).
router.get('/seniq-presets', (req, res) => res.json({ presets: listPresets() }));

// POST /api/strategies/seniq-presets/:id — the preset's Builder spec with its inputs filled
// in (e.g. {politician}). Returns a spec to load into the Builder; saves nothing.
router.post('/seniq-presets/:presetId', (req, res) => {
  const out = instantiatePreset(req.params.presetId, req.body || {});
  if (!out.ok) return res.status(400).json({ error: out.error });
  res.json({ spec: out.spec, preset: out.preset });
});

// POST /api/strategies/compare — the same Builder spec backtested with and without its
// SenIQ conditions (Plus; two engine backtests).
router.post('/compare', requireTier('plus'), engineLimit, async (req, res) => {
  const out = await compareWithoutSeniq(req.body || {});
  if (out.ok) return res.json(out.data);
  res.status(out.status).json({ error: out.error });
});

// GET /api/strategies/catalog — strategy list + param schemas (any tier).
router.get('/catalog', async (req, res) => {
  const out = await callService('/api/strategies', { timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS });
  if (out.status !== 200) return refuse(res, out);
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
  if (out.status !== 200) return refuse(res, out);
  res.json(out.data);
});

// POST /api/strategies/backtest — run one backtest (Plus+). Either a registry
// strategy (`strategy` + `params`) or a Builder spec (`custom`).
router.post('/backtest', requireTier('plus'), engineLimit, async (req, res) => {
  const { strategy, custom, params, symbol, exchange, start_date, end_date, initial_cash } = req.body || {};
  if ((!strategy && !custom) || !symbol || !start_date || !end_date) {
    return res.status(400).json({ error: 'strategy (or custom), symbol, start_date and end_date are required' });
  }
  const capital = parseCapital(initial_cash);
  if (!capital.ok) return res.status(400).json({ error: capital.error });
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
      initial_cash: capital.value,
      seniq_data: seniqData,
    },
  });
  if (out.status === 200) return res.json(out.data);
  return refuse(res, out, 'invalid backtest request');
});

// POST /api/strategies/walk-forward — out-of-sample robustness check (Plus).
// Same body as /backtest plus n_splits (2–12) and scheme (anchored | rolling).
router.post('/walk-forward', requireTier('plus'), engineLimit, async (req, res) => {
  const { strategy, custom, params, symbol, exchange, start_date, end_date, n_splits, scheme } = req.body || {};
  if ((!strategy && !custom) || !symbol || !start_date || !end_date) {
    return res.status(400).json({ error: 'strategy (or custom), symbol, start_date and end_date are required' });
  }
  const out = await callService('/api/walk-forward', {
    method: 'POST',
    body: {
      strategy: strategy || null, custom: custom || null, params: params || {},
      symbol, exchange: exchange || 'US', start_date, end_date,
      n_splits: Number(n_splits) || 4, scheme: scheme || 'anchored',
      seniq_data: custom ? await seniqDataIfNeeded(custom, symbol) : null,
    },
  });
  if (out.status === 200) return res.json(out.data);
  return refuse(res, out);
});

// ─── Saved strategies (Your Strategies) — all Plus+ ─────────

// GET /api/strategies/saved — the user's saved strategies.
router.get('/saved', requireTier('plus'), async (req, res) => {
  const rows = await query(
    'SELECT * FROM user_strategies WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ strategies: rows.map(strategyToJson), max: MAX_SAVED_STRATEGIES });
});

// POST /api/strategies/saved — save a Builder spec or a configured preset.
router.post('/saved', requireTier('plus'), async (req, res) => {
  const out = await saveStrategy(req.user.id, req.body || {});
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out.data);
});

// PUT /api/strategies/saved/:id — rename / edit watchlist.
router.put('/saved/:id', requireTier('plus'), async (req, res) => {
  const { name, symbols } = req.body || {};
  const row = await queryOne(
    'SELECT * FROM user_strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'strategy not found' });
  const newName = name != null ? String(name).trim().slice(0, 80) : row.name;
  if (!newName) return res.status(400).json({ error: 'name cannot be empty' });
  const watch = symbols != null ? checkSymbols(symbols) : { ok: true, symbols: row.symbols };
  if (!watch.ok) return res.status(400).json({ error: watch.error });
  let updated;
  try {
    updated = await queryOne(
      `UPDATE user_strategies SET name = $1, symbols = $2, updated_at = now()
       WHERE id = $3 AND user_id = $4 RETURNING *`,
      [newName, JSON.stringify(watch.symbols), req.params.id, req.user.id]);
  } catch (err) {
    // Renamed onto a name already in use: the same answer saving gives, not a 500.
    if (String(err.message).includes('user_strategies_user_id_name_key')) {
      return res.status(400).json({ error: `You already have a strategy named “${newName}” — pick another name.` });
    }
    throw err;
  }
  res.json(strategyToJson(updated));
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
  // A 404 here would read as "strategy not found"; the strategy exists, the engine refused it.
  const f = engineFailure(out, 'signal evaluation failed');
  return res.status(f.status === 404 ? 400 : f.status).json({ error: f.error });
});

module.exports = router;
