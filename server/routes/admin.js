/**
 * Phase 6 — admin routes (is_admin only).
 * Lets an admin list users and set any account's tier — including their own, which is how
 * the admin previews Free / Plus / Pro gating live without paying.
 */

const express = require('express');
const { query, queryOne } = require('../db');
const { authMiddleware } = require('./auth');
const { attachTier, requireAdmin } = require('../middleware/tier');
const { TIERS } = require('../config');

const router = express.Router();
router.use(authMiddleware, attachTier, requireAdmin);

// GET /api/admin/users — everyone + their tier.
router.get('/users', async (req, res) => {
  try {
    const users = await query(
      `SELECT id, email, name, subscription_tier, is_admin, subscription_updated_at, created_at
         FROM users ORDER BY id DESC LIMIT 500`
    );
    res.json({ users });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// PUT /api/admin/tier — set a tier. Defaults to the admin's own account (the tier-preview
// switcher); pass userId to change someone else.
router.put('/tier', async (req, res) => {
  try {
    const { tier, userId } = req.body || {};
    if (!TIERS[tier]) return res.status(400).json({ error: 'Invalid tier' });
    const targetId = userId || req.user.id;
    const updated = await queryOne(
      `UPDATE users SET subscription_tier = $1, subscription_updated_at = now()
        WHERE id = $2 RETURNING id, email, name, subscription_tier`,
      [tier, targetId]
    );
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json({ user: updated });
  } catch (err) {
    console.error('Admin set-tier error:', err);
    res.status(500).json({ error: 'Failed to set tier' });
  }
});

module.exports = router;
