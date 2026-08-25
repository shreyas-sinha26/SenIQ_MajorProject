/**
 * Phase 5 — one-time email tokens (password reset + email verification).
 *
 * Same storage discipline as API keys: only the sha256 hash is persisted, the
 * plaintext exists solely inside the emailed link. Tokens are single-use
 * (consume marks used_at atomically) and expire server-side.
 */
const crypto = require('crypto');
const { query, queryOne } = require('../db');

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Plausibility check before hitting the DB (base64url of 32 bytes = 43 chars).
function looksLikeToken(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{40,50}$/.test(raw);
}

async function createToken(userId, purpose, ttlMinutes) {
  const raw = generateToken();
  // One live token per (user, purpose): invalidate older unused ones so a
  // re-request doesn't leave a trail of valid reset links.
  await query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose]
  );
  await query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [userId, purpose, hashToken(raw), String(ttlMinutes)]
  );
  return raw;
}

// Atomically consume: returns { user_id } once, null on invalid/expired/reused.
async function consumeToken(raw, purpose) {
  if (!looksLikeToken(raw)) return null;
  return queryOne(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(raw), purpose]
  );
}

module.exports = { generateToken, hashToken, looksLikeToken, createToken, consumeToken };
