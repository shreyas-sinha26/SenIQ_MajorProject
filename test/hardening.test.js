/**
 * Offline tests for the request-safety layer (no real DB, no outside network):
 *   - asyncRouter: a rejected async handler becomes a 500, not a dead process
 *   - safeFetch: private / loopback / metadata addresses are refused
 *   - ticker validation
 *   - sessions: only a live server-side session gets through; sign-out, password change,
 *     idle and absolute limits end it; cross-site writes and stale re-auth are refused
 * Run: node test/hardening.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('assert');
const express = require('express');

// A stand-in for server/db.js, installed before anything requires the real one. It keeps
// users and sessions in memory and answers the handful of statements sessions.js sends.
const users = new Map();
const sessionRows = []; // { id, user_id, token_hash, last_used_at, expires_at, reauth_at, revoked_at }
const DAY = 86_400_000;
const dbPath = require.resolve('../server/db');
const fakeDb = {
  queryOne: async (sql, params) => {
    if (/FROM sessions s JOIN users u/.test(sql)) {
      const idleDays = Number(params[1]);
      const s = sessionRows.find((r) => r.token_hash === params[0] && !r.revoked_at &&
        r.expires_at > Date.now() && r.last_used_at > Date.now() - idleDays * DAY);
      const u = s && users.get(s.user_id);
      return u ? { id: s.id, user_id: s.user_id, last_used_at: new Date(s.last_used_at), reauth_at: s.reauth_at && new Date(s.reauth_at),
        email: u.email, name: u.name, subscription_tier: u.subscription_tier, is_admin: u.is_admin, has_password: !!u.password_hash } : null;
    }
    if (/INSERT INTO sessions/.test(sql)) {
      const row = { id: sessionRows.length + 1, user_id: params[0], token_hash: params[1], last_used_at: Date.now(),
        expires_at: Date.now() + Number(params[2]) * DAY, reauth_at: Date.now(), revoked_at: null };
      sessionRows.push(row);
      return { id: row.id };
    }
    return /FROM users WHERE id/.test(sql) ? users.get(params[0]) || null : null;
  },
  query: async () => [],
  execute: async (sql, params) => {
    if (/SET revoked_at = now\(\) WHERE id/.test(sql)) sessionRows.filter((r) => r.id === params[0]).forEach((r) => { r.revoked_at = Date.now(); });
    else if (/SET revoked_at = now\(\) WHERE user_id/.test(sql)) sessionRows.filter((r) => r.user_id === params[0] && r.id !== params[1]).forEach((r) => { r.revoked_at = Date.now(); });
    else if (/SET reauth_at/.test(sql)) sessionRows.filter((r) => r.id === params[0]).forEach((r) => { r.reauth_at = Date.now(); });
    else if (/SET last_used_at/.test(sql)) sessionRows.filter((r) => r.id === params[0]).forEach((r) => { r.last_used_at = Date.now(); });
    return { rowCount: 0, rows: [] };
  },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { asyncRouter } = require('../server/middleware/asyncRouter');
const { isBlockedAddress, assertPublicUrl, UnsafeUrlError } = require('../server/services/safeFetch');
const { isValidTicker, resolveAsset } = require('../server/services/assetRegistry');
const { authMiddleware } = require('../server/routes/auth');
const sessions = require('../server/services/sessions');
const { SESSION } = require('../server/config');

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

  console.log('sessions:');
  const router = asyncRouter();
  router.use(sessions.sameOriginGuard);
  router.post('/login/:id', async (req, res) => { await sessions.startSession(res, Number(req.params.id), req); res.json({ ok: true }); });
  router.get('/me', authMiddleware, (req, res) => res.json({ id: req.user.id, tier: req.userRow.subscription_tier }));
  router.post('/logout', authMiddleware, async (req, res) => { await sessions.endSession(req.session.id); res.json({ ok: true }); });
  router.post('/password/:id', authMiddleware, async (req, res) => { await sessions.endUserSessions(req.user.id, req.session.id); res.json({ ok: true }); });
  router.post('/reauth', authMiddleware, async (req, res) => { await sessions.markReauthenticated(req.session.id); res.json({ ok: true }); });
  router.post('/sensitive', authMiddleware, sessions.requireRecentAuth, (req, res) => res.json({ ok: true }));
  const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
  const call = (base, path, cookie, opts = {}) => fetch(`${base}${path}`, { ...opts, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) } });
  users.set(1, { email: 'a@b.co', name: 'A', subscription_tier: 'plus', is_admin: false, password_hash: 'x' });
  users.set(2, { email: 'c@d.co', name: 'C', subscription_tier: 'free', is_admin: false, password_hash: null });

  await withServer(appWith(router), async (base) => {
    const signIn = async (id) => cookieOf(await call(base, `/login/${id}`, null, { method: 'POST' }));

    await check('signing in sets an HttpOnly, SameSite=Lax cookie; the table holds only its hash', async () => {
      const res = await call(base, '/login/1', null, { method: 'POST' });
      const header = res.headers.get('set-cookie');
      assert.match(header, new RegExp(`^${SESSION.COOKIE}=[A-Za-z0-9_-]{43};`));
      assert.ok(/HttpOnly/i.test(header) && /SameSite=Lax/i.test(header) && /Path=\//i.test(header));
      const raw = cookieOf(res).split('=')[1];
      const row = sessionRows[sessionRows.length - 1];
      assert.ok(row.token_hash === sessions.hashId(raw) && row.token_hash !== raw);
    });
    await check('a live session passes and carries the user and tier', async () => {
      const res = await call(base, '/me', await signIn(1));
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), { id: 1, tier: 'plus' });
    });
    await check('no cookie, a made-up cookie, an old bearer token and a deleted user are refused', async () => {
      assert.strictEqual((await call(base, '/me')).status, 401);
      assert.strictEqual((await call(base, '/me', `${SESSION.COOKIE}=${'a'.repeat(43)}`)).status, 401);
      assert.strictEqual((await call(base, '/me', `${SESSION.COOKIE}=nope`)).status, 401);
      assert.strictEqual((await call(base, '/me', null, { headers: { Authorization: 'Bearer anything' } })).status, 401);
      users.set(9, { email: 'x@y.co', name: 'X', subscription_tier: 'free', is_admin: false });
      const cookie = await signIn(9);
      users.delete(9);
      assert.strictEqual((await call(base, '/me', cookie)).status, 401);
    });
    await check('signing out ends the session on the server: a copy of the cookie stops working', async () => {
      const cookie = await signIn(1);
      const copy = cookie;
      assert.strictEqual((await call(base, '/logout', cookie, { method: 'POST' })).status, 200);
      assert.strictEqual((await call(base, '/me', copy)).status, 401);
    });
    await check('a password change ends every other session and keeps the one that made it', async () => {
      const here = await signIn(1);
      const elsewhere = await signIn(1);
      assert.strictEqual((await call(base, '/password/1', here, { method: 'POST' })).status, 200);
      assert.strictEqual((await call(base, '/me', here)).status, 200);
      assert.strictEqual((await call(base, '/me', elsewhere)).status, 401);
    });
    await check('idle for longer than the limit, or past the absolute limit, is signed out', async () => {
      const idle = await signIn(1);
      sessionRows[sessionRows.length - 1].last_used_at = Date.now() - (SESSION.IDLE_DAYS * DAY + 60_000);
      assert.strictEqual((await call(base, '/me', idle)).status, 401);
      const old = await signIn(1);
      sessionRows[sessionRows.length - 1].expires_at = Date.now() - 1000;
      assert.strictEqual((await call(base, '/me', old)).status, 401);
    });
    await check('using a session pushes its idle clock back, at most once per touch interval', async () => {
      const cookie = await signIn(1);
      const row = sessionRows[sessionRows.length - 1];
      const fresh = row.last_used_at;
      await call(base, '/me', cookie);
      assert.strictEqual(row.last_used_at, fresh);
      row.last_used_at = Date.now() - (SESSION.IDLE_DAYS - 1) * DAY;
      await call(base, '/me', cookie);
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(Date.now() - row.last_used_at < 5000);
    });
    await check('a state-changing request from another site is refused; this site and non-browser callers pass', async () => {
      const cookie = await signIn(1);
      const post = (origin) => call(base, '/reauth', cookie, { method: 'POST', headers: origin ? { Origin: origin } : {} });
      assert.strictEqual((await post('https://evil.example')).status, 403);
      assert.strictEqual((await post(base)).status, 200);
      assert.strictEqual((await post(null)).status, 200);
      assert.strictEqual((await call(base, '/me', cookie, { headers: { Origin: 'https://evil.example' } })).status, 200);
    });
    await check('a sensitive action needs the password proven recently, then passes after confirming it', async () => {
      const cookie = await signIn(1);
      const row = sessionRows[sessionRows.length - 1];
      assert.strictEqual((await call(base, '/sensitive', cookie, { method: 'POST' })).status, 200);
      row.reauth_at = Date.now() - (SESSION.REAUTH_MINUTES + 1) * 60_000;
      const stale = await call(base, '/sensitive', cookie, { method: 'POST' });
      assert.strictEqual(stale.status, 403);
      assert.deepStrictEqual((({ reauth, can_use_password }) => ({ reauth, can_use_password }))(await stale.json()), { reauth: true, can_use_password: true });
      await call(base, '/reauth', cookie, { method: 'POST' });
      assert.strictEqual((await call(base, '/sensitive', cookie, { method: 'POST' })).status, 200);
      const social = await signIn(2);
      sessionRows[sessionRows.length - 1].reauth_at = 0;
      assert.strictEqual((await (await call(base, '/sensitive', social, { method: 'POST' })).json()).can_use_password, false);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
