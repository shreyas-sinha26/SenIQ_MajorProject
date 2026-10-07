/**
 * Paper Trade routes (Phase 7) — Pro tier.
 *
 * Replay-from-inception: a deployment stores only {snapshotted strategy,
 * symbol, cash, deploy date}. State is computed on read by replaying
 * deploy→today (or →stopped_at) through the strategy service's sim engine
 * with `trade_from` gating — indicators warm up on pre-deploy history, but
 * no signal may trade before the deploy date, so a deployment never
 * "inherits" an entry that fired before it existed.
 */
const express = require('express');
const { query, queryOne, execute } = require('../db');
const { authMiddleware } = require('./auth');
const { attachTier, requireTier } = require('../middleware/tier');
const { STRATEGY_SERVICE } = require('../config');
const { seniqDataIfNeeded } = require('../services/signalHistory');

const { deployPaper, stopPaper, MAX_ACTIVE_DEPLOYMENTS } = require('../services/strategyStore');
const WARMUP_DAYS = 400; // history handed to the engine for indicator warmup

const router = express.Router();
router.use(authMiddleware, attachTier, requireTier('pro'));

function serviceHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (STRATEGY_SERVICE.SECRET) h['X-Service-Secret'] = STRATEGY_SERVICE.SECRET;
  return h;
}

async function callService(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STRATEGY_SERVICE.TIMEOUT_MS);
  try {
    const res = await fetch(`${STRATEGY_SERVICE.URL}${path}`, {
      method: 'POST', headers: serviceHeaders(), body: JSON.stringify(body), signal: controller.signal,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { status: 503, data: { detail: 'strategy engine is offline' } };
  } finally {
    clearTimeout(timer);
  }
}

// Local-time date formatting: pg DATE columns come back as JS Dates at LOCAL
// midnight, so toISOString() (UTC) would shift them back a day east of GMT —
// which both mislabeled the card and moved trade_from a day early.
const iso = (d) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

function rowToJson(r) {
  return {
    id: r.id, name: r.name, kind: r.kind,
    symbol: r.symbol, exchange: r.exchange,
    initial_cash: String(r.initial_cash),
    deployed_at: iso(r.deployed_at),
    status: r.status,
    stopped_at: r.stopped_at ? iso(r.stopped_at) : null,
  };
}

// GET /api/paper — list deployments.
router.get('/', async (req, res) => {
  const rows = await query(
    'SELECT * FROM paper_deployments WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ deployments: rows.map(rowToJson), max_active: MAX_ACTIVE_DEPLOYMENTS });
});

// POST /api/paper — deploy a SAVED strategy on one symbol with paper cash.
router.post('/', async (req, res) => {
  const out = await deployPaper(req.user.id, req.body || {});
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out.data);
});

// POST /api/paper/:id/state — replay deploy→now (or →stopped_at) and return
// current equity, open position, and the trade log.
router.post('/:id/state', async (req, res) => {
  const row = await queryOne(
    'SELECT * FROM paper_deployments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'deployment not found' });

  const deployed = new Date(row.deployed_at);
  const start = new Date(deployed);
  start.setDate(start.getDate() - WARMUP_DAYS);
  const end = row.status === 'stopped' && row.stopped_at ? new Date(row.stopped_at) : new Date();

  const body = {
    ...(row.kind === 'custom'
      ? { custom: row.spec, seniq_data: await seniqDataIfNeeded(row.spec, row.symbol) }
      : { strategy: row.strategy_name, params: row.params || {} }),
    symbol: row.symbol,
    exchange: row.exchange,
    start_date: iso(start),
    end_date: iso(end),
    trade_from: iso(deployed),
    initial_cash: String(row.initial_cash),
  };
  const out = await callService('/api/backtest', body);
  if (out.status !== 200) {
    const msg = out.status === 400 || out.status === 404
      ? (out.data.detail || 'replay failed')
      : 'Strategy engine is offline — try again later.';
    return res.status(out.status === 503 ? 503 : 400).json({ error: msg });
  }
  res.json({
    deployment: rowToJson(row),
    n_bars: out.data.n_bars,
    report: out.data.report,
    open_positions: out.data.open_positions,
    final_cash: out.data.final_cash,
    seniq_coverage: out.data.seniq_coverage || null,
  });
});

// POST /api/paper/:id/stop — freeze the deployment (state replays →stopped_at).
router.post('/:id/stop', async (req, res) => {
  const out = await stopPaper(req.user.id, req.params.id);
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.json(out.data);
});

// DELETE /api/paper/:id
router.delete('/:id', async (req, res) => {
  const out = await execute(
    'DELETE FROM paper_deployments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (out.rowCount === 0) return res.status(404).json({ error: 'deployment not found' });
  res.json({ deleted: true });
});

module.exports = router;
