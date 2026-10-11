/**
 * Offline tests for what closed the last open findings of the QA pass on v1.17: sign-up
 * that is confirmed by email (L1), a change of address and account deletion (L20), the
 * Terms and Privacy pages (L19), and the Congress poller once it has a live source (H2).
 * No network and no mail: the database and the email sender are in-memory stand-ins, and
 * each route is run by calling its handler.
 * Run: node test/account.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// ── In-memory stand-ins, installed before anything requires the real ones ──
const db = { calls: [], answers: [] };
function resetDb(answers = []) { db.calls = []; db.answers = answers; }
async function run(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  db.calls.push({ sql: q, params });
  for (const [pattern, rows] of db.answers) if (pattern.test(q)) return typeof rows === 'function' ? rows(params, q) : rows;
  return [];
}
const called = (pattern) => db.calls.filter((c) => pattern.test(c.sql));
const asResult = async (sql, params) => { const rows = await run(sql, params); return { rows, rowCount: rows.length }; };
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../server/db', {
  query: run,
  queryOne: async (sql, params) => (await run(sql, params))[0] || null,
  execute: asResult,
  tx: async (fn) => fn({ query: asResult }),
});
const mail = { on: true, sent: [] };
stub('../server/services/emailService', {
  emailEnabled: () => mail.on,
  sendEmail: async (m) => { mail.sent.push(m); return { delivered: true }; },
});

const { router } = require('../server/routes/auth');
const { SESSION, SMART_MONEY } = require('../server/config');

// The route's own handler (the last in its chain: the limiter and the signed-in check
// before it are tested where they live).
function handler(method, route) {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  assert.ok(layer, `${method} ${route}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function fakeRes() {
  const r = { code: 200, body: null, cookies: {}, cleared: [], redirected: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = () => r;
  r.cookie = (k, v) => { r.cookies[k] = v; return r; };
  r.clearCookie = (k) => { r.cleared.push(k); return r; };
  r.redirect = (u) => { r.redirected = u; return r; };
  return r;
}
// Runs a route and lets the mail it sends without waiting be recorded.
async function call(method, route, req) {
  mail.sent = [];
  const res = fakeRes();
  let failed = null;
  handler(method, route)({ headers: {}, query: {}, body: {}, ...req }, res, (err) => { failed = err || new Error('fell through'); });
  // The router's wrapper does not hand back the handler's promise: wait for the answer.
  for (let i = 0; i < 400 && !failed && res.body === null && res.redirected === null; i++) await new Promise((r) => setTimeout(r, 5));
  if (failed) throw failed;
  await new Promise((r) => setTimeout(r, 25));
  return res;
}
const signedIn = (extra = {}) => ({ user: { id: 7 }, session: { id: 70, reauth_at: new Date(), has_password: true }, ...extra });

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  });
}
const section = (title) => pending.push(async () => console.log(`\n${title}`));

const PASSWORD = 'correct horse 42';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const LOOKUP = /SELECT id, email, name, email_verified, confirm_required FROM users WHERE LOWER\(email\)/;

section('L1: sign-up is confirmed by email, and says the same for a known address');
check('a new address: an account that must confirm, a link, no session', async () => {
  mail.on = true;
  resetDb([[/INSERT INTO users/, (p) => [{ id: 7, email: p[0], name: p[2] }]]]);
  const res = await call('post', '/signup', { body: { name: 'New Person', email: 'new1@example.com', password: PASSWORD } });
  assert.strictEqual(res.code, 202);
  assert.strictEqual(res.body.confirm, true);
  assert.ok(!res.body.user && !res.cookies[SESSION.COOKIE]);
  assert.match(called(/INSERT INTO users/)[0].sql, /confirm_required\) VALUES \(\$1, \$2, \$3, TRUE\)/);
  assert.strictEqual(called(/INSERT INTO sessions/).length, 0);
  assert.strictEqual(mail.sent.length, 1);
  assert.strictEqual(mail.sent[0].kind, 'verify');
  assert.match(mail.sent[0].text, /\/api\/auth\/verify-email\?token=[A-Za-z0-9_-]{40,}/);
});
check('an address that has an account: the same answer, no new row, a notice to its owner', async () => {
  resetDb([[LOOKUP, [{ id: 3, email: 'known1@example.com', name: 'Known', email_verified: false, confirm_required: false }]]]);
  const res = await call('post', '/signup', { body: { name: 'Someone', email: 'Known1@Example.com', password: PASSWORD } });
  resetDb([[/INSERT INTO users/, (p) => [{ id: 8, email: p[0], name: p[2] }]]]);
  const fresh = await call('post', '/signup', { body: { name: 'Someone', email: 'new2@example.com', password: PASSWORD } });
  assert.strictEqual(res.code, fresh.code);
  assert.deepStrictEqual(Object.keys(res.body), Object.keys(fresh.body));
  assert.strictEqual(res.body.message.replace('Known1@Example.com', 'X'), fresh.body.message.replace('new2@example.com', 'X'));
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('already'));
});
check('that notice goes to the address on record and carries no link that signs anyone in', async () => {
  resetDb([[LOOKUP, [{ id: 3, email: 'known2@example.com', name: 'Known', email_verified: true, confirm_required: true }]]]);
  await call('post', '/signup', { body: { name: 'Someone', email: 'known2@example.com', password: PASSWORD } });
  assert.strictEqual(called(/INSERT INTO users|UPDATE users/).length, 0);
  assert.strictEqual(mail.sent.length, 1);
  assert.strictEqual(mail.sent[0].kind, 'signup_existing');
  assert.strictEqual(mail.sent[0].to, 'known2@example.com');
  assert.ok(!/token=/.test(mail.sent[0].text));
});
check('a sign-up never confirmed is started again with the name and password typed last', async () => {
  resetDb([[LOOKUP, [{ id: 4, email: 'wait1@example.com', name: 'Old', email_verified: false, confirm_required: true }]]]);
  const res = await call('post', '/signup', { body: { name: 'Newer Name', email: 'wait1@example.com', password: PASSWORD } });
  assert.strictEqual(res.code, 202);
  const update = called(/UPDATE users SET password_hash = \$1, name = \$2 WHERE id = \$3/)[0];
  assert.ok(update && update.params[1] === 'Newer Name' && update.params[2] === 4);
  assert.ok(await bcrypt.compare(PASSWORD, update.params[0]));
  assert.strictEqual(mail.sent[0].kind, 'verify');
  assert.ok(called(/UPDATE auth_tokens SET used_at = now\(\) WHERE user_id = \$1 AND purpose = \$2/).length >= 1); // the earlier link stops working
});
check('an address is sent mail a few times in a window, then no more', async () => {
  let sent = 0;
  for (let i = 0; i < 8; i++) {
    resetDb([[LOOKUP, [{ id: 5, email: 'flood@example.com', name: 'F', email_verified: true, confirm_required: false }]]]);
    const res = await call('post', '/signup', { body: { name: 'X', email: 'flood@example.com', password: PASSWORD } });
    assert.strictEqual(res.code, 202);
    sent += mail.sent.length;
  }
  assert.ok(sent >= 1 && sent <= 5, String(sent));
});
check('with no email provider the account is usable at once, as before', async () => {
  mail.on = false;
  resetDb([[/INSERT INTO users/, (p) => [{ id: 9, email: p[0], name: p[2], created_at: new Date(), subscription_tier: 'free', is_admin: false }]], [/INSERT INTO sessions/, [{ id: 90 }]]]);
  const res = await call('post', '/signup', { body: { name: 'Dev', email: 'dev@example.com', password: PASSWORD } });
  assert.strictEqual(res.code, 201);
  assert.ok(res.body.user && res.cookies[SESSION.COOKIE]);
  assert.ok(!/confirm_required/.test(called(/INSERT INTO users/)[0].sql));
  resetDb([[LOOKUP, [{ id: 9 }]]]);
  assert.strictEqual((await call('post', '/signup', { body: { name: 'Dev', email: 'dev@example.com', password: PASSWORD } })).code, 409);
  mail.on = true;
});
check('signing in to an account that has not confirmed is refused, with a new link, only after the right password', async () => {
  const row = { id: 4, email: 'wait2@example.com', name: 'W', password_hash: HASH, confirm_required: true, email_verified: false };
  resetDb([[/SELECT \* FROM users WHERE LOWER\(email\)/, [row]]]);
  const wrong = await call('post', '/login', { body: { email: row.email, password: 'not the password' } });
  assert.strictEqual(wrong.code, 401);
  assert.strictEqual(mail.sent.length, 0);
  const right = await call('post', '/login', { body: { email: row.email, password: PASSWORD } });
  assert.strictEqual(right.code, 403);
  assert.strictEqual(right.body.confirm, true);
  assert.ok(!right.cookies[SESSION.COOKIE] && called(/INSERT INTO sessions/).length === 0);
  assert.strictEqual(mail.sent[0].kind, 'verify');
});
check('once confirmed it signs in; an account from before the change never had to confirm', async () => {
  for (const flags of [{ confirm_required: true, email_verified: true }, { confirm_required: false, email_verified: false }]) {
    resetDb([[/SELECT \* FROM users WHERE LOWER\(email\)/, [{ id: 4, email: 'ok@example.com', name: 'W', password_hash: HASH, ...flags }]], [/INSERT INTO sessions/, [{ id: 91 }]]]);
    const res = await call('post', '/login', { body: { email: 'ok@example.com', password: PASSWORD } });
    assert.strictEqual(res.code, 200, JSON.stringify(flags));
    assert.ok(res.cookies[SESSION.COOKIE]);
  }
});
check('a password reset through the emailed link confirms the address too', async () => {
  resetDb([[/UPDATE auth_tokens SET used_at = now\(\) WHERE token_hash/, [{ user_id: 4 }]], [/UPDATE users SET password_hash/, [{ id: 4 }]]]);
  const res = await call('post', '/reset-password', { body: { token: 'a'.repeat(43), password: PASSWORD } });
  assert.strictEqual(res.code, 200);
  const update = called(/UPDATE users SET password_hash/)[0];
  assert.match(update.sql, /email_verified = email_verified OR \$4/);
  assert.strictEqual(update.params[3], true);
});

section('L20: a change of address');
const ME = { id: 7, email: 'me@example.com', name: 'Me', password_hash: HASH, oauth_provider: null, is_admin: false };
const meRows = (extra = {}) => [/FROM users WHERE id = \$1/, [{ ...ME, ...extra }]];
check('the password is asked for, and the address must be a new one', async () => {
  resetDb([meRows()]);
  assert.strictEqual((await call('post', '/change-email', signedIn({ body: { email: 'next1@example.com', password: 'wrong' } }))).code, 401);
  assert.strictEqual((await call('post', '/change-email', signedIn({ body: { email: 'next1@example.com' } }))).code, 400);
  assert.strictEqual((await call('post', '/change-email', signedIn({ body: { email: 'ME@example.com', password: PASSWORD } }))).code, 400);
  assert.strictEqual((await call('post', '/change-email', signedIn({ body: { email: 'not an address', password: PASSWORD } }))).code, 400);
  assert.strictEqual(called(/UPDATE users SET pending_email/).length, 0);
});
check('nothing changes yet: the new address gets the link, the current one a notice', async () => {
  resetDb([meRows()]);
  const res = await call('post', '/change-email', signedIn({ body: { email: 'next2@example.com', password: PASSWORD } }));
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(called(/UPDATE users SET pending_email = \$1 WHERE id = \$2/)[0].params, ['next2@example.com', 7]);
  assert.strictEqual(called(/UPDATE users SET email =/).length, 0);
  const link = mail.sent.find((m) => m.kind === 'email_change');
  const notice = mail.sent.find((m) => m.kind === 'email_change_notice');
  assert.strictEqual(link.to, 'next2@example.com');
  assert.match(link.text, /\/api\/auth\/confirm-email-change\?token=/);
  assert.strictEqual(notice.to, 'me@example.com');
  assert.ok(notice.text.includes('next2@example.com') && !/token=/.test(notice.text));
});
check('an address another account has gets the same answer, no mail, and is never set', async () => {
  resetDb([meRows(), [/SELECT id FROM users WHERE LOWER\(email\) = LOWER\(\$1\) AND id <> \$2/, [{ id: 99 }]]]);
  const taken = await call('post', '/change-email', signedIn({ body: { email: 'theirs@example.com', password: PASSWORD } }));
  const takenMail = mail.sent.length;
  resetDb([meRows()]);
  const free = await call('post', '/change-email', signedIn({ body: { email: 'next3@example.com', password: PASSWORD } }));
  assert.strictEqual(taken.code, free.code);
  assert.strictEqual(taken.body.message.replace('theirs@example.com', 'X'), free.body.message.replace('next3@example.com', 'X'));
  assert.strictEqual(takenMail, 0);
});
check('the link changes the address only if it is still free, and ends reset links sent to the old one', async () => {
  resetDb([[/UPDATE auth_tokens SET used_at = now\(\) WHERE token_hash/, [{ user_id: 7 }]], [/UPDATE users SET email = pending_email/, [{ id: 7 }]]]);
  const ok = await call('get', '/confirm-email-change', { query: { token: 'b'.repeat(43) } });
  assert.strictEqual(ok.redirected, '/app?email_changed=1');
  assert.match(called(/UPDATE users SET email = pending_email/)[0].sql, /email_verified = TRUE WHERE id = \$1 AND pending_email IS NOT NULL AND NOT EXISTS/);
  assert.strictEqual(called(/UPDATE auth_tokens SET used_at = now\(\) WHERE user_id = \$1 AND purpose = 'reset'/).length, 1);
  resetDb([[/UPDATE auth_tokens SET used_at = now\(\) WHERE token_hash/, [{ user_id: 7 }]]]); // the address was taken meanwhile
  assert.strictEqual((await call('get', '/confirm-email-change', { query: { token: 'b'.repeat(43) } })).redirected, '/app?email_changed=0');
  resetDb();
  assert.strictEqual((await call('get', '/confirm-email-change', { query: { token: 'not-a-token' } })).redirected, '/app?email_changed=0');
});
check('an account with no password is told to set one first', async () => {
  resetDb([meRows({ password_hash: null, oauth_provider: 'google' })]);
  const res = await call('post', '/change-email', signedIn({ body: { email: 'next4@example.com', password: PASSWORD } }));
  assert.strictEqual(res.code, 400);
  assert.match(res.body.error, /Google/);
});

section('L20: deleting an account');
check('it takes the account\'s own address typed out, and its password', async () => {
  resetDb([meRows()]);
  assert.strictEqual((await call('post', '/delete-account', signedIn({ body: { confirm: 'someone@else.com', password: PASSWORD } }))).code, 400);
  assert.strictEqual((await call('post', '/delete-account', signedIn({ body: { confirm: ME.email } }))).code, 400);
  assert.strictEqual((await call('post', '/delete-account', signedIn({ body: { confirm: ME.email, password: 'wrong' } }))).code, 401);
  assert.strictEqual(called(/DELETE FROM/).length, 0);
});
check('the account and the log of emails to its address go together, and the cookie is cleared', async () => {
  resetDb([meRows()]);
  const res = await call('post', '/delete-account', signedIn({ body: { confirm: ' Me@Example.com ', password: PASSWORD } }));
  assert.strictEqual(res.code, 200);
  const deletes = called(/DELETE FROM/).map((c) => c.sql);
  assert.deepStrictEqual(deletes, ['DELETE FROM email_log WHERE user_id = $1 OR LOWER(to_email) = LOWER($2)', 'DELETE FROM users WHERE id = $1']);
  assert.deepStrictEqual(res.cleared, [SESSION.COOKIE]);
});
check('every table that keeps a user\'s rows lets them go with the user', () => {
  const dir = path.join(__dirname, '..', 'server', 'migrations');
  const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const refs = [...sql.matchAll(/REFERENCES users\(id\)([^,\n]*)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 15, String(refs.length));
  for (const rule of refs) assert.match(rule, /ON DELETE (CASCADE|SET NULL)/, rule);
});
check('the only admin account cannot delete itself', async () => {
  resetDb([meRows({ is_admin: true }), [/SELECT count\(\*\)::int AS n FROM users WHERE is_admin AND id <> \$1/, [{ n: 0 }]]]);
  assert.strictEqual((await call('post', '/delete-account', signedIn({ body: { confirm: ME.email, password: PASSWORD } }))).code, 409);
  assert.strictEqual(called(/DELETE FROM/).length, 0);
  resetDb([meRows({ is_admin: true }), [/SELECT count\(\*\)::int AS n FROM users WHERE is_admin AND id <> \$1/, [{ n: 1 }]]]);
  assert.strictEqual((await call('post', '/delete-account', signedIn({ body: { confirm: ME.email, password: PASSWORD } }))).code, 200);
});
check('an account with no password must have signed in within the last few minutes', async () => {
  const old = new Date(Date.now() - (SESSION.REAUTH_MINUTES + 1) * 60_000);
  resetDb([meRows({ password_hash: null })]);
  assert.strictEqual((await call('post', '/delete-account', signedIn({ session: { id: 70, reauth_at: old }, body: { confirm: ME.email } }))).code, 403);
  resetDb([meRows({ password_hash: null })]);
  assert.strictEqual((await call('post', '/delete-account', signedIn({ body: { confirm: ME.email } }))).code, 200);
});

section('L19: the Terms and Privacy pages');
check('both pages are whole, name each other, and say where to write', () => {
  const L = require('../server/services/legalPages');
  for (const name of L.NAMES) {
    const html = L.render(name, 'help@seniq.example');
    assert.ok(!html.includes('{{') && html.includes('</html>'), name);
    assert.ok(html.includes('mailto:help@seniq.example'), name);
    assert.ok(html.includes('href="/terms"') && html.includes('href="/privacy"'), name);
  }
  assert.match(L.render('terms', null), /reply to any email SenIQ has sent you/);
  assert.match(L.render('terms', 'a@b.co'), /not investment advice/);
  assert.match(L.render('privacy', 'a@b.co'), /Delete Account/);
  assert.strictEqual(L.legalPage('admin'), null);
});
check('the address to write to: CONTACT_EMAIL, else the sender\'s, never the shared test sender', () => {
  const { contactAddress } = require('../server/services/legalPages');
  assert.strictEqual(contactAddress({ CONTACT_EMAIL: 'help@x.io' }, 'SenIQ <a@b.co>'), 'help@x.io');
  assert.strictEqual(contactAddress({}, 'SenIQ <a@b.co>'), 'a@b.co');
  assert.strictEqual(contactAddress({}, 'SenIQ <onboarding@resend.dev>'), null);
});
check('the landing page says its figures are sample data, and links both pages', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.html'), 'utf8');
  assert.match(html, /sample data for illustration, not live market data/);
  assert.ok(html.includes('href="/terms"') && html.includes('href="/privacy"'));
  assert.ok(!/LIVE FEED ACTIVE|A live preview|app\.seniq\.io/.test(html));
});

section('H2: the Congress poller with a live source');
check('a disclosure already old when first seen is stored without an alert', () => {
  const { isRecentDisclosure } = require('../server/services/smartMoney');
  const now = Date.parse('2026-10-12T06:00:00Z');
  assert.strictEqual(isRecentDisclosure({ disclosure_date: '2026-10-08' }, now), true);
  assert.strictEqual(isRecentDisclosure({ disclosure_date: '2026-09-01' }, now), false);
  assert.strictEqual(isRecentDisclosure({ disclosure_date: null, transaction_date: '2026-10-10' }, now), true);
  assert.strictEqual(isRecentDisclosure({ disclosure_date: null, transaction_date: null }, now), false);
  assert.ok(SMART_MONEY.CONGRESS_ALERT_DAYS >= 1 && SMART_MONEY.CONGRESS_ALERT_DAYS <= 14);
});
check('the source is asked a few times a day, not on every poll', async () => {
  // Two URLs a fetch: the day's calls must leave most of a free FMP key's 250 for prices.
  assert.ok((24 * 60 / SMART_MONEY.CONGRESS_FETCH_MINUTES) * 2 <= 50, String(SMART_MONEY.CONGRESS_FETCH_MINUTES));
  const { pollCongress } = require('../server/services/smartMoney');
  resetDb([[/SELECT count\(\*\)::int AS n FROM congress_trades/, [{ n: 5 }]]]);
  const warn = console.warn; console.warn = () => {};
  let first; let second;
  try { first = await pollCongress(); second = await pollCongress(); } finally { console.warn = warn; }
  assert.notStrictEqual(first.source, 'not due');
  assert.strictEqual(second.source, 'not due');
  assert.strictEqual(second.inserted, 0);
});

section('L22, L32');
check('Renaissance is listed under its chief executive, and Ask still knows the fund by its founder', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'migrations', '0046_renaissance_manager.sql'), 'utf8');
  assert.match(sql, /UPDATE institutions SET manager = 'Peter Brown' WHERE cik = '0001037389'/);
  const P = require('../server/services/pageTools');
  assert.ok(P.isPageQuestion('What does Simons hold?') && P.isPageQuestion('What is Renaissance Technologies buying?'));
});
check('a stored 13F is compared with the filing before it when it is read again', () => {
  const { diffChangeType } = require('../server/services/smartMoney');
  assert.strictEqual(diffChangeType(null, 'A', 10), 'baseline');
  assert.strictEqual(diffChangeType({ A: 10 }, 'B', 5), 'new');
  assert.strictEqual(diffChangeType({ A: 10 }, 'A', 12), 'added');
  assert.strictEqual(diffChangeType({ A: 10 }, 'A', 4), 'reduced');
  assert.strictEqual(diffChangeType({ A: 10 }, 'A', 10), 'unchanged');
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} account and closing checks passed`);
})();
