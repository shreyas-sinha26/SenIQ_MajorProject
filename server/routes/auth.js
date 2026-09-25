const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { queryOne } = require('../db');
const { makeLimiter } = require('../services/slidingWindow');
const { createToken, consumeToken } = require('../services/authTokens');
const { sendEmail, emailEnabled } = require('../services/emailService');
const { AUTH_LIMITS, APP_URL } = require('../config');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
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

// ─── Middleware: Auth Guard ──────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── POST /api/auth/signup ───────────────────────────────────
router.post('/signup', rateLimit(loginLimiter), async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

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
          to: email,
          subject: 'Verify your SenIQ email',
          text: `Welcome to SenIQ, ${name}!\n\nConfirm this email address:\n${APP_URL}/api/auth/verify-email?token=${tok}\n\nThe link is valid for 24 hours. If you didn't create this account, ignore this email.`,
        }))
        .catch((err) => console.error('Verification email error:', err.message));
    }

    const token = jwt.sign({ id: created.id, email, name }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: created.id, email, name, subscription_tier: 'free', is_admin: false } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/login ────────────────────────────────────
router.post('/login', rateLimit(loginLimiter), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
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

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, subscription_tier: user.subscription_tier || 'free', is_admin: !!user.is_admin } });
  } catch (err) {
    console.error('Login error:', err);
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
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
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
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'New password is required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const user = await queryOne('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // OAuth-born accounts (no password yet) may SET one here without a current
    // password — they're already authenticated. Everyone else must prove it.
    if (user.password_hash) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await queryOne('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
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
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const reply = { message: 'If that email is registered, a reset link is on its way.' };
    const user = await queryOne('SELECT id, name FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!user) return res.json(reply);

    const tok = await createToken(user.id, 'reset', AUTH_LIMITS.TOKEN_TTL_MIN.RESET);
    const link = `${APP_URL}/app?reset=${tok}`;
    const sent = await sendEmail({
      to: email,
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
    const { token: rawToken, password } = req.body;
    if (!rawToken || !password) return res.status(400).json({ error: 'Token and new password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const consumed = await consumeToken(rawToken, 'reset');
    if (!consumed) return res.status(400).json({ error: 'This reset link is invalid or has expired — request a new one' });

    const hash = await bcrypt.hash(password, 10);
    await queryOne('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id', [hash, consumed.user_id]);
    res.json({ message: 'Password updated — you can sign in now.' });
  } catch (err) {
    console.error('Reset password error:', err);
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
