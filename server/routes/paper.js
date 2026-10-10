/**
 * Paper Trade routes (Phase 7) — Pro tier.
 *
 * Replay-from-inception: a deployment stores {snapshotted strategy,
 * symbol, cash, deploy date}. Current state is computed on read by replaying
 * deploy→today (or →stopped_at) through the strategy service's sim engine
 * with `trade_from` gating — indicators warm up on pre-deploy history, but
 * no signal may trade before the deploy date, so a deployment never
 * "inherits" an entry that fired before it existed.
 *
 * The ledger is the stored half: fills and daily values a daily job has
 * recorded from completed days (services/paperLedger.js). Reading it needs
 * no engine.
 */
const { asyncRouter } = require('../middleware/asyncRouter');
const { query, queryOne, execute } = require('../db');
const { authMiddleware } = require('./auth');
const { attachTier, requireTier, tierConfig } = require('../middleware/tier');
const { idParam } = require('../middleware/idParam');
const { deployPaper, stopPaper, deploymentToJson, MAX_ACTIVE_DEPLOYMENTS } = require('../services/strategyStore');
const { replayPaper, engineFailure } = require('../services/strategyClient');
const { readLedger } = require('../services/paperLedger');

const router = asyncRouter();
router.use(authMiddleware, attachTier);
router.param('id', idParam('deployment not found'));

// Deploying and the live replay are Pro. Seeing what one has, reading its recorded ledger,
// stopping it and deleting it stay open to any signed-in user, so an account that moves
// off Pro can still find and close what it started (the API keys routes do the same).
const pro = requireTier('pro');

// GET /api/paper — list deployments. `can_deploy` tells the page which of the two it is showing.
router.get('/', async (req, res) => {
  const rows = await query(
    'SELECT * FROM paper_deployments WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({
    deployments: rows.map(deploymentToJson),
    max_active: MAX_ACTIVE_DEPLOYMENTS,
    can_deploy: (tierConfig(req.tier).rank ?? 0) >= (tierConfig('pro').rank ?? 0),
  });
});

// POST /api/paper — deploy a SAVED strategy on one symbol with paper cash.
router.post('/', pro, async (req, res) => {
  const out = await deployPaper(req.user.id, req.body || {});
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out.data);
});

// POST /api/paper/:id/state — replay deploy→now (or →stopped_at) and return
// current equity, open position, and the trade log.
router.post('/:id/state', pro, async (req, res) => {
  const row = await queryOne(
    'SELECT * FROM paper_deployments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'deployment not found' });

  const out = await replayPaper(row);
  if (out.status !== 200) {
    const f = engineFailure(out, 'replay failed');
    return res.status(f.status === 404 ? 400 : f.status).json({ error: f.error });
  }
  res.json({
    deployment: deploymentToJson(row),
    n_bars: out.data.n_bars,
    report: out.data.report,
    open_positions: out.data.open_positions,
    final_cash: out.data.final_cash,
    seniq_coverage: out.data.seniq_coverage || null,
  });
});

// GET /api/paper/:id/ledger — the recorded fills and daily values.
router.get('/:id/ledger', async (req, res) => {
  const row = await queryOne(
    'SELECT * FROM paper_deployments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'deployment not found' });
  res.json({ deployment: deploymentToJson(row), ...(await readLedger(row)) });
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
