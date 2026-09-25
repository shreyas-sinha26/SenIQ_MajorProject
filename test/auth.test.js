/**
 * Phase 5 — offline tests for the auth primitives (no DB, no network).
 * Covers the one-time token helpers and the auth rate-limit configuration.
 * Run: node test/auth.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('assert');
const { generateToken, hashToken, looksLikeToken } = require('../server/services/authTokens');
const { AUTH_LIMITS, OAUTH, EMAIL } = require('../server/config');
const { makeLimiter } = require('../server/services/slidingWindow');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('auth.test.js — Phase 5 primitives');

// ─── Token generation ────────────────────────────────────────
check('generateToken returns base64url of 32 bytes (43 chars, url-safe)', () => {
  const t = generateToken();
  assert.strictEqual(typeof t, 'string');
  assert.strictEqual(t.length, 43);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});

check('generateToken is collision-free across 1000 draws', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(generateToken());
  assert.strictEqual(seen.size, 1000);
});

check('hashToken is deterministic sha256 hex', () => {
  const t = generateToken();
  assert.strictEqual(hashToken(t), hashToken(t));
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(hashToken(t), hashToken(t + 'x'));
});

check('looksLikeToken accepts real tokens, rejects junk', () => {
  assert.strictEqual(looksLikeToken(generateToken()), true);
  assert.strictEqual(looksLikeToken(''), false);
  assert.strictEqual(looksLikeToken('short'), false);
  assert.strictEqual(looksLikeToken(null), false);
  assert.strictEqual(looksLikeToken('a'.repeat(43) + '!'), false); // bad charset
  assert.strictEqual(looksLikeToken('x'.repeat(100)), false);      // too long
});

// ─── Rate-limit configuration ────────────────────────────────
check('auth limits: login window is stricter than nothing, reset stricter than login', () => {
  assert.ok(AUTH_LIMITS.LOGIN.limit > 0 && AUTH_LIMITS.LOGIN.windowMs > 0);
  assert.ok(AUTH_LIMITS.RESET.limit < AUTH_LIMITS.LOGIN.limit);
});

check('a limiter built from AUTH_LIMITS.RESET blocks the Nth+1 request', () => {
  const lim = makeLimiter(AUTH_LIMITS.RESET);
  const now = Date.now();
  for (let i = 0; i < AUTH_LIMITS.RESET.limit; i++) {
    assert.strictEqual(lim.allow('1.2.3.4', now + i).allowed, true);
  }
  const blocked = lim.allow('1.2.3.4', now + 1000);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // A different IP is unaffected.
  assert.strictEqual(lim.allow('5.6.7.8', now + 1000).allowed, true);
});

check('token TTLs are sane (reset ≤ 60 min, verify ≥ reset)', () => {
  assert.ok(AUTH_LIMITS.TOKEN_TTL_MIN.RESET > 0 && AUTH_LIMITS.TOKEN_TTL_MIN.RESET <= 60);
  assert.ok(AUTH_LIMITS.TOKEN_TTL_MIN.VERIFY >= AUTH_LIMITS.TOKEN_TTL_MIN.RESET);
});

// ─── Provider gating ─────────────────────────────────────────
check('OAuth providers report disabled without env credentials', () => {
  // Test env has no GOOGLE_/GITHUB_ vars → both must be off, and the
  // /api/config flags (derived from .enabled) must be booleans.
  assert.strictEqual(typeof OAUTH.GOOGLE.enabled, 'boolean');
  assert.strictEqual(typeof OAUTH.GITHUB.enabled, 'boolean');
  if (!process.env.GOOGLE_CLIENT_ID) assert.strictEqual(OAUTH.GOOGLE.enabled, false);
  if (!process.env.GITHUB_CLIENT_ID) assert.strictEqual(OAUTH.GITHUB.enabled, false);
});

check('email service reports disabled without RESEND_API_KEY', () => {
  if (!process.env.RESEND_API_KEY) assert.strictEqual(EMAIL.enabled, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
