/**
 * Ask's strategy tools (v2 only) — read-only questions about the user's own strategies:
 * what they have, what is running, how paper deployments have done, why a strategy is
 * flagging a symbol, and which presets exist.
 *
 * Loaded into the agent only when FEATURES.STRATEGIES is on, so v1 questions never pay for
 * the extra tool definitions.
 *
 * NOTHING HERE WRITES OR STARTS ANYTHING. Ask cannot save, backtest or deploy a strategy.
 * draft_strategy only VALIDATES a spec the agent wrote and hands it back as a draft; the
 * user reviews it in the Builder and decides what to do with it.
 * The only engine calls are the same read replays the Paper Trade page makes (bounded and
 * cached) and the live signal check. Performance is always labelled as paper (simulated).
 *
 * Tier rules mirror the web routes: saved strategies need Plus, paper trading needs Pro.
 * Every query is scoped by user_id.
 */

const { QA, TIERS } = require('../config');
const { ScopeError, EXECUTORS: DATA_EXECUTORS } = require('./qaTools');
const { callService, WARMUP_DAYS, MAX_WATCH_SYMBOLS, iso } = require('./strategyClient');
const { seniqDataIfNeeded, seniqDataForWatchlist } = require('./signalHistory');
const { listPresets: listSeniqPresets } = require('./strategySignals');
const { validateSpec, dataDepthNotes, INDICATORS, SENIQ_METRICS } = require('./strategySpec');

const clip = (text, n) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const num = (x, d = 2) => {
  const n = Number(x);
  return x == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
};
const day = (t) => (t ? iso(t) : null);
// The engine's *_pct fields are FRACTIONS despite the name (total_return_pct = final/initial − 1,
// so 0.0425 means 4.25%). Everything Ask quotes is converted to percent here, once.
const pct = (x) => {
  const n = Number(x);
  return x == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 100;
};

// ── Pure helpers ──

const OPS = {
  crossover: 'crosses above', crossunder: 'crosses below',
  gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', ne: '!=',
};

/** A Builder rule tree → one readable line ("ema_f crosses above ema_s and rsi14 < 70"). Pure. */
function describeRule(node, depth = 0) {
  if (node == null || typeof node !== 'object' || depth > 6) return '';
  const [op] = Object.keys(node);
  const arg = node[op];
  if (op === 'all' || op === 'any') {
    const parts = (Array.isArray(arg) ? arg : []).map((c) => describeRule(c, depth + 1)).filter(Boolean);
    const joined = parts.join(op === 'all' ? ' and ' : ' or ');
    return depth > 0 && parts.length > 1 ? `(${joined})` : joined;
  }
  if (op === 'stop_loss_pct') return `stop loss ${arg}%`;
  if (op === 'take_profit_pct') return `take profit ${arg}%`;
  if (Array.isArray(arg) && arg.length === 2) return `${arg[0]} ${OPS[op] || op} ${arg[1]}`;
  return `${op} ${JSON.stringify(arg)}`;
}

/** Factor definitions → "ema_f = ema(period 12); s = SenIQ sentiment_zscore". Pure. */
function describeFactors(factors) {
  return (Array.isArray(factors) ? factors : []).map((f) => {
    const params = Object.entries(f.params || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    const what = f.source === 'seniq' ? `SenIQ ${f.metric}` : String(f.fn || 'indicator');
    return `${f.id} = ${what}${params ? `(${params})` : ''}`;
  }).join('; ');
}

/** The SenIQ metrics a saved strategy uses, e.g. ['sentiment_zscore', 'congress_net_buys']. Pure. */
function seniqMetricsOf(row) {
  if (row.kind !== 'custom' || !row.spec) return [];
  return [...new Set((row.spec.factors || []).filter((f) => f && f.source === 'seniq').map((f) => String(f.metric)))];
}

/** A saved strategy's rules in plain words. Pure. */
function describeStrategy(row, maxChars = 500) {
  if (row.kind === 'registry') {
    const params = Object.entries(row.params || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    return clip(`Preset ${row.strategy_name}${params ? ` (${params})` : ''}`, maxChars);
  }
  const s = row.spec || {};
  const parts = [
    describeFactors(s.factors) && `Factors: ${describeFactors(s.factors)}`,
    describeRule(s.entry) && `Enter when ${describeRule(s.entry)}`,
    describeRule(s.exit) && `Exit when ${describeRule(s.exit)}`,
  ].filter(Boolean);
  return clip(parts.join('. '), maxChars);
}

/** Engine request for a paper replay — same construction as routes/paper.js. Pure apart from `now`. */
function replayWindow(row, now = new Date()) {
  const deployed = new Date(row.deployed_at);
  const start = new Date(deployed);
  start.setDate(start.getDate() - WARMUP_DAYS);
  const end = row.status === 'stopped' && row.stopped_at ? new Date(row.stopped_at) : now;
  return { start, end, deployed };
}

/** One engine backtest response → the handful of figures Ask may quote. Pure. */
function summarizeReplay(row, data, now = new Date()) {
  const { end, deployed } = replayWindow(row, now);
  const report = (data && data.report) || {};
  const m = report.metrics || {};
  const b = report.benchmark || {};
  return {
    id: row.id, name: row.name, symbol: row.symbol, exchange: row.exchange, status: row.status,
    from: day(deployed), to: day(end),
    days: Math.max(0, Math.round((end - deployed) / 86_400_000)),
    return_pct: pct(m.total_return_pct),
    buy_hold_return_pct: pct(b.benchmark_total_return_pct),
    max_drawdown_pct: pct(m.max_drawdown_pct),
    trades: Array.isArray(report.trades) ? report.trades.length : null,
    initial_cash: num(row.initial_cash, 0),
    final_equity: num(m.final_equity, 0),
    in_position: Array.isArray(data && data.open_positions) ? data.open_positions.length > 0 : null,
  };
}

/** Best return first; rows with no return (engine error) last. Pure. */
function rankPerformance(rows) {
  return rows.slice().sort((a, b) => (b.return_pct ?? -Infinity) - (a.return_pct ?? -Infinity));
}

/** Engine catalog → compact preset cards. Pure. */
function presetCards(catalog) {
  return ((catalog && catalog.strategies) || []).map((e) => ({
    name: e.name,
    label: e.label || e.name,
    description: clip(e.description, 180),
    style: e.style || e.category || null,
    params: (e.params || []).map((p) => `${p.name}=${p.default}`).join(', '),
  }));
}

// ── Tool definitions (appended to Ask's tools in v2 mode — keep order stable for caching) ──
const STRATEGY_TOOLS = [
  {
    name: 'list_my_strategies',
    description: 'The user\'s saved strategies (name, rules in plain words, watchlist, whether they use SenIQ signals) and their paper deployments (symbol, deploy date, active or stopped). "Running" means an ACTIVE paper deployment. Use for "what strategies do I have", "how many are running".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_paper_performance',
    description: 'Return of each of the user\'s paper deployments since its deploy date, best first, with buy-and-hold over the same days, drawdown and trade count. These are SIMULATED paper results, each over its own period — always say so and give the dates. Use for "which strategy did best", "how is my strategy doing". Saved strategies that were never deployed have no return.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'explain_strategy_signal',
    description: 'Why one saved strategy is long or flat on its symbols right now: its rules, the current state and last signal per symbol, and — for SenIQ-signal strategies on held symbols — the stories or congress disclosures currently behind those signals. Get the id from list_my_strategies.',
    input_schema: {
      type: 'object',
      properties: {
        strategy_id: { type: 'integer', description: 'id from list_my_strategies.' },
        symbol: { type: 'string', description: 'Optional: one symbol from the strategy\'s watchlist or the user\'s holdings. Default: the whole watchlist.' },
      },
      required: ['strategy_id'],
    },
  },
  {
    name: 'list_strategy_presets',
    description: 'The ready-made strategy templates in SenIQ\'s library (name, what the rule does, default parameters), the templates built on SenIQ signals (with how much history each signal has), and the SenIQ signals a custom strategy can use. Use when the user asks what kind of strategy might suit them. You may point to templates worth TESTING; you cannot run, save or deploy one.',
    input_schema: { type: 'object', properties: {} },
  },
];

// The spec grammar the agent needs to write a draft. Kept in the tool description (not the
// system prompt) so only v2 conversations carry it.
const DRAFT_GRAMMAR = [
  'spec = { name, factors: [...], entry: RULE, exit: RULE, sizing? }.',
  `Technical factor: {"id":"ema_fast","fn":"ema","params":{"period":20}}. fn is one of ${Object.entries(INDICATORS).map(([fn, ps]) => `${fn}(${ps.join(',')})`).join(', ')}; parameters are whole numbers 1-500.`,
  `SenIQ factor: {"id":"sz","source":"seniq","metric":"sentiment_zscore"}. metric is one of ${[...SENIQ_METRICS].join(', ')}. congress_* metrics take params.window_days (1-365) and optional params.politician (a full name).`,
  'Built-in ids needing no factor: close, price, volume.',
  'RULE is {"all":[RULE,...]}, {"any":[RULE,...]}, or one condition {"gt"|"lt"|"gte"|"lte"|"crossover"|"crossunder": [left, right]} where left/right are factor ids, built-ins or numbers (a cross needs a factor on the left).',
  'Inside exit only: {"stop_loss_pct": 8} and {"take_profit_pct": 20}. Every strategy needs an entry rule and an exit rule or stop.',
  'sizing: {"type":"percent_equity","value":25} (default) or {"type":"fixed_cash","value":5000}.',
  'Long-only; rules fire on the bar where they become true.',
  'Prefer entry as ONE all-list and exit as ONE any-list of plain conditions: that is the shape the Strategy Builder page can display. Use nested groups only if the user\'s rules need them.',
].join(' ');

const DRAFT_TOOL = {
  name: 'draft_strategy',
  description: `Turn rules the user described in words into a strategy DRAFT for the Strategy Builder. You write the spec; this tool checks it and returns either the errors to fix or the accepted draft with its rules in plain words. It does not save, backtest or deploy anything. Use only when the user has described actual rules (what to buy on, what to sell on); if they have not, ask. Do not add rules they did not ask for; if you had to choose a number they left open (a period, a stop), say so in your answer. ${DRAFT_GRAMMAR}`,
  input_schema: {
    type: 'object',
    properties: {
      spec: { type: 'object', description: 'The Builder spec, following the grammar above.' },
      assumptions: { type: 'array', items: { type: 'string' }, description: 'Each choice you made that the user did not specify, e.g. "used a 50-day average for \"long-term trend\"".' },
    },
    required: ['spec'],
  },
};

// ── Executors ──
const rank = (tier) => (TIERS[tier] && TIERS[tier].rank) ?? 0;
function requireTier(ctx, min, what) {
  if (rank(ctx.tier) < rank(min)) throw new ScopeError(`plan_required: ${what} is part of the ${TIERS[min].label} plan, which this account does not have. Say so; do not guess the data.`);
}

const engine = (ctx) => ctx.callService || callService;
const ENGINE_OFFLINE = 'engine_offline: the strategy engine is not reachable right now, so this cannot be checked. Say so plainly.';

// Replays are deterministic for a given deployment and end date, so a short cache makes
// "which did best?" followed by "and the worst?" one set of engine runs, not two.
const replayCache = new Map();
function cached(key, ttlMs) {
  const hit = replayCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  return undefined;
}
function remember(key, value) {
  if (replayCache.size > 500) replayCache.clear();
  replayCache.set(key, { at: Date.now(), value });
}

async function replay(row, ctx) {
  const { start, end, deployed } = replayWindow(row);
  const key = `${row.id}:${row.status}:${iso(end)}`;
  const hit = cached(key, QA.STRATEGY_CACHE_MS);
  if (hit) return hit;
  const out = await engine(ctx)('/api/backtest', {
    method: 'POST',
    timeoutMs: QA.STRATEGY_ENGINE_TIMEOUT_MS,
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
  if (out.status !== 200) return { status: out.status };
  const value = { status: 200, summary: summarizeReplay(row, out.data) };
  remember(key, value);
  return value;
}

// Run `fn` over `items`, at most `limit` at a time (the engine is one local process).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const STRATEGY_EXECUTORS = {
  async list_my_strategies(_args, ctx) {
    requireTier(ctx, 'plus', 'Saved strategies');
    const { query } = require('../db');
    const strategies = await query(
      'SELECT id, name, kind, spec, strategy_name, params, symbols FROM user_strategies WHERE user_id = $1 ORDER BY created_at DESC', [ctx.userId]);
    const canPaper = rank(ctx.tier) >= rank('pro');
    const deployments = canPaper
      ? await query(
        `SELECT id, name, symbol, exchange, deployed_at, status, stopped_at FROM paper_deployments
          WHERE user_id = $1 ORDER BY (status = 'active') DESC, created_at DESC LIMIT $2`,
        [ctx.userId, QA.STRATEGY_LIST_DEPLOYMENTS])
      : [];
    // Rules are spelled out only for a short list; a long one would overflow the tool result.
    const withRules = strategies.length <= QA.STRATEGY_RULES_INLINE;
    return {
      saved_count: strategies.length,
      running_count: deployments.filter((d) => d.status === 'active').length,
      running_means: 'an active paper deployment (simulated, virtual money)',
      strategies: strategies.map((r) => ({
        id: r.id, name: clip(r.name, 32), kind: r.kind === 'registry' ? 'preset' : 'custom',
        ...(withRules ? { rules: describeStrategy(r, 160) } : {}),
        watchlist: (r.symbols || []).map((s) => s.symbol),
        ...(seniqMetricsOf(r).length ? { seniq_signals: seniqMetricsOf(r) } : {}),
      })),
      ...(withRules ? {} : { rules_note: 'Rules omitted for length — call explain_strategy_signal with an id to see one.' }),
      deployments: deployments.map((d) => ({ id: d.id, strategy: clip(d.name, 32), symbol: d.symbol, deployed: day(d.deployed_at), status: d.status, stopped: day(d.stopped_at) })),
      ...(canPaper ? {} : { deployments_note: 'Paper trading is a Pro feature, so deployments are not shown for this account.' }),
    };
  },

  async get_paper_performance(_args, ctx) {
    requireTier(ctx, 'pro', 'Paper trading');
    const { query } = require('../db');
    const rows = await query(
      `SELECT * FROM paper_deployments WHERE user_id = $1
        ORDER BY (status = 'active') DESC, created_at DESC LIMIT $2`,
      [ctx.userId, QA.STRATEGY_COMPARE_MAX]);
    if (!rows.length) return { deployments: [], note: 'No paper deployments yet, so there is no performance to compare.' };

    const results = await mapLimit(rows, QA.STRATEGY_ENGINE_CONCURRENCY, (r) => replay(r, ctx).catch(() => ({ status: 500 })));
    if (results.every((r) => r.status === 503)) throw new ScopeError(ENGINE_OFFLINE);
    const ok = results.filter((r) => r.status === 200).map((r) => r.summary);
    const failed = rows.filter((_, i) => results[i].status !== 200).map((r) => ({ id: r.id, name: r.name, symbol: r.symbol }));
    return {
      basis: 'Paper trading: simulated fills on virtual money, from each deploy date to today (or to its stop date). Not a backtest, not a forecast. Each row covers a different period, so the returns are not like-for-like.',
      deployments: rankPerformance(ok),
      ...(failed.length ? { could_not_compute: failed } : {}),
    };
  },

  async explain_strategy_signal({ strategy_id, symbol } = {}, ctx) {
    requireTier(ctx, 'plus', 'Saved strategies');
    const id = Number(strategy_id);
    if (!Number.isInteger(id) || id <= 0) throw new ScopeError('strategy_id is required (from list_my_strategies)');
    const { queryOne } = require('../db');
    const row = await queryOne('SELECT * FROM user_strategies WHERE id = $1 AND user_id = $2', [id, ctx.userId]);
    if (!row) throw new ScopeError(`strategy_not_found: no saved strategy ${id} on this account. Use an id from list_my_strategies.`);

    const watch = (row.symbols || []).slice(0, MAX_WATCH_SYMBOLS);
    let symbols = watch;
    if (symbol != null && String(symbol).trim()) {
      const s = String(symbol).trim().toUpperCase().replace(/^\$/, '');
      const onList = watch.find((w) => w.symbol === s);
      if (!onList && !ctx.heldSet.has(s)) throw new ScopeError(`symbol_not_allowed: ${s} is not on this strategy's watchlist or in the portfolio.`);
      symbols = [onList || { symbol: s, exchange: 'US' }];
    }
    if (!symbols.length) throw new ScopeError('no_symbols: this strategy has no watchlist. Ask the user which symbol to check, or to add a watchlist.');

    const out = await engine(ctx)('/api/signal', {
      method: 'POST',
      timeoutMs: QA.STRATEGY_ENGINE_TIMEOUT_MS,
      body: row.kind === 'custom'
        ? { custom: row.spec, symbols, seniq_data: await seniqDataForWatchlist(row.spec, symbols) }
        : { strategy: row.strategy_name, params: row.params || {}, symbols },
    });
    if (out.status === 503) throw new ScopeError(ENGINE_OFFLINE);
    if (out.status !== 200) throw new ScopeError(`signal_unavailable: ${clip(out.data && out.data.detail, 160) || 'the engine rejected this strategy'}`);

    // SenIQ evidence: the CURRENT stories / disclosures behind each SenIQ factor, for held
    // symbols only (Ask's holdings wall) and only the first few, to stay inside the result clamp.
    const metrics = seniqMetricsOf(row);
    const evidence = [];
    if (metrics.length) {
      const held = symbols.map((s) => s.symbol).filter((s) => ctx.heldSet.has(s)).slice(0, QA.STRATEGY_EVIDENCE_SYMBOLS);
      for (const t of held) {
        const e = { symbol: t };
        if (metrics.some((m) => m.startsWith('sentiment'))) {
          const x = await DATA_EXECUTORS.explain_sentiment({ ticker: t, limit: 2 }, ctx);
          e.sentiment = {
            acute: x.acute.score, z: x.baseline.z, contribution_unit: x.contribution_unit,
            drivers: x.drivers.map((d) => ({ title: clip(d.title, 110), source: d.source, date: d.date, contribution: d.contribution })),
          };
        }
        if (metrics.some((m) => m.startsWith('congress'))) {
          const sm = await DATA_EXECUTORS.get_smart_money({ ticker: t }, ctx);
          e.congress = sm.congress.slice(0, 4).map((c) => ({ politician: c.politician, action: c.action, traded: c.traded, disclosed: c.disclosed }));
        }
        evidence.push(e);
      }
    }
    const notHeld = symbols.map((s) => s.symbol).filter((s) => !ctx.heldSet.has(s));

    return {
      strategy: { id: row.id, name: row.name, kind: row.kind === 'registry' ? 'preset' : 'custom', rules: describeStrategy(row) },
      signals: ((out.data && out.data.signals) || []).map((s) => ({
        symbol: s.symbol, state: s.state ?? null, as_of: s.as_of ?? null, last_close: num(s.last_close),
        fired_on_latest_bar: s.fired_on_latest_bar ?? null,
        last_signal: s.last_signal ? { side: s.last_signal.side, date: s.last_signal.date, reason: clip(s.last_signal.reason, 140) } : null,
        ...(s.error ? { error: clip(s.error, 100) } : {}),
      })),
      seniq_signals: metrics,
      ...(evidence.length ? { seniq_evidence: evidence, seniq_evidence_note: 'This is the CURRENT picture behind each SenIQ signal, not the exact values on the last signal date.' } : {}),
      ...(metrics.length && notHeld.length ? { no_evidence_for: notHeld, no_evidence_reason: 'not in the portfolio, so SenIQ does not show their news to this user' } : {}),
    };
  },

  async draft_strategy({ spec, assumptions } = {}, ctx) {
    requireTier(ctx, 'plus', 'The Strategy Builder');
    const checked = validateSpec(spec);
    if (!checked.valid) throw new ScopeError(`invalid_draft: fix these and call draft_strategy again — ${checked.errors.join('; ')}`);

    // The engine is the authority when it is up; the draft still stands on the app's check when it is not.
    let validatedBy = 'app';
    const out = await engine(ctx)('/api/strategies/validate', { method: 'POST', body: checked.spec, timeoutMs: QA.STRATEGY_VALIDATE_TIMEOUT_MS });
    if (out.status === 200 && out.data && out.data.valid === false) {
      throw new ScopeError(`invalid_draft: the strategy engine rejected it — ${clip((out.data.errors || []).join('; '), 400)}`);
    }
    if (out.status === 200 && out.data && out.data.valid) validatedBy = 'app+engine';

    const row = { kind: 'custom', spec: checked.spec };
    const draft = {
      status: 'draft — not saved, not backtested, not deployed',
      name: checked.spec.name,
      rules: describeStrategy(row, 700),
      seniq_signals: seniqMetricsOf(row),
      data_depth_notes: dataDepthNotes(checked.spec),
      assumptions: (Array.isArray(assumptions) ? assumptions : []).map((a) => clip(a, 160)).filter(Boolean).slice(0, 6),
      validated_by: validatedBy,
      spec: checked.spec,
    };
    // Handed to the caller (answerQuestion) so the draft travels with the answer as data,
    // not as text the UI would have to parse back out.
    if (Array.isArray(ctx.drafts)) ctx.drafts.push(draft);
    const { spec: _spec, ...summary } = draft;
    return {
      ...summary,
      next_steps: 'The draft is attached to this answer. The user can open it in the Strategy Builder, review the rules, then run a backtest against buy-and-hold themselves. You cannot save or test it.',
    };
  },

  async list_strategy_presets(_args, ctx) {
    let catalog = cached('catalog', QA.STRATEGY_CATALOG_CACHE_MS);
    if (!catalog) {
      const out = await engine(ctx)('/api/strategies', { timeoutMs: QA.STRATEGY_ENGINE_TIMEOUT_MS });
      if (out.status !== 200) throw new ScopeError(ENGINE_OFFLINE);
      catalog = out.data;
      remember('catalog', catalog);
    }
    return {
      presets: presetCards(catalog).slice(0, QA.STRATEGY_PRESETS_MAX),
      // Templates that use SenIQ signals. data_depth is how much history the signal really has
      // — pass it on whenever you mention one.
      seniq_presets: listSeniqPresets().map((p) => ({ name: p.name, description: clip(p.description, 180), data_depth: clip(p.data_depth, 140) })),
      seniq_signals_for_custom_strategies: (catalog.builder && catalog.builder.seniq_metrics) || [],
      how_to_test: 'Open Backtest, pick the template and a symbol, and compare it with buy-and-hold. Ask cannot run, save or deploy a strategy.',
    };
  },
};

STRATEGY_TOOLS.push(DRAFT_TOOL);

// Appended to Ask's system prompt in v2 mode.
const STRATEGY_PROMPT = `

Strategies (this account has the strategy features):
- You can answer about the user's own saved strategies and paper deployments with list_my_strategies, get_paper_performance and explain_strategy_signal. "Running" means an active paper deployment.
- Paper results are simulated. Whenever you quote a return, say it is a paper result and give its dates. Deployments cover different periods; say so before calling one "best". Never present a paper or past result as what will happen.
- If asked what kind of strategy might suit them, you may name up to three templates from list_strategy_presets that fit what they described, explain each rule in plain words, and tell them to test it in Backtest against buy-and-hold. Do not say a template will be profitable, do not recommend deploying one, and do not suggest a specific trade. End such an answer with: "Educational only, not investment advice."
- If the user describes rules in words ("buy when the 20-day average crosses above the 50-day and sentiment is positive, sell on the reverse cross or an 8% loss"), you may turn them into a draft with draft_strategy. Draft what they described, nothing more. If draft_strategy returns errors, fix the spec and call it again. In your answer: restate the rules in plain words, list anything you assumed, pass on every data_depth_notes line as written, and say the draft is untested and is theirs to review and backtest. If they only state a goal ("make me money", "a safe strategy") without rules, do not invent one: ask what should trigger a buy and a sell, or offer the templates. Never say a draft will be profitable. End with: "Educational only, not investment advice."
- You cannot run a backtest, save, edit or deploy a strategy from here; point to the Strategy Builder, Backtest or Paper Trade page instead.`;

module.exports = {
  STRATEGY_TOOLS, STRATEGY_EXECUTORS, STRATEGY_PROMPT, DRAFT_GRAMMAR,
  describeRule, describeFactors, describeStrategy, seniqMetricsOf, summarizeReplay, rankPerformance, presetCards, replayWindow,
};
