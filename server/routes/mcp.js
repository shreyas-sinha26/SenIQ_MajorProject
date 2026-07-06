/**
 * Phase 8 — MCP server: the strategy tool surface for AI agents.
 *
 * Mounted at /mcp (Streamable HTTP, stateless — a fresh McpServer + transport
 * per POST, no session state to leak between users). Auth is a per-user API
 * key (Bearer, managed at /api/keys) and the whole surface is Pro-gated; tier
 * is read from the DB per request, so a downgrade or key revocation takes
 * effect immediately, matching middleware/tier.js semantics.
 *
 * Read + run only by design: agents can browse the catalog, validate specs,
 * run backtests/signals, and inspect saved strategies + paper deployments —
 * but nothing here mutates state. Write tools (deploy/pause/save) are a later,
 * separately-guarded decision.
 */
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { query, queryOne } = require('../db');
const { DISCLAIMER, STRATEGY_SERVICE } = require('../config');
// Auth + rate limits shared with the public REST API (/v1): one budget per key
// across both transports.
const { resolveApiKey, heavyLimiter, lightLimiter } = require('../services/apiKeyGate');
const { callService, flattenDetail, cleanSymbols, iso, MAX_WATCH_SYMBOLS, WARMUP_DAYS } = require('../services/strategyClient');
const { seniqDataIfNeeded, seniqDataForWatchlist } = require('../services/signalHistory');

// Normalize a service reply into an MCP tool result. 422 = pydantic field
// errors (array detail) → flattened; transport failure → friendly offline text.
function serviceResult(out) {
  if (out.status === 200) return ok(out.data);
  if (out.status === 400 || out.status === 404 || out.status === 422) {
    return fail(flattenDetail(out.data) || 'invalid request');
  }
  return fail('Strategy engine is offline — try again later.');
}

// ─── Tool result helpers ─────────────────────────────────────
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] });

function rateLimited(limiter, keyId) {
  const verdict = limiter.allow(keyId);
  if (verdict.allowed) return null;
  const mins = Math.ceil(verdict.retryAfterMs / 60000);
  return fail(`rate limit exceeded — try again in ~${mins} min`);
}

// ─── Tool registration ───────────────────────────────────────
// ctx = { userId, keyId } for the authenticated request. A fresh server is
// built per request (stateless transport), so handlers close over ctx safely.
const backtestArgs = {
  strategy: z.string().optional().describe('Registry strategy name from list_strategies (e.g. "EMACrossover"). Provide this OR custom.'),
  custom: z.record(z.string(), z.any()).optional().describe('Builder spec (factors + entry/exit rules) — validate with validate_strategy first.'),
  params: z.record(z.string(), z.any()).optional().describe('Registry strategy params (see param schema in list_strategies).'),
  symbol: z.string().describe('Ticker, e.g. AAPL / RELIANCE / BTC'),
  exchange: z.string().optional().describe('US | NASDAQ | NYSE | NSE | BSE | CRYPTO | COMMODITY (default US)'),
  start_date: z.string().describe('YYYY-MM-DD'),
  end_date: z.string().describe('YYYY-MM-DD'),
  initial_cash: z.union([z.string(), z.number()]).optional().describe('Starting cash (default 100000)'),
};

function buildMcpServer(ctx) {
  const server = new McpServer(
    { name: 'seniq-strategy-tools', version: '1.0.0' },
    {
      instructions:
        'SenIQ strategy tools: browse the strategy catalog, validate Builder specs, run backtests, ' +
        'evaluate live signals, and inspect the user\'s saved strategies and paper deployments. ' +
        'Read + run only — no tool mutates state. Custom specs may use SenIQ signal factors ' +
        '(source:"seniq"); their history only reaches back as far as SenIQ has been recording, ' +
        'so check seniq_coverage in backtest responses. ' + DISCLAIMER,
    },
  );

  server.registerTool('list_strategies', {
    description: 'Strategy catalog: built-in strategies with param schemas, plus the Builder vocabulary (indicators, seniq metrics, operators, risk, sizing) a custom spec may use.',
  }, async () => {
    return rateLimited(lightLimiter, ctx.keyId)
      || serviceResult(await callService('/api/strategies', { timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS }));
  });

  server.registerTool('validate_strategy', {
    description: 'Check a Builder spec without running it. Returns {valid, errors, normalized}.',
    inputSchema: { spec: z.record(z.string(), z.any()).describe('The Builder spec to validate') },
  }, async ({ spec }) => {
    return rateLimited(lightLimiter, ctx.keyId)
      || serviceResult(await callService('/api/strategies/validate', {
        method: 'POST', body: spec, timeoutMs: STRATEGY_SERVICE.CATALOG_TIMEOUT_MS,
      }));
  });

  server.registerTool('run_backtest', {
    description: 'Backtest one strategy on one symbol. Returns metrics, trades, equity curve, and seniq_coverage when SenIQ factors are used. Rate-limited — batch thoughtfully.',
    inputSchema: backtestArgs,
  }, async (args) => {
    const limited = rateLimited(heavyLimiter, ctx.keyId);
    if (limited) return limited;
    if ((!args.strategy && !args.custom) || !args.symbol || !args.start_date || !args.end_date) {
      return fail('strategy (or custom), symbol, start_date and end_date are required');
    }
    const seniqData = args.custom ? await seniqDataIfNeeded(args.custom, args.symbol) : null;
    return serviceResult(await callService('/api/backtest', {
      method: 'POST',
      body: {
        strategy: args.strategy || null,
        custom: args.custom || null,
        params: args.params || {},
        symbol: args.symbol,
        exchange: args.exchange || 'US',
        start_date: args.start_date,
        end_date: args.end_date,
        initial_cash: String(args.initial_cash || '100000'),
        seniq_data: seniqData,
      },
    }));
  });

  server.registerTool('get_signals', {
    description: 'Current rule state (long/flat, last signal, fired-on-latest-bar) of a strategy across up to 5 symbols.',
    inputSchema: {
      strategy: z.string().optional().describe('Registry strategy name. Provide this OR custom.'),
      custom: z.record(z.string(), z.any()).optional().describe('Builder spec.'),
      params: z.record(z.string(), z.any()).optional(),
      symbols: z.array(z.object({
        symbol: z.string(),
        exchange: z.string().optional(),
      })).min(1).max(MAX_WATCH_SYMBOLS).describe('e.g. [{"symbol":"NVDA","exchange":"US"}]'),
    },
  }, async (args) => {
    const limited = rateLimited(heavyLimiter, ctx.keyId);
    if (limited) return limited;
    if (!args.strategy && !args.custom) return fail('provide either strategy (registry name) or custom (Builder spec)');
    const symbols = cleanSymbols(args.symbols);
    if (!symbols.length) return fail('no valid symbols provided');
    return serviceResult(await callService('/api/signal', {
      method: 'POST',
      body: args.custom
        ? { custom: args.custom, symbols, seniq_data: await seniqDataForWatchlist(args.custom, symbols) }
        : { strategy: args.strategy, params: args.params || {}, symbols },
    }));
  });

  server.registerTool('list_saved_strategies', {
    description: "The user's saved strategies (Builder specs and configured presets) with their watchlists.",
  }, async () => {
    const limited = rateLimited(lightLimiter, ctx.keyId);
    if (limited) return limited;
    const rows = await query(
      'SELECT * FROM user_strategies WHERE user_id = $1 ORDER BY created_at DESC', [ctx.userId]);
    return ok({
      strategies: rows.map((r) => ({
        id: r.id, name: r.name, kind: r.kind,
        spec: r.spec, strategy_name: r.strategy_name, params: r.params,
        symbols: r.symbols || [], created_at: r.created_at,
      })),
    });
  });

  server.registerTool('list_paper_deployments', {
    description: "The user's paper-trading deployments (strategy, symbol, cash, deploy date, active/stopped). Use get_paper_state for current equity and trades.",
  }, async () => {
    const limited = rateLimited(lightLimiter, ctx.keyId);
    if (limited) return limited;
    const rows = await query(
      'SELECT * FROM paper_deployments WHERE user_id = $1 ORDER BY created_at DESC', [ctx.userId]);
    return ok({
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

  server.registerTool('get_paper_state', {
    description: 'Replay a paper deployment from its deploy date to now (or to when it was stopped): current equity, open position, trade log, metrics.',
    inputSchema: { deployment_id: z.number().int().describe('id from list_paper_deployments') },
  }, async ({ deployment_id }) => {
    const limited = rateLimited(heavyLimiter, ctx.keyId);
    if (limited) return limited;
    const row = await queryOne(
      'SELECT * FROM paper_deployments WHERE id = $1 AND user_id = $2', [deployment_id, ctx.userId]);
    if (!row) return fail('deployment not found');

    // Replay-from-inception, identical to routes/paper.js: warm indicators on
    // pre-deploy history, only trade from the deploy date.
    const deployed = new Date(row.deployed_at);
    const start = new Date(deployed);
    start.setDate(start.getDate() - WARMUP_DAYS);
    const end = row.status === 'stopped' && row.stopped_at ? new Date(row.stopped_at) : new Date();

    const out = await callService('/api/backtest', {
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
    });
    return serviceResult(out);
  });

  return server;
}

// ─── Key auth (Bearer) ───────────────────────────────────────
// JSON-RPC-shaped errors so MCP clients surface a readable message.
function rpcError(res, httpStatus, message) {
  return res.status(httpStatus).json({
    jsonrpc: '2.0',
    error: { code: -32001, message },
    id: null,
  });
}

async function authApiKey(req, res, next) {
  const verdict = await resolveApiKey(req.headers.authorization);
  if (!verdict.ok) return rpcError(res, verdict.status, verdict.message);
  req.mcpCtx = verdict.ctx;
  next();
}

// ─── Transport wiring (stateless Streamable HTTP) ────────────
const router = express.Router();

router.post('/', authApiKey, async (req, res, next) => {
  try {
    const server = buildMcpServer(req.mcpCtx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session ids, nothing shared across requests
      enableJsonResponse: true,      // plain JSON replies (no SSE stream needed for this surface)
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    next(err);
  }
});

// Stateless server: no SSE stream to resume, no session to delete.
router.get('/', (req, res) => rpcError(res, 405, 'Method not allowed — this MCP server is stateless; POST only.'));
router.delete('/', (req, res) => rpcError(res, 405, 'Method not allowed — this MCP server is stateless; POST only.'));

module.exports = router;
