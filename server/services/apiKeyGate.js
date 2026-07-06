/**
 * Phase 8+ — shared API-key gate for the two key-authenticated transports:
 * the MCP server (/mcp) and the public REST API (/v1).
 *
 * Lives in ONE module so both share state deliberately:
 *  - resolveApiKey: hash lookup → user → Pro tier check, read from the DB per
 *    request so a downgrade or revocation cuts access on the very next call
 *    (same semantics as middleware/tier.js).
 *  - heavy/light limiters are singletons keyed by key id — a key gets ONE
 *    budget per hour no matter how it's used (MCP tool calls and REST requests
 *    draw from the same window; no double-dipping by mixing transports).
 */
const { queryOne, execute } = require('../db');
const { TIERS } = require('../config');
const { hashKey, looksLikeKey } = require('./apiKeys');
const { makeLimiter } = require('./slidingWindow');

// Backtests fetch + replay years of bars — keep the ceiling tight enough that
// a runaway loop can't monopolize the engine. Cheap calls get more headroom.
const HOUR = 3600 * 1000;
const heavyLimiter = makeLimiter({ limit: 30, windowMs: HOUR });  // backtest / signals / paper replay
const lightLimiter = makeLimiter({ limit: 240, windowMs: HOUR }); // catalog / validate / listings

// Authorization header → { ok:true, ctx:{userId, keyId} } | { ok:false, status, message }.
async function resolveApiKey(authorizationHeader) {
  const key = (authorizationHeader || '').replace(/^Bearer\s+/i, '');
  if (!looksLikeKey(key)) {
    return {
      ok: false, status: 401,
      message: 'Missing or malformed API key — pass "Authorization: Bearer seniq_…" (create keys in SenIQ → Profile → API Access).',
    };
  }
  const row = await queryOne(
    `SELECT k.id AS key_id, k.user_id, u.subscription_tier, u.is_admin
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashKey(key)]);
  if (!row) return { ok: false, status: 401, message: 'Invalid or revoked API key.' };

  const rank = (TIERS[row.subscription_tier] || TIERS.free).rank;
  if (rank < TIERS.pro.rank && !row.is_admin) {
    return { ok: false, status: 403, message: `API access requires the ${TIERS.pro.label} plan.` };
  }

  execute('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]).catch(() => {});
  return { ok: true, ctx: { userId: row.user_id, keyId: row.key_id } };
}

module.exports = { resolveApiKey, heavyLimiter, lightLimiter };
