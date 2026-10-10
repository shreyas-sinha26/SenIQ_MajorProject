/**
 * Phase 6 — billing.
 *
 * GET /plans  — pricing + capability matrix for the upgrade UI.
 * POST /checkout — DEV STUB: real Stripe (US) / Razorpay (IN) Checkout + webhooks wire in at
 *   deploy (they need the public HTTPS domain for the payment webhook). On localhost we flip
 *   the tier directly to simulate a completed purchase, so all gating is testable now.
 *   ⚠️ Replace this body with a real Checkout-session create + webhook-driven tier update
 *   before going live. Until then the direct flip is refused in production for everyone
 *   but an admin, so a deployed copy can't hand out paid plans for free.
 */

const { asyncRouter } = require('../middleware/asyncRouter');
const { queryOne } = require('../db');
const { authMiddleware } = require('./auth');
const { attachTier, isTier } = require('../middleware/tier');
const { TIERS, PRICING } = require('../config');

const isProd = process.env.NODE_ENV === 'production';

const router = asyncRouter();

// GET /api/billing/plans — the three plans + their prices/capabilities + the caller's tier.
router.get('/plans', authMiddleware, attachTier, async (req, res) => {
  const plans = ['free', 'plus', 'pro'].map((id) => ({ id, ...TIERS[id] }));
  res.json({ plans, pricing: PRICING, currentTier: req.tier || 'free' });
});

// POST /api/billing/checkout — { tier, period } — simulated purchase (see file header).
router.post('/checkout', authMiddleware, attachTier, async (req, res) => {
  try {
    const { tier, period } = req.body || {};
    if (!isTier(tier)) return res.status(400).json({ error: 'Invalid tier' });
    if (isProd && !req.isAdmin) {
      return res.status(501).json({ error: 'Paid plans are not open yet — payments are still being set up.' });
    }
    // A plan with a holdings limit cannot be taken with more holdings than it covers: the
    // extra ones would stay monitored for free. The user removes some first.
    const cap = TIERS[tier].maxHoldings;
    if (Number.isFinite(cap)) {
      const { n } = await queryOne('SELECT count(*)::int AS n FROM portfolio WHERE user_id = $1', [req.user.id]);
      if (n > cap) {
        return res.status(409).json({
          error: `${TIERS[tier].label} covers ${cap} holdings and you have ${n}. Remove ${n - cap} from your portfolio first.`,
          holdings: n, maxHoldings: cap,
        });
      }
    }
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
