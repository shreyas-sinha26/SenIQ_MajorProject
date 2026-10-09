/**
 * Phase 8 — MCP server: the strategy + SenIQ data tool surface for AI agents.
 *
 * Mounted at /mcp (Streamable HTTP, stateless — a fresh McpServer + transport
 * per POST, no session state to leak between users). Auth is a per-user API
 * key (Bearer, managed at /api/keys) and the whole surface is Pro-gated; tier
 * is read from the DB per request, so a downgrade or key revocation takes
 * effect immediately, matching middleware/tier.js semantics.
 *
 * Read + run by default: agents can browse the catalog, validate specs, run
 * backtests / walk-forward checks / signals, inspect saved strategies + paper
 * deployments, and read SenIQ's own data (portfolio, impact feed, news,
 * sentiment, smart money — the Ask agent's tools, see services/dataTools.js).
 *
 * Three WRITE tools — save_strategy, start_paper_deployment,
 * stop_paper_deployment — exist only for keys created with can_write
 * (migration 0018). A read-only key is not shown them at all. They touch
 * saved strategies and virtual-money deployments only; nothing here can
 * delete, and nothing anywhere places a real order.
 */
const { asyncRouter } = require('../middleware/asyncRouter');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { query, queryOne } = require('../db');
const { DISCLAIMER, STRATEGY_SERVICE } = require('../config');
// Auth + rate limits shared with the public REST API (/v1): one budget per key
// across both transports.
const { resolveApiKey, heavyLimiter, lightLimiter } = require('../services/apiKeyGate');
const { callService, flattenDetail, cleanSymbols, replayPaper, MAX_WATCH_SYMBOLS } = require('../services/strategyClient');
const { seniqDataIfNeeded, seniqDataForWatchlist } = require('../services/signalHistory');
const { DATA_TOOLS, runDataTool } = require('../services/dataTools');
const { saveStrategy, deployPaper, stopPaper, strategyToJson, deploymentToJson } = require('../services/strategyStore');
const { readLedger } = require('../services/paperLedger');
const { listPresets, instantiatePreset, compareWithoutSeniq } = require('../services/strategySignals');

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
        'SenIQ tools. Data: the user\'s portfolio and its impact-ranked news feed, plus news, ' +
        'sentiment and smart-money (congress + 13F) data for any ticker they hold or that SenIQ ' +
        'tracks — smart-money disclosures lag by weeks, so always state their dates. ' +
        'Strategies: browse the catalog, validate Builder specs, run backtests, ' +
        'evaluate live signals, and inspect the user\'s saved strategies and paper deployments. ' +
        (ctx.canWrite
          ? 'This key may also save strategies and start/stop PAPER deployments (virtual money, no real orders) — do so only when the user asks. '
          : 'Read + run only — no tool mutates state. ') +
        'Custom specs may use SenIQ signal factors ' +
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

  server.registerTool('list_seniq_presets', {
    description: 'Ready-made strategy templates that combine price rules with SenIQ signals (news sentiment, congress disclosures, tracked funds\' 13F filings). Each has a data_depth note saying how much history its signal really has. Templates to backtest, not recommendations.',
  }, async () => rateLimited(lightLimiter, ctx.keyId) || ok({ presets: listPresets() }));

  server.registerTool('get_seniq_preset', {
    description: 'The Builder spec for one SenIQ preset, with its inputs filled in (e.g. politician for follow-a-politician). Pass the result as `custom` to run_backtest or compare_without_seniq. Saves nothing.',
    inputSchema: {
      id: z.string().describe('Preset id from list_seniq_presets'),
      inputs: z.record(z.string(), z.string()).optional().describe('Preset inputs, e.g. {"politician": "Jane Doe"}'),
    },
  }, async ({ id, inputs }) => {
    const limited = rateLimited(lightLimiter, ctx.keyId);
    if (limited) return limited;
    const out = instantiatePreset(id, inputs || {});
    return out.ok ? ok({ spec: out.spec, preset: out.preset }) : fail(out.error);
  });

  server.registerTool('compare_without_seniq', {
    description: 'Did the SenIQ signal help? Backtests one Builder spec twice on the same symbol and dates — as written, and with every SenIQ condition removed — and returns both results, the difference, buy-and-hold, and how much of the period the SenIQ signals actually had data for. Read the notes: low coverage or few trades make the difference meaningless. Costs 2 backtests.',
    inputSchema: {
      custom: z.record(z.string(), z.any()).describe('Builder spec that uses at least one SenIQ factor and keeps at least one price-based entry and exit.'),
      symbol: backtestArgs.symbol, exchange: backtestArgs.exchange,
      start_date: backtestArgs.start_date, end_date: backtestArgs.end_date, initial_cash: backtestArgs.initial_cash,
    },
  }, async (args) => {
    const limited = rateLimited(heavyLimiter, ctx.keyId);
    if (limited) return limited;
    const out = await compareWithoutSeniq(args);
    return out.ok ? ok(out.data) : fail(out.error);
  });

  server.registerTool('run_walk_forward', {
    description: 'Out-of-sample robustness check for one strategy on one symbol: the date range is cut into folds, and the same fixed rules are run on each in-sample window and on the unseen window after it. Returns per-fold metrics and a verdict (robust / moderate / fragile / insufficient_data). Use after run_backtest to see whether a good result survives on data it was not judged on. Costs 2 × n_splits backtests — rate-limited.',
    inputSchema: {
      ...backtestArgs,
      n_splits: z.number().int().min(2).max(12).optional().describe('Number of folds (default 4)'),
      scheme: z.enum(['anchored', 'rolling']).optional().describe('anchored = in-sample grows from the start (default); rolling = fixed-size in-sample'),
    },
  }, async (args) => {
    const limited = rateLimited(heavyLimiter, ctx.keyId);
    if (limited) return limited;
    if ((!args.strategy && !args.custom) || !args.symbol || !args.start_date || !args.end_date) {
      return fail('strategy (or custom), symbol, start_date and end_date are required');
    }
    return serviceResult(await callService('/api/walk-forward', {
      method: 'POST',
      body: {
        strategy: args.strategy || null, custom: args.custom || null, params: args.params || {},
        symbol: args.symbol, exchange: args.exchange || 'US',
        start_date: args.start_date, end_date: args.end_date,
        n_splits: args.n_splits || 4, scheme: args.scheme || 'anchored',
        seniq_data: args.custom ? await seniqDataIfNeeded(args.custom, args.symbol) : null,
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
      strategies: rows.map(strategyToJson),
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
      deployments: rows.map(deploymentToJson),
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

    return serviceResult(await replayPaper(row));
  });

  server.registerTool('get_paper_ledger', {
    description: 'The stored record of a paper deployment: every simulated fill (date, side, quantity, price) and its value at the close of each completed day, as a daily job recorded them. Use for "what did it trade and when" and for the equity history; use get_paper_state for the live position. Simulated, virtual money.',
    inputSchema: { deployment_id: z.number().int().describe('id from list_paper_deployments') },
  }, async ({ deployment_id }) => {
    const limited = rateLimited(lightLimiter, ctx.keyId);
    if (limited) return limited;
    const row = await queryOne(
      'SELECT * FROM paper_deployments WHERE id = $1 AND user_id = $2', [deployment_id, ctx.userId]);
    if (!row) return fail('deployment not found');
    return ok({ deployment: deploymentToJson(row), ...(await readLedger(row)) });
  });

  // ── SenIQ data tools (shared catalog with /v1) ──
  for (const tool of DATA_TOOLS) {
    const inputSchema = {};
    for (const [arg, spec] of Object.entries(tool.args)) {
      const base = (spec.type === 'integer' ? z.number().int() : z.string()).describe(spec.description);
      inputSchema[arg] = spec.required ? base : base.optional();
    }
    server.registerTool(tool.name, { description: tool.description, inputSchema }, async (args) => {
      const limited = rateLimited(lightLimiter, ctx.keyId);
      if (limited) return limited;
      const out = await runDataTool(ctx.userId, tool.name, args || {});
      return out.ok ? ok(out.data) : fail(out.error);
    });
  }

  // ── Write tools — only for keys created with the write permission ──
  if (ctx.canWrite) {
    const storeResult = (out) => (out.ok ? ok(out.data) : fail(out.error));

    server.registerTool('save_strategy', {
      description: 'Save a strategy to the user\'s account (max 20). Provide custom (a Builder spec — validate it first) or strategy (a registry name) with params. Optionally attach a watchlist of up to 5 symbols for live signals. Only call when the user asks to save.',
      inputSchema: {
        name: z.string().describe('Unique name for the saved strategy'),
        custom: z.record(z.string(), z.any()).optional().describe('Builder spec. Provide this OR strategy.'),
        strategy: z.string().optional().describe('Registry strategy name from list_strategies.'),
        params: z.record(z.string(), z.any()).optional(),
        symbols: z.array(z.object({ symbol: z.string(), exchange: z.string().optional() })).max(MAX_WATCH_SYMBOLS).optional(),
      },
    }, async (args) => {
      const limited = rateLimited(lightLimiter, ctx.keyId);
      if (limited) return limited;
      return storeResult(await saveStrategy(ctx.userId, args));
    });

    server.registerTool('start_paper_deployment', {
      description: 'Deploy one of the user\'s SAVED strategies on one symbol with virtual money (max 10 active). No real orders are placed — the deployment is replayed from today on each get_paper_state. Only call when the user asks to deploy.',
      inputSchema: {
        strategy_id: z.number().int().describe('id from list_saved_strategies or save_strategy'),
        symbol: z.string(),
        exchange: z.string().optional().describe('US | NSE | BSE | CRYPTO | COMMODITY (default US)'),
        initial_cash: z.number().optional().describe('Virtual starting cash (default 100000)'),
      },
    }, async (args) => {
      const limited = rateLimited(lightLimiter, ctx.keyId);
      if (limited) return limited;
      return storeResult(await deployPaper(ctx.userId, args));
    });

    server.registerTool('stop_paper_deployment', {
      description: 'Stop an active paper deployment. Its record and trade history are kept, frozen at today. Only call when the user asks to stop it.',
      inputSchema: { deployment_id: z.number().int().describe('id from list_paper_deployments') },
    }, async (args) => {
      const limited = rateLimited(lightLimiter, ctx.keyId);
      if (limited) return limited;
      return storeResult(await stopPaper(ctx.userId, args.deployment_id));
    });
  }

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
const router = asyncRouter();

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
