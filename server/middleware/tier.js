/**
 * Phase 6 — tier gating.
 *
 * Tier is read from the DB per request (not from the JWT) so an admin flip or a checkout
 * takes effect immediately. `attachTier` loads it onto the request; `requireTier` /
 * `requireAdmin` enforce; `upsell()` builds the 402 body the frontend turns into an
 * upgrade prompt. All gated routes sit behind authMiddleware first (req.user.id present).
 */

const { queryOne } = require('../db');
const { TIERS, TIER_ORDER } = require('../config');

function tierConfig(tier) {
  return TIERS[tier] || TIERS.free;
}

// Load {tier, isAdmin} for a user id from the DB (defaults to free if the row/columns are missing).
async function getUserTier(userId) {
  try {
    const row = await queryOne('SELECT subscription_tier, is_admin FROM users WHERE id = $1', [userId]);
    const tier = row && TIERS[row.subscription_tier] ? row.subscription_tier : 'free';
    return { tier, isAdmin: !!(row && row.is_admin) };
  } catch {
    return { tier: 'free', isAdmin: false };
  }
}

// Attach req.tier / req.isAdmin / req.tierCfg. Use after authMiddleware on gated routers.
async function attachTier(req, res, next) {
  if (!req.user || !req.user.id) return next();
  const { tier, isAdmin } = await getUserTier(req.user.id);
  req.tier = tier;
  req.isAdmin = isAdmin;
  req.tierCfg = tierConfig(tier);
  next();
}

// 402 body → the frontend renders an upgrade prompt from this.
function upsell(requiredTier, message) {
  return {
    error: message || `This feature requires the ${tierConfig(requiredTier).label} plan.`,
    upgrade: { requiredTier, requiredLabel: tierConfig(requiredTier).label },
  };
}

// Block the request unless the user's tier rank ≥ the required tier.
function requireTier(minTier) {
  return async (req, res, next) => {
    if (req.tier == null) await attachTier(req, res, () => {});
    const have = tierConfig(req.tier).rank ?? 0;
    const need = tierConfig(minTier).rank ?? 0;
    if (have < need) return res.status(402).json(upsell(minTier));
    next();
  };
}

// Admin-only guard.
async function requireAdmin(req, res, next) {
  if (req.isAdmin == null) await attachTier(req, res, () => {});
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { tierConfig, getUserTier, attachTier, requireTier, requireAdmin, upsell, TIER_ORDER };
