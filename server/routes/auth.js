const { asyncRouter } = require('../middleware/asyncRouter');
const bcrypt = require('bcryptjs');
const { queryOne } = require('../db');
const { makeLimiter } = require('../services/slidingWindow');
const { createToken, consumeToken } = require('../services/authTokens');
const { sendEmail, emailEnabled } = require('../services/emailService');
const { AUTH_LIMITS, APP_URL, SESSION } = require('../config');
const sessions = require('../services/sessions');
const { authMiddleware } = sessions;

const router = asyncRouter();
const isProd = process.env.NODE_ENV === 'production';

// ─── Phase 5: per-IP rate limits on credential endpoints ─────
// Same in-memory sliding window as the API keys — aimed at stuffing/spam,
// counters reset on restart (fine for that job).
const loginLimiter = makeLimiter(AUTH_LIMITS.LOGIN);
const resetLimiter = makeLimiter(AUTH_LIMITS.RESET);
function rateLimit(limiter) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const r = limiter.allow(ip);
    if (!r.allowed) {
      res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many attempts — please wait a bit and retry' });
    }
    next();
  };
}

const PROVIDER_LABEL = { google: 'Google', github: 'GitHub' };

const nowSeconds = () => Math.floor(Date.now() / 1000);

const validPassword = (p) => typeof p === 'string' && p.length >= AUTH_LIMITS.MIN_PASSWORD_CHARS && p.length <= AUTH_LIMITS.MAX_PASSWORD_CHARS;
const PASSWORD_RULE = `Password must be ${AUTH_LIMITS.MIN_PASSWORD_CHARS}–${AUTH_LIMITS.MAX_PASSWORD_CHARS} characters`;

// ─── POST /api/auth/signup ───────────────────────────────────
router.post('/signup', rateLimit(loginLimiter), async (req, res) => {
  try {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const { password } = body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_RULE });

    const existing = await queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const created = await queryOne(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, name]
    );

    // Best-effort verification email (Phase 5) — never blocks signup, and is
    // skipped entirely when no email provider is configured.
    if (emailEnabled()) {
      createToken(created.id, 'verify', AUTH_LIMITS.TOKEN_TTL_MIN.VERIFY)
        .then((tok) => sendEmail({
          to: email, kind: 'verify', userId: created.id,
          subject: 'Verify your SenIQ email',
          text: `Welcome to SenIQ, ${name}!\n\nConfirm this email address:\n${APP_URL}/api/auth/verify-email?token=${tok}\n\nThe link is valid for 24 hours. If you didn't create this account, ignore this email.`,
        }))
        .catch((err) => console.error('Verification email error:', err.message));
    }

    await sessions.startSession(res, created.id, req);
    res.status(201).json({ user: { id: created.id, email, name, subscription_tier: 'free', is_admin: false } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/login ────────────────────────────────────
router.post('/login', rateLimit(loginLimiter), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // OAuth-born accounts have no password until the user sets one.
    if (!user.password_hash) {
      const label = PROVIDER_LABEL[user.oauth_provider] || 'social';
      return res.status(401).json({
        error: `This account uses ${label} sign-in — use that button, or reset your password to add one.`,
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await sessions.startSession(res, user.id, req);
    res.json({ user: { id: user.id, email: user.email, name: user.name, subscription_tier: user.subscription_tier || 'free', is_admin: !!user.is_admin } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/logout ───────────────────────────────────
// Ends this session on the server, so a copy of its cookie stops working too.
router.post('/logout', async (req, res) => {
  try {
    const s = await sessions.findSession(sessions.readCookie(req, SESSION.COOKIE));
    if (s) await sessions.endSession(s.id);
    sessions.clearSessionCookie(res);
    res.json({ message: 'Signed out' });
  } catch (err) {
    console.error('Logout error:', err);
    sessions.clearSessionCookie(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/reauth ───────────────────────────────────
// Confirms the password inside a live session; sensitive actions accept it for
// SESSION.REAUTH_MINUTES (sessions.requireRecentAuth).
router.post('/reauth', authMiddleware, rateLimit(loginLimiter), async (req, res) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Password is required' });
    const user = await queryOne('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user || !user.password_hash) return res.status(400).json({ error: 'This account has no password — sign out and sign in again instead.' });
    if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Password is incorrect' });
    await sessions.markReauthenticated(req.session.id);
    res.json({ message: 'Confirmed' });
  } catch (err) {
    console.error('Reauth error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/auth/me ────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne('SELECT id, email, name, created_at, subscription_tier, is_admin FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/auth/me — update display name ────────────────
router.patch('/me', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const trimmed = name.trim();
    if (trimmed.length > 80) return res.status(400).json({ error: 'Name too long' });
    const user = await queryOne(
      'UPDATE users SET name = $1 WHERE id = $2 RETURNING id, email, name, created_at',
      [trimmed, req.user.id]
    );
    res.json({ user });
  } catch (err) {
    console.error('Update name error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/change-password ─────────────────────────
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword) return res.status(400).json({ error: 'New password is required' });
    if (!validPassword(newPassword)) return res.status(400).json({ error: `New ${PASSWORD_RULE.toLowerCase()}` });

    const user = await queryOne('SELECT id, email, name, password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // OAuth-born accounts (no password yet) may SET one here without a current
    // password — they're already authenticated. Everyone else must prove it.
    if (user.password_hash) {
      if (typeof currentPassword !== 'string' || !currentPassword) return res.status(400).json({ error: 'Current password is required' });
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await queryOne('UPDATE users SET password_hash = $1, password_changed_at = to_timestamp($2) WHERE id = $3', [hash, nowSeconds(), req.user.id]);
    // Every other session ends here; this one carries on.
    await sessions.endUserSessions(req.user.id, req.session.id);
    await sessions.markReauthenticated(req.session.id);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/forgot-password ──────────────────────────
// Always answers 200 with the same message (no account enumeration). With no
// email provider configured, dev builds return the link directly so the flow
// stays testable locally.
router.post('/forgot-password', rateLimit(resetLimiter), async (req, res) => {
  try {
    const { email } = req.body || {};
    if (typeof email !== 'string' || !email) return res.status(400).json({ error: 'Email is required' });

    const reply = { message: 'If that email is registered, a reset link is on its way.' };
    const user = await queryOne('SELECT id, name FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!user) return res.json(reply);

    const tok = await createToken(user.id, 'reset', AUTH_LIMITS.TOKEN_TTL_MIN.RESET);
    const link = `${APP_URL}/app?reset=${tok}`;
    const sent = await sendEmail({
      to: email, kind: 'reset', userId: user.id,
      subject: 'Reset your SenIQ password',
      text: `Hi ${user.name},\n\nReset your SenIQ password here:\n${link}\n\nThe link is valid for ${AUTH_LIMITS.TOKEN_TTL_MIN.RESET} minutes and works once. If you didn't request this, ignore this email — your password is unchanged.`,
    });

    if (!sent.delivered && !isProd) reply.devResetLink = link; // local dev without an email key
    res.json(reply);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/reset-password ───────────────────────────
router.post('/reset-password', rateLimit(loginLimiter), async (req, res) => {
  try {
    const { token: rawToken, password } = req.body || {};
    if (!rawToken || !password) return res.status(400).json({ error: 'Token and new password are required' });
    if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_RULE });

    const consumed = await consumeToken(rawToken, 'reset');
    if (!consumed) return res.status(400).json({ error: 'This reset link is invalid or has expired — request a new one' });

    const hash = await bcrypt.hash(password, 10);
    await queryOne('UPDATE users SET password_hash = $1, password_changed_at = to_timestamp($2) WHERE id = $3 RETURNING id',
      [hash, nowSeconds(), consumed.user_id]);
    // Whoever was signed in before the reset is signed out everywhere.
    await sessions.endUserSessions(consumed.user_id);
    res.json({ message: 'Password updated — you can sign in now.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/resend-verification ──────────────────────
// Alert emails only go to verified addresses, and anyone who signed up while no email
// provider was configured never got a link — this lets them ask for one. Signed-in only,
// sends to the account's own address, and shares the reset limiter.
router.post('/resend-verification', authMiddleware, rateLimit(resetLimiter), async (req, res) => {
  try {
    const user = await queryOne('SELECT id, email, name, email_verified FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified) return res.json({ message: 'Your email is already verified.', email_verified: true });
    if (!emailEnabled()) return res.status(503).json({ error: 'Email is not set up on this server yet.' });

    const tok = await createToken(user.id, 'verify', AUTH_LIMITS.TOKEN_TTL_MIN.VERIFY);
    const sent = await sendEmail({
      to: user.email, kind: 'verify', userId: user.id,
      subject: 'Verify your SenIQ email',
      text: `Hi ${user.name},\n\nConfirm this email address:\n${APP_URL}/api/auth/verify-email?token=${tok}\n\nThe link is valid for 24 hours. If you didn't ask for this, ignore this email.`,
    });
    if (!sent.delivered) return res.status(502).json({ error: 'The verification email could not be sent — try again shortly.' });
    res.json({ message: `Verification link sent to ${user.email}.`, email_verified: false });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/auth/verify-email?token=… ──────────────────────
// Landed from the signup email; redirects into the app either way.
router.get('/verify-email', async (req, res) => {
  try {
    const consumed = await consumeToken(String(req.query.token || ''), 'verify');
    if (!consumed) return res.redirect('/app?auth=login&oauth_error=' + encodeURIComponent('Verification link is invalid or expired'));
    await queryOne('UPDATE users SET email_verified = TRUE WHERE id = $1 RETURNING id', [consumed.user_id]);
    res.redirect('/app?verified=1');
  } catch (err) {
    console.error('Verify email error:', err);
    res.redirect('/app');
  }
});

module.exports = { router, authMiddleware };
