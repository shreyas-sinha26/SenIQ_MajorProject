/**
 * IPO Watch routes — the calendar of Indian and US public issues (IPO_PLAN.md, Change 3).
 * Mounted only when FEATURES.IPO_WATCH is on. Read-only and the same for every tier.
 */

const { asyncRouter } = require('../middleware/asyncRouter');
const { authMiddleware } = require('./auth');
const { DISCLAIMER } = require('../config');
const { STAGES, BOARDS, MARKETS, marketDate, listCalendar, calendarAge } = require('../services/ipoWatch');
const { storiesFor } = require('../services/ipoWatch/arc');
const { idParam } = require('../middleware/idParam');

const router = asyncRouter();
router.use(authMiddleware);
router.param('id', idParam('Issue not found'));

// ─── GET /api/ipo-watch/calendar?market=in|us&board=mainboard|sme|all&spacs=1&stage=open ───
router.get('/calendar', async (req, res) => {
  const board = String(req.query.board || 'mainboard').toLowerCase();
  const stage = req.query.stage ? String(req.query.stage).toLowerCase() : null;
  if (board !== 'all' && !BOARDS.includes(board)) return res.status(400).json({ error: 'board must be mainboard, sme or all' });
  if (stage && !STAGES.includes(stage)) return res.status(400).json({ error: `stage must be one of ${STAGES.join(', ')}` });

  const market = String(req.query.market || 'in').toUpperCase();
  if (!MARKETS.includes(market)) return res.status(400).json({ error: 'market must be in or us' });

  const asOf = marketDate();
  const issues = await listCalendar({ market, board, spacs: req.query.spacs === '1', stage, today: asOf });
  const { updatedAt, stale } = await calendarAge(market);
  res.json({ asOf, market, board, issues, updatedAt, stale, disclaimer: DISCLAIMER });
});

// ─── GET /api/ipo-watch/:id/stories ───────────────────────────────────────────
// The stories linked to one issue, each with its tone, and the tone by day.
router.get('/:id/stories', async (req, res) => {
  const out = await storiesFor(Number(req.params.id));
  if (!out) return res.status(404).json({ error: 'Issue not found' });
  res.json(out);
});

module.exports = router;
