/**
 * Offline logic tests for Phase 8 — API key crypto + the MCP rate limiter.
 * No DB, no network. Run via `npm test`.
 */

const assert = require('node:assert');
const { generateKey, hashKey, looksLikeKey, KEY_PREFIX } = require('../server/services/apiKeys');
const { makeLimiter } = require('../server/services/slidingWindow');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('apiKeys:');

check('generateKey → seniq_-prefixed, prefix matches key head', () => {
  const { key, hash, prefix } = generateKey();
  assert.ok(key.startsWith(KEY_PREFIX));
  assert.ok(key.length >= KEY_PREFIX.length + 32, `key too short: ${key.length}`);
  assert.strictEqual(prefix, key.slice(0, prefix.length));
  assert.match(hash, /^[0-9a-f]{64}$/);
});

check('hash is deterministic and matches generateKey output', () => {
  const { key, hash } = generateKey();
  assert.strictEqual(hashKey(key), hash);
  assert.strictEqual(hashKey(key), hashKey(key));
});

check('two keys never collide', () => {
  const a = generateKey(), b = generateKey();
  assert.notStrictEqual(a.key, b.key);
  assert.notStrictEqual(a.hash, b.hash);
});

check('looksLikeKey accepts real keys, rejects garbage', () => {
  assert.strictEqual(looksLikeKey(generateKey().key), true);
  assert.strictEqual(looksLikeKey(''), false);
  assert.strictEqual(looksLikeKey('Bearer abc'), false);
  assert.strictEqual(looksLikeKey('seniq_short'), false);          // too short
  assert.strictEqual(looksLikeKey('seniq_' + 'x'.repeat(200)), false); // too long
  assert.strictEqual(looksLikeKey(null), false);
  assert.strictEqual(looksLikeKey(12345), false);
});

console.log('\nslidingWindow:');

check('allows up to the limit, then blocks', () => {
  const lim = makeLimiter({ limit: 3, windowMs: 1000 });
  const t = 1_000_000;
  assert.strictEqual(lim.allow('k1', t).allowed, true);
  assert.strictEqual(lim.allow('k1', t + 1).allowed, true);
  assert.strictEqual(lim.allow('k1', t + 2).allowed, true);
  const blocked = lim.allow('k1', t + 3);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000, `retryAfterMs ${blocked.retryAfterMs}`);
});

check('keys are isolated from each other', () => {
  const lim = makeLimiter({ limit: 1, windowMs: 1000 });
  const t = 1_000_000;
  assert.strictEqual(lim.allow('a', t).allowed, true);
  assert.strictEqual(lim.allow('a', t).allowed, false);
  assert.strictEqual(lim.allow('b', t).allowed, true);
});

check('window slides — old hits expire', () => {
  const lim = makeLimiter({ limit: 2, windowMs: 1000 });
  const t = 1_000_000;
  lim.allow('k', t);
  lim.allow('k', t + 100);
  assert.strictEqual(lim.allow('k', t + 200).allowed, false);
  // First hit (t) falls out of the window at t+1001.
  assert.strictEqual(lim.allow('k', t + 1001).allowed, true);
});

check('remaining counts down', () => {
  const lim = makeLimiter({ limit: 3, windowMs: 1000 });
  const t = 1_000_000;
  assert.strictEqual(lim.allow('k', t).remaining, 2);
  assert.strictEqual(lim.allow('k', t).remaining, 1);
  assert.strictEqual(lim.allow('k', t).remaining, 0);
});

check('sweep drops fully-expired keys', () => {
  const lim = makeLimiter({ limit: 2, windowMs: 1000 });
  const t = 1_000_000;
  lim.allow('gone', t);
  lim.allow('kept', t + 900);
  lim.sweep(t + 1500); // 'gone' expired, 'kept' still has a live hit
  assert.strictEqual(lim.allow('kept', t + 1500).allowed, true);  // 1 live hit + this = 2, at limit
  assert.strictEqual(lim.allow('kept', t + 1501).allowed, false);
  assert.strictEqual(lim.allow('gone', t + 1500).allowed, true);  // fresh again
});

console.log('\napiKeyGate (shared MCP + REST budget):');

// apiKeyGate pulls in db.js, which fail-fasts without DATABASE_URL. A dummy is
// fine offline — pg pools connect lazily and these checks never run a query.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline-test/none';

// The gate module must be a singleton so /mcp and /v1 draw from the SAME
// per-key budget. (Routers themselves need a DB env to require, so we assert
// on the module the routers both import.)
check('limiters are module singletons', () => {
  delete require.cache[require.resolve('../server/services/apiKeyGate')];
  const a = require('../server/services/apiKeyGate');
  const b = require('../server/services/apiKeyGate');
  assert.strictEqual(a.heavyLimiter, b.heavyLimiter);
  assert.strictEqual(a.lightLimiter, b.lightLimiter);
});

check('budgets: heavy 30/h, light 240/h', () => {
  const { heavyLimiter, lightLimiter } = require('../server/services/apiKeyGate');
  assert.strictEqual(heavyLimiter.limit, 30);
  assert.strictEqual(lightLimiter.limit, 240);
  assert.strictEqual(heavyLimiter.windowMs, 3600 * 1000);
  assert.strictEqual(lightLimiter.windowMs, 3600 * 1000);
});

check('one bucket serves both transports for the same key', () => {
  const { heavyLimiter } = require('../server/services/apiKeyGate');
  const t = 5_000_000;
  // "MCP" spends 29 of the 30…
  for (let i = 0; i < 29; i++) assert.ok(heavyLimiter.allow('sharedKey', t + i).allowed);
  // …"REST" gets exactly the 1 that's left, then both are blocked.
  assert.strictEqual(heavyLimiter.allow('sharedKey', t + 29).allowed, true);
  assert.strictEqual(heavyLimiter.allow('sharedKey', t + 30).allowed, false);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
