/**
 * Phase 8 — API key primitives (pure crypto, no DB, offline-testable).
 *
 * Key format: "seniq_" + 43 chars of base64url (32 random bytes) — long enough
 * that the sha256 lookup hash needs no salt or work factor (unlike passwords,
 * keys are high-entropy, so rainbow tables don't apply).
 */
const crypto = require('crypto');

const KEY_PREFIX = 'seniq_';
const PREFIX_DISPLAY_LEN = 14; // "seniq_" + 8 chars — enough to tell keys apart

function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

// → { key, hash, prefix }. `key` is shown to the user exactly once.
function generateKey() {
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key), prefix: key.slice(0, PREFIX_DISPLAY_LEN) };
}

// Cheap shape check before hitting the DB with garbage.
function looksLikeKey(key) {
  return typeof key === 'string'
    && key.startsWith(KEY_PREFIX)
    && key.length >= KEY_PREFIX.length + 32
    && key.length <= 128;
}

module.exports = { generateKey, hashKey, looksLikeKey, KEY_PREFIX };
