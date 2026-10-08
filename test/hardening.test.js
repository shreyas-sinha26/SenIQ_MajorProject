/**
 * Offline tests for the request-safety layer (no real DB, no outside network):
 *   - asyncRouter: a rejected async handler becomes a 500, not a dead process
 *   - safeFetch: private / loopback / metadata addresses are refused
 *   - ticker validation
 *   - authMiddleware: only a live session token for an existing user gets through
 * Run: node test/hardening.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

// A stand-in for server/db.js, installed before anything requires the real one.
const users = new Map();
const dbPath = require.resolve('../server/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    queryOne: async (sql, params) => (/FROM users WHERE id/.test(sql) ? users.get(params[0]) || null : null),
    query: async () => [],
    execute: async () => ({ rowCount: 0, rows: [] }),
  },
};

const { asyncRouter } = require('../server/middleware/asyncRouter');
const { isBlockedAddress, assertPublicUrl, UnsafeUrlError } = require('../server/services/safeFetch');
const { isValidTicker, resolveAsset } = require('../server/services/assetRegistry');
const { authMiddleware, signSession } = require('../server/routes/auth');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

// Serve `app` on a free port for the length of fn(baseUrl).
async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function appWith(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((err, req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  return app;
}

(async () => {
  console.log('hardening.test.js — request safety');

  console.log('asyncRouter:');
  await check('a throwing async handler answers 500 and the server keeps serving', async () => {
    const router = asyncRouter();
    router.post('/analyze', async (req, res) => { res.json({ ok: req.body.text.trim() }); });
    router.get('/ok', async (req, res) => res.json({ ok: true }));
    await withServer(appWith(router), async (base) => {
      const bad = await fetch(`${base}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 123 }) });
      assert.strictEqual(bad.status, 500);
      const good = await fetch(`${base}/ok`);
      assert.strictEqual(good.status, 200);
    });
  });
  await check('async middleware passed to router.use is covered too', async () => {
    const router = asyncRouter();
    router.use(async () => { throw new Error('database is down'); });
    router.get('/x', (req, res) => res.json({ ok: true }));
    await withServer(appWith(router), async (base) => {
      assert.strictEqual((await fetch(`${base}/x`)).status, 500);
    });
  });
  await check('working handlers, sync handlers and mounted routers are unchanged', async () => {
    const inner = asyncRouter();
    inner.get('/b', (req, res) => res.json({ where: 'inner' }));
    const router = asyncRouter();
    router.get('/a', async (req, res) => res.json({ where: 'outer' }));
    router.use('/nested', inner);
    await withServer(appWith(router), async (base) => {
      assert.deepStrictEqual(await (await fetch(`${base}/a`)).json(), { where: 'outer' });
      assert.deepStrictEqual(await (await fetch(`${base}/nested/b`)).json(), { where: 'inner' });
    });
  });

  console.log('safeFetch:');
  await check('loopback, private, link-local and metadata addresses are blocked', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
      assert.strictEqual(isBlockedAddress(a), true, a);
    }
  });
  await check('public addresses are allowed', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.strictEqual(isBlockedAddress(a), false, a);
    }
  });
  await check('assertPublicUrl refuses bad schemes, credentials, literal private hosts', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'not a url',
      'http://user:pw@example.com/', 'http://127.0.0.1:8100/api/backtest', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/']) {
      await assert.rejects(() => assertPublicUrl(u), UnsafeUrlError, u);
    }
  });
  await check('a hostname is judged by every address it resolves to', async () => {
    const mixed = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
    await assert.rejects(() => assertPublicUrl('https://rebind.example/', { lookup: mixed }), UnsafeUrlError);
    const pub = async () => [{ address: '93.184.216.34' }];
    assert.strictEqual((await assertPublicUrl('https://example.com/a?b=1', { lookup: pub })).hostname, 'example.com');
    const missing = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(() => assertPublicUrl('https://nope.invalid/', { lookup: missing }), UnsafeUrlError);
  });

  console.log('ticker validation:');
  await check('real symbols pass, anything that is not a symbol is refused', () => {
    for (const t of ['AAPL', 'brk.b', 'M&M', 'BAJAJ-AUTO', '^NSEI', 'GC=F', 'BTC', 'A']) {
      assert.strictEqual(isValidTicker(resolveAsset(t).ticker), true, t);
    }
    for (const t of ["');alert(1);//", '<img src=x>', '', 'AA PL', 'A'.repeat(21), '.AAPL', 'AAPL"']) {
      assert.strictEqual(isValidTicker(resolveAsset(t).ticker), false, t);
    }
    assert.strictEqual(isValidTicker(undefined), false);
  });

  console.log('authMiddleware:');
  const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
  const router = asyncRouter();
  router.get('/me', authMiddleware, (req, res) => res.json({ id: req.user.id, tier: req.userRow.subscription_tier }));
  const call = (base, token) => fetch(`${base}/me`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const now = Math.floor(Date.now() / 1000);

  await withServer(appWith(router), async (base) => {
    await check('a session token for an existing user passes and carries the user row', async () => {
      users.set(1, { subscription_tier: 'plus', is_admin: false, password_changed_at: null });
      const res = await call(base, signSession({ id: 1, email: 'a@b.co', name: 'A' }));
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), { id: 1, tier: 'plus' });
    });
    await check('no token, a garbage token, and a token for a deleted user are refused', async () => {
      assert.strictEqual((await call(base, null)).status, 401);
      assert.strictEqual((await call(base, 'nope')).status, 401);
      assert.strictEqual((await call(base, signSession({ id: 999, email: 'x@y.co', name: 'X' }))).status, 401);
    });
    await check('an OAuth state token (same secret, no user) is not a session', async () => {
      const state = jwt.sign({ purpose: 'oauth-state', provider: 'google', nonce: 'abc' }, SECRET, { expiresIn: '10m' });
      assert.strictEqual((await call(base, state)).status, 401);
      const tagged = jwt.sign({ id: 1, purpose: 'oauth-state' }, SECRET, { expiresIn: '10m' });
      assert.strictEqual((await call(base, tagged)).status, 401);
    });
    await check('a password change ends older sessions and keeps the one issued with it', async () => {
      const user = { id: 2, email: 'c@d.co', name: 'C' };
      users.set(2, { subscription_tier: 'free', is_admin: false, password_changed_at: new Date(now * 1000) });
      assert.strictEqual((await call(base, signSession(user, now - 60))).status, 401);
      assert.strictEqual((await call(base, signSession(user, now))).status, 200);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
