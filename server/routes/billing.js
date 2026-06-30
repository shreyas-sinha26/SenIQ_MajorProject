/**
 * Phase 6 — billing.
 *
 * GET /plans  — pricing + capability matrix for the upgrade UI.
 * POST /checkout — DEV STUB: real Stripe (US) / Razorpay (IN) Checkout + webhooks wire in at
 *   deploy (they need the public HTTPS domain for the payment webhook). On localhost we flip
 *   the tier directly to simulate a completed purchase, so all gating is testable now.
 *   ⚠️ Replace this body with a real Checkout-session create + webhook-driven tier update
 *   before going live — do NOT ship the direct flip to production.
 */

const express = require('express');
const { queryOne } = require('../db');
const { authMiddleware } = require('./auth');
const { attachTier } = require('../middleware/tier');
const { TIERS, PRICING } = require('../config');

const router = express.Router();

// GET /api/billing/plans — the three plans + their prices/capabilities + the caller's tier.
router.get('/plans', authMiddleware, attachTier, async (req, res) => {
  const plans = ['free', 'plus', 'pro'].map((id) => ({ id, ...TIERS[id] }));
  res.json({ plans, pricing: PRICING, currentTier: req.tier || 'free' });
});

// POST /api/billing/checkout — { tier, period } — simulated purchase (see file header).
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const { tier, period } = req.body || {};
    if (!TIERS[tier]) return res.status(400).json({ error: 'Invalid tier' });
    const p = period === 'annual' ? 'annual' : 'monthly';
    const updated = await queryOne(
      `UPDATE users SET subscription_tier = $1, subscription_period = $2, subscription_updated_at = now()
        WHERE id = $3 RETURNING id, subscription_tier, subscription_period`,
      [tier, p, req.user.id]
    );
    res.json({
      ok: true,
      simulated: true,
      user: updated,
      message: `Switched to ${TIERS[tier].label} (${p}). Dev stub — no payment was taken.`,
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

module.exports = router;
