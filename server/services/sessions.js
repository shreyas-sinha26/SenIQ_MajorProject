/**
 * Browser sessions — who is signed in, kept on the server.
 *
 * The browser holds one cookie (HttpOnly, so page scripts cannot read it; SameSite=Lax;
 * Secure in production) carrying a random id. The sessions table holds that id's hash and
 * everything that decides whether it still works:
 *   - idle limit      unused for SESSION.IDLE_DAYS → over (each use pushes it back)
 *   - absolute limit  SESSION.ABSOLUTE_DAYS after sign-in → over, however active
 *   - revoked         sign-out ends that session; a password change or reset ends the others
 * Because the server decides on every request, ending a session takes effect at once — a
 * copied cookie stops working the moment its session is revoked.
 *
 * Cookies are sent by the browser on its own, so a state-changing request must also come
 * from this site (sameOriginGuard) — that is the CSRF defence, on top of SameSite=Lax.
 * Some actions additionally need the password to have been proven recently
 * (requireRecentAuth).
 *
 * API keys for /v1 and /mcp are a separate system and do not pass through here.
 */

const crypto = require('crypto');
const { SESSION, APP_URL } = require('../config');

const isProd = process.env.NODE_ENV === 'production';
const DAY_MS = 86_400_000;

const hashId = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const looksLikeId = (raw) => typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw);

function readCookie(req, name) {
  const raw = (req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

function setSessionCookie(res, raw) {
  res.cookie(SESSION.COOKIE, raw, { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: SESSION.ABSOLUTE_DAYS * DAY_MS });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION.COOKIE, { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' });
}

/**
 * Start a session for a user who has just proved who they are, and set its cookie.
 * Clears out that user's dead sessions on the way.
 */
async function startSession(res, userId, req = {}) {
  const { queryOne, execute } = require('../db');
  const raw = crypto.randomBytes(32).toString('base64url');
  await execute(
    `DELETE FROM sessions WHERE user_id = $1
        AND (expires_at < now() OR last_used_at < now() - ($2 || ' days')::interval
             OR revoked_at < now() - interval '30 days')`, [userId, String(SESSION.IDLE_DAYS)]);
  const row = await queryOne(
    `INSERT INTO sessions (user_id, token_hash, expires_at, reauth_at, user_agent, ip)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, now(), $4, $5) RETURNING id`,
    [userId, hashId(raw), String(SESSION.ABSOLUTE_DAYS),
      String((req.headers && req.headers['user-agent']) || '').slice(0, 300) || null,
      req.ip || (req.socket && req.socket.remoteAddress) || null]);
  setSessionCookie(res, raw);
  return row ? row.id : null;
}

// The live session for a cookie value, with its user. null when there is none.
async function findSession(raw) {
  if (!looksLikeId(raw)) return null;
  const { queryOne } = require('../db');
  return queryOne(
    `SELECT s.id, s.user_id, s.last_used_at, s.reauth_at,
            u.email, u.name, u.subscription_tier, u.is_admin, (u.password_hash IS NOT NULL) AS has_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_used_at > now() - ($2 || ' days')::interval`,
    [hashId(raw), String(SESSION.IDLE_DAYS)]);
}

async function endSession(sessionId) {
  const { execute } = require('../db');
  await execute('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}
// End every session a user has, except (optionally) the one making the request.
async function endUserSessions(userId, exceptSessionId = null) {
  const { execute } = require('../db');
  await execute(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::bigint IS NULL OR id <> $2)',
    [userId, exceptSessionId]);
}
async function markReauthenticated(sessionId) {
  const { execute } = require('../db');
  await execute('UPDATE sessions SET reauth_at = now() WHERE id = $1', [sessionId]);
}

// ─── Middleware: the signed-in check ─────────────────────────
// Sets req.user ({id, email, name}), req.userRow (tier fields, read by middleware/tier.js)
// and req.session ({id, reauth_at, has_password}). The idle clock is pushed back at most
// once every SESSION.TOUCH_MINUTES, so a busy page is not one write per request.
async function authMiddleware(req, res, next) {
  try {
    const s = await findSession(readCookie(req, SESSION.COOKIE));
    if (!s) return res.status(401).json({ error: 'Not signed in — please sign in again' });
    if (Date.now() - new Date(s.last_used_at).getTime() > SESSION.TOUCH_MINUTES * 60_000) {
      require('../db').execute('UPDATE sessions SET last_used_at = now() WHERE id = $1', [s.id]).catch(() => {});
    }
    req.user = { id: s.user_id, email: s.email, name: s.name };
    req.userRow = { subscription_tier: s.subscription_tier, is_admin: s.is_admin };
    req.session = { id: s.id, reauth_at: s.reauth_at, has_password: !!s.has_password };
    next();
  } catch (err) {
    next(err);
  }
}

// ─── Middleware: requests that change something must come from this site ──
// A browser attaches an Origin header to every cross-site request that can change state,
// so a foreign Origin is refused. No Origin means the caller is not a browser page (a
// script, a payment webhook) and carries no ambient cookie to abuse.
function allowedOrigins(req) {
  const out = new Set([`${req.protocol}://${req.get('host')}`]);
  try { out.add(new URL(APP_URL).origin); } catch { /* APP_URL unset or malformed */ }
  return out;
}
function sameOriginGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || allowedOrigins(req).has(origin)) return next();
  return res.status(403).json({ error: 'This request did not come from SenIQ' });
}

// ─── Middleware: the password was proven recently ────────────
// Use after authMiddleware on sensitive actions. 403 { reauth: true } tells the page to
// ask for the password (POST /api/auth/reauth) and retry; an account with no password
// (social sign-in only) is told to sign in again instead.
function requireRecentAuth(req, res, next) {
  const at = req.session && req.session.reauth_at ? new Date(req.session.reauth_at).getTime() : 0;
  if (Date.now() - at <= SESSION.REAUTH_MINUTES * 60_000) return next();
  return res.status(403).json({
    reauth: true,
    can_use_password: !!(req.session && req.session.has_password),
    error: req.session && req.session.has_password
      ? 'Confirm your password to continue.'
      : 'For this action, sign out and sign in again first.',
  });
}

module.exports = {
  startSession, findSession, endSession, endUserSessions, markReauthenticated,
  authMiddleware, sameOriginGuard, requireRecentAuth,
  readCookie, clearSessionCookie, hashId, looksLikeId,
};
