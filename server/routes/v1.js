/**
 * Public REST API (/v1) — the same read+run surface the MCP server exposes
 * (strategy engine + SenIQ data tools), as plain JSON endpoints for scripts,
 * notebooks, and integrations.
 *
 * Auth: per-user API key ("Authorization: Bearer seniq_…", managed in
 * Profile → API Access), Pro-gated. Rate limits are SHARED with /mcp — one
 * budget per key per hour across both transports (services/apiKeyGate.js):
 * heavy (backtest/signals/paper replay) 30/h, light (everything else) 240/h.
 * Every response carries X-RateLimit-Limit / X-RateLimit-Remaining; 429s add
 * Retry-After (seconds). Docs: /docs.
 */
const { asyncRouter } = require('../middleware/asyncRouter');
const { query, queryOne } = require('../db');
const { DISCLAIMER, STRATEGY_SERVICE } = require('../config');
const { resolveApiKey, heavyLimiter, lightLimiter } = require('../services/apiKeyGate');
const { callService, engineFailure, cleanSymbols, parseCapital, replayPaper, MAX_WATCH_SYMBOLS } = require('../services/strategyClient');
const { idParam } = require('../middleware/idParam');
const { seniqDataIfNeeded, seniqDataForWatchlist } = require('../services/signalHistory');
const { DATA_TOOLS, runDataTool } = require('../services/dataTools');
const { saveStrategy, deployPaper, stopPaper, strategyToJson, deploymentToJson } = require('../services/strategyStore');
const { readLedger } = require('../services/paperLedger');
const { listPresets, instantiatePreset, compareWithoutSeniq } = require('../services/strategySignals');

const router = asyncRouter();
// A paper deployment's id. (Runs after the key check: params are resolved when a route is
// matched, and the auth below is the first thing in the stack.) Presets use :presetId.
router.param('id', idParam('deployment not found'));

// ─── Auth (every /v1 route) ──────────────────────────────────
router.use(async (req, res, next) => {
  const verdict = await resolveApiKey(req.headers.authorization);
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.message });
  req.apiCtx = verdict.ctx;
  next();
});

// ─── Rate limiting (per key, shared with /mcp) ───────────────
function gate(limiter) {
  return (req, res, next) => {
    const verdict = limiter.allow(req.apiCtx.keyId);
    res.set('X-RateLimit-Limit', String(limiter.limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, verdict.remaining)));
    if (!verdict.allowed) {
      res.set('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'rate limit exceeded — try again later' });
    }
    next();
  };
}

// Map a strategy-service reply straight onto the HTTP response.
function passthrough(res, out) {
  if (out.status === 200) return res.json(out.data);
  const f = engineFailure(out);
  return res.status(f.status).json({ error: f.error });
}

// ─── GET /v1 — index (auth'd; doubles as a key check) ────────
router.get('/', gate(lightLimiter), (req, res) => {
  res.json({
    name: 'SenIQ API',
    version: 1,
    docs: '/docs',
    endpoints: [
      'GET  /v1/strategies',
      'POST /v1/strategies/validate',
      'GET  /v1/strategies/seniq-presets',
      'POST /v1/strategies/seniq-presets/:id',
      'POST /v1/backtest',
      'POST /v1/strategies/compare',
      'POST /v1/walk-forward',
      'POST /v1/signals',
      'GET  /v1/strategies/saved',
      'GET  /v1/paper',
      'GET  /v1/paper/:id/state',
      'GET  /v1/paper/:id/ledger',
      ...DATA_TOOLS.map((t) => `GET  ${t.rest}`),
      'POST /v1/strategies/saved        (write key)',
      'POST /v1/paper                   (write key)',
      'POST /v1/paper/:id/stop          (write key)',
    ],
    key: { can_write: req.apiCtx.canWrite },
    rate_limits: {
      heavy: `${heavyLimiter.limit}/hour (backtest, signals, paper state)`,
      light: `${lightLimiter.limit}/hour (everything else)`,
      note: 'shared per key across the REST API and the MCP server',
    },
    disclaimer: DISCLAIMER,
  });
});

// ─── GET /v1/strategies — catalog + Builder vocabulary ───────
router.get('/strategies', gate(lightLimiter), async (req, res) => {
  passthrough(res, await callService('/api/strategies', { timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS }));
});

// ─── POST /v1/strategies/validate — check a Builder spec ─────
// Body: the spec itself (or {spec: …}).
router.post('/strategies/validate', gate(lightLimiter), async (req, res) => {
  const spec = (req.body && req.body.spec) || req.body || {};
  passthrough(res, await callService('/api/strategies/validate', {
    method: 'POST', body: spec, timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS,
  }));
});

// ─── POST /v1/backtest — run one backtest ────────────────────
// Body: {strategy|custom, params?, symbol, exchange?, start_date, end_date, initial_cash?}
router.post('/backtest', gate(heavyLimiter), async (req, res) => {
  const { strategy, custom, params, symbol, exchange, start_date, end_date, initial_cash } = req.body || {};
  if ((!strategy && !custom) || !symbol || !start_date || !end_date) {
    return res.status(400).json({ error: 'strategy (or custom), symbol, start_date and end_date are required' });
  }
  const capital = parseCapital(initial_cash);
  if (!capital.ok) return res.status(400).json({ error: capital.error });
  const seniqData = custom ? await seniqDataIfNeeded(custom, symbol) : null;
  passthrough(res, await callService('/api/backtest', {
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
  }));
});

// ─── SenIQ presets + the with/without-SenIQ comparison ───────
// GET  /v1/strategies/seniq-presets          ready-made specs that use SenIQ signals
// POST /v1/strategies/seniq-presets/:id      that spec with inputs filled in ({politician})
// POST /v1/strategies/compare                {custom, symbol, start_date, end_date, …} → both runs
router.get('/strategies/seniq-presets', gate(lightLimiter), (req, res) => res.json({ presets: listPresets() }));
router.post('/strategies/seniq-presets/:presetId', gate(lightLimiter), (req, res) => {
  const out = instantiatePreset(req.params.presetId, req.body || {});
  if (!out.ok) return res.status(400).json({ error: out.error });
  res.json({ spec: out.spec, preset: out.preset });
});
router.post('/strategies/compare', gate(heavyLimiter), async (req, res) => {
  const out = await compareWithoutSeniq(req.body || {});
  if (out.ok) return res.json(out.data);
  res.status(out.status).json({ error: out.error });
});

// ─── POST /v1/signals — current rule state across ≤5 symbols ─
// Body: {strategy|custom, params?, symbols: [{symbol, exchange?}, …]}
router.post('/signals', gate(heavyLimiter), async (req, res) => {
  const { strategy, custom, params } = req.body || {};
  if (!strategy && !custom) {
    return res.status(400).json({ error: 'provide either strategy (registry name) or custom (Builder spec)' });
  }
  const symbols = cleanSymbols((req.body || {}).symbols);
  if (!symbols.length) {
    return res.status(400).json({ error: `symbols is required — up to ${MAX_WATCH_SYMBOLS} of [{"symbol":"NVDA","exchange":"US"}]` });
  }
  passthrough(res, await callService('/api/signal', {
    method: 'POST',
    body: custom
      ? { custom, symbols, seniq_data: await seniqDataForWatchlist(custom, symbols) }
      : { strategy, params: params || {}, symbols },
  }));
});

// ─── GET /v1/strategies/saved — the user's saved strategies ──
router.get('/strategies/saved', gate(lightLimiter), async (req, res) => {
  const rows = await query(
    'SELECT * FROM user_strategies WHERE user_id = $1 ORDER BY created_at DESC', [req.apiCtx.userId]);
  res.json({
    strategies: rows.map(strategyToJson),
  });
});

// ─── GET /v1/paper — the user's paper deployments ────────────
router.get('/paper', gate(lightLimiter), async (req, res) => {
  const rows = await query(
    'SELECT * FROM paper_deployments WHERE user_id = $1 ORDER BY created_at DESC', [req.apiCtx.userId]);
  res.json({
    deployments: rows.map(deploymentToJson),
  });
});

// ─── GET /v1/paper/:id/state — replay deploy→now (read-only) ─
router.get('/paper/:id/state', gate(heavyLimiter), async (req, res) => {
  const row = await queryOne(
    'SELECT * FROM paper_deployments WHERE id = $1 AND user_id = $2', [req.params.id, req.apiCtx.userId]);
  if (!row) return res.status(404).json({ error: 'deployment not found' });

  // The deployment exists; an engine refusal about its symbol or strategy is a 400, not "not found".
  const out = await replayPaper(row);
  if (out.status === 404) out.status = 400;
  passthrough(res, out);
});

// ─── GET /v1/paper/:id/ledger — recorded fills and daily values (no engine call) ─
router.get('/paper/:id/ledger', gate(lightLimiter), async (req, res) => {
  const row = await queryOne(
    'SELECT * FROM paper_deployments WHERE id = $1 AND user_id = $2', [req.params.id, req.apiCtx.userId]);
  if (!row) return res.status(404).json({ error: 'deployment not found' });
  res.json({ deployment: deploymentToJson(row), ...(await readLedger(row)) });
});

// ─── POST /v1/walk-forward — out-of-sample robustness check ──
// Body: the /v1/backtest body plus n_splits? (2–12, default 4) and scheme? (anchored | rolling).
router.post('/walk-forward', gate(heavyLimiter), async (req, res) => {
  const b = req.body || {};
  if ((!b.strategy && !b.custom) || !b.symbol || !b.start_date || !b.end_date) {
    return res.status(400).json({ error: 'strategy (or custom), symbol, start_date and end_date are required' });
  }
  passthrough(res, await callService('/api/walk-forward', {
    method: 'POST',
    body: {
      strategy: b.strategy || null, custom: b.custom || null, params: b.params || {},
      symbol: b.symbol, exchange: b.exchange || 'US', start_date: b.start_date, end_date: b.end_date,
      n_splits: Number(b.n_splits) || 4, scheme: b.scheme || 'anchored',
      seniq_data: b.custom ? await seniqDataIfNeeded(b.custom, b.symbol) : null,
    },
  }));
});

// ─── Writes — only for keys created with the write permission ──
// Saved strategies and virtual-money deployments only; nothing here deletes.
function requireWrite(req, res, next) {
  if (req.apiCtx.canWrite) return next();
  res.status(403).json({ error: 'This API key is read-only — create a key with write access in Profile → API Access.' });
}
const sendStore = (res, out, okStatus = 200) =>
  (out.ok ? res.status(okStatus).json(out.data) : res.status(out.status).json({ error: out.error }));

router.post('/strategies/saved', gate(lightLimiter), requireWrite, async (req, res) => {
  sendStore(res, await saveStrategy(req.apiCtx.userId, req.body || {}), 201);
});
router.post('/paper', gate(lightLimiter), requireWrite, async (req, res) => {
  sendStore(res, await deployPaper(req.apiCtx.userId, req.body || {}), 201);
});
router.post('/paper/:id/stop', gate(lightLimiter), requireWrite, async (req, res) => {
  sendStore(res, await stopPaper(req.apiCtx.userId, req.params.id));
});

// ─── SenIQ data (same tools as /mcp; see services/dataTools.js) ──
// GET /v1/portfolio · /v1/portfolio/attribution · /v1/events?limit= ·
// /v1/tickers/:ticker/news?days= · /v1/tickers/:ticker/sentiment ·
// /v1/smart-money?ticker= · /v1/news/market?days= · /v1/news/search?query=&ticker=&days=
for (const tool of DATA_TOOLS) {
  router.get(tool.rest.replace(/^\/v1/, ''), gate(lightLimiter), async (req, res) => { // router is mounted at /v1
    const args = {};
    for (const [arg, spec] of Object.entries(tool.args)) {
      const raw = req.params[arg] ?? req.query[arg];
      if (raw == null || raw === '') continue;
      args[arg] = spec.type === 'integer' ? Number(raw) : String(raw);
    }
    const out = await runDataTool(req.apiCtx.userId, tool.name, args);
    if (out.ok) return res.json(out.data);
    res.status(out.status).json({ error: out.error });
  });
}

// Unknown /v1 path → JSON 404 (not the SPA fallback).
router.use((req, res) => {
  res.status(404).json({ error: `no such endpoint — see GET /v1 or /docs` });
});

module.exports = router;
