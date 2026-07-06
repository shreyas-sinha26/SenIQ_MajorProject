/**
 * Public REST API (/v1) — the same read+run surface the MCP server exposes,
 * as plain JSON endpoints for scripts, notebooks, and integrations.
 *
 * Auth: per-user API key ("Authorization: Bearer seniq_…", managed in
 * Profile → API Access), Pro-gated. Rate limits are SHARED with /mcp — one
 * budget per key per hour across both transports (services/apiKeyGate.js):
 * heavy (backtest/signals/paper replay) 30/h, light (everything else) 240/h.
 * Every response carries X-RateLimit-Limit / X-RateLimit-Remaining; 429s add
 * Retry-After (seconds). Docs: /docs.
 */
const express = require('express');
const { query, queryOne } = require('../db');
const { DISCLAIMER, STRATEGY_SERVICE } = require('../config');
const { resolveApiKey, heavyLimiter, lightLimiter } = require('../services/apiKeyGate');
const { callService, flattenDetail, cleanSymbols, iso, MAX_WATCH_SYMBOLS, WARMUP_DAYS } = require('../services/strategyClient');
const { seniqDataIfNeeded, seniqDataForWatchlist } = require('../services/signalHistory');

const router = express.Router();

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
  if (out.status === 400 || out.status === 404 || out.status === 422) {
    return res.status(out.status === 422 ? 400 : out.status)
      .json({ error: flattenDetail(out.data) || 'invalid request' });
  }
  return res.status(503).json({ error: 'Strategy engine is offline — try again later.' });
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
      'POST /v1/backtest',
      'POST /v1/signals',
      'GET  /v1/strategies/saved',
      'GET  /v1/paper',
      'GET  /v1/paper/:id/state',
    ],
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
      initial_cash: String(initial_cash || '100000'),
      seniq_data: seniqData,
    },
  }));
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
    strategies: rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind,
      spec: r.spec, strategy_name: r.strategy_name, params: r.params,
      symbols: r.symbols || [], created_at: r.created_at,
    })),
  });
});

// ─── GET /v1/paper — the user's paper deployments ────────────
router.get('/paper', gate(lightLimiter), async (req, res) => {
  const rows = await query(
    'SELECT * FROM paper_deployments WHERE user_id = $1 ORDER BY created_at DESC', [req.apiCtx.userId]);
  res.json({
    deployments: rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind,
      symbol: r.symbol, exchange: r.exchange,
      initial_cash: String(r.initial_cash),
      deployed_at: iso(r.deployed_at),
      status: r.status,
      stopped_at: r.stopped_at ? iso(r.stopped_at) : null,
    })),
  });
});

// ─── GET /v1/paper/:id/state — replay deploy→now (read-only) ─
router.get('/paper/:id/state', gate(heavyLimiter), async (req, res) => {
  const row = await queryOne(
    'SELECT * FROM paper_deployments WHERE id = $1 AND user_id = $2', [req.params.id, req.apiCtx.userId]);
  if (!row) return res.status(404).json({ error: 'deployment not found' });

  // Replay-from-inception, identical to routes/paper.js: warm indicators on
  // pre-deploy history, only trade from the deploy date.
  const deployed = new Date(row.deployed_at);
  const start = new Date(deployed);
  start.setDate(start.getDate() - WARMUP_DAYS);
  const end = row.status === 'stopped' && row.stopped_at ? new Date(row.stopped_at) : new Date();

  passthrough(res, await callService('/api/backtest', {
    method: 'POST',
    body: {
      ...(row.kind === 'custom'
        ? { custom: row.spec, seniq_data: await seniqDataIfNeeded(row.spec, row.symbol) }
        : { strategy: row.strategy_name, params: row.params || {} }),
      symbol: row.symbol,
      exchange: row.exchange,
      start_date: iso(start),
      end_date: iso(end),
      trade_from: iso(deployed),
      initial_cash: String(row.initial_cash),
    },
  }));
});

// Unknown /v1 path → JSON 404 (not the SPA fallback).
router.use((req, res) => {
  res.status(404).json({ error: `no such endpoint — see GET /v1 or /docs` });
});

module.exports = router;
