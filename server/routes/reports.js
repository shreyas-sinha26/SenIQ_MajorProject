/**
 * Daily-brief routes (Engine Phase E5). In-app delivery only — email is Phase 9.
 *
 * GET  /api/reports/daily          — the user's latest brief (generates today's if missing;
 *                                     idempotent per day, so this is not a loopable Claude trigger)
 * POST /api/reports/daily/generate — regenerate today's brief. The per-user daily quota still
 *                                     applies, so repeated calls fall back to the free writer
 *                                     once the quota is spent — never a runaway Claude path.
 * POST   /api/reports/ask             — Ask (E6), optionally continuing a saved thread
 * GET    /api/reports/threads         — the user's recent saved conversations
 * GET    /api/reports/threads/:id     — one conversation's messages
 * DELETE /api/reports/threads/:id     — delete a conversation
 */

const express = require('express');
const { authMiddleware } = require('./auth');
const { attachTier, requireTier } = require('../middleware/tier');
const { generateBriefForUser, getLatestBrief } = require('../services/reports');
const { answerQuestion } = require('../services/qa');
const { createThread, getThread, listThreads, getMessages, recentHistory, appendTurn, deleteThread } = require('../services/askThreads');
const { DISCLAIMER } = require('../config');

const router = express.Router();
router.use(authMiddleware, attachTier);

// Phase 6 — the AI Workspace (daily brief + Q&A) is a Plus/Pro feature.
router.use(requireTier('plus'));

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
// per user/day by tier; over the cap (or no key) it returns a deterministic grounded answer.
// Body: { question, thread_id? }. With a thread_id the SERVER supplies the follow-up history
// from that saved thread (the client can't inject turns); without one a new thread starts.
router.post('/ask', async (req, res) => {
  try {
    const body = req.body || {};
    let thread = null;
    if (body.thread_id != null) {
      thread = await getThread(req.user.id, body.thread_id);
      if (!thread) return res.status(404).json({ error: 'Conversation not found — start a new one.' });
    }
    const history = thread ? await recentHistory(thread.id) : [];
    const dailyLimit = req.tierCfg ? req.tierCfg.qaPerDay : undefined; // Plus 10 / Pro 30
    const result = await answerQuestion(req.user.id, body.question, history, { dailyLimit });
    if (result.error === 'empty_question') return res.status(400).json({ error: 'Ask a question first.' });

    if (!thread) thread = await createThread(req.user.id, result.question);
    await appendTurn(thread.id, result.question, result.answer, result.writer);
    res.json({ ...result, thread_id: thread.id, thread_title: thread.title, disclaimer: DISCLAIMER });
  } catch (err) {
    console.error('Q&A error:', err);
    res.status(500).json({ error: 'Failed to answer question' });
  }
});

// Saved conversations — all scoped to the signed-in user.
router.get('/threads', async (req, res) => {
  try {
    res.json({ threads: await listThreads(req.user.id) });
  } catch (err) {
    console.error('List threads error:', err);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

router.get('/threads/:id', async (req, res) => {
  try {
    const out = await getMessages(req.user.id, req.params.id);
    if (!out) return res.status(404).json({ error: 'Conversation not found' });
    res.json(out);
  } catch (err) {
    console.error('Get thread error:', err);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

router.delete('/threads/:id', async (req, res) => {
  try {
    if (!(await deleteThread(req.user.id, req.params.id))) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete thread error:', err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

module.exports = router;
