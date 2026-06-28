/**
 * Daily-brief routes (Engine Phase E5). In-app delivery only — email is Phase 9.
 *
 * GET  /api/reports/daily          — the user's latest brief (generates today's if missing;
 *                                     idempotent per day, so this is not a loopable Claude trigger)
 * POST /api/reports/daily/generate — regenerate today's brief. The per-user daily quota still
 *                                     applies, so repeated calls fall back to the free writer
 *                                     once the quota is spent — never a runaway Claude path.
 */

const express = require('express');
const { authMiddleware } = require('./auth');
const { generateBriefForUser, getLatestBrief } = require('../services/reports');
const { answerQuestion } = require('../services/qa');
const { DISCLAIMER } = require('../config');

const router = express.Router();
router.use(authMiddleware);

router.get('/daily', async (req, res) => {
  try {
    let brief = await getLatestBrief(req.user.id);
    if (!brief) brief = await generateBriefForUser(req.user.id);
    res.json({ brief, disclaimer: DISCLAIMER });
  } catch (err) {
    console.error('Daily brief error:', err);
    res.status(500).json({ error: 'Failed to load daily brief' });
  }
});

router.post('/daily/generate', async (req, res) => {
  try {
    const brief = await generateBriefForUser(req.user.id, { force: true });
    res.json({ brief, disclaimer: DISCLAIMER });
  } catch (err) {
    console.error('Daily brief generate error:', err);
    res.status(500).json({ error: 'Failed to generate daily brief' });
  }
});

// POST /api/reports/ask — natural-language portfolio Q&A (E6). On-demand but hard-capped
// per user/day; over the cap (or no key) it returns a deterministic grounded data answer.
router.post('/ask', async (req, res) => {
  try {
    const result = await answerQuestion(req.user.id, req.body && req.body.question);
    if (result.error === 'empty_question') return res.status(400).json({ error: 'Ask a question first.' });
    res.json({ ...result, disclaimer: DISCLAIMER });
  } catch (err) {
    console.error('Q&A error:', err);
    res.status(500).json({ error: 'Failed to answer question' });
  }
});

module.exports = router;
