const { asyncRouter } = require('../middleware/asyncRouter');
const bcrypt = require('bcryptjs');
const { queryOne, execute, tx } = require('../db');
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
// Wrong guesses at the current password from inside a session, counted per account.
const passwordLimiter = makeLimiter(AUTH_LIMITS.LOGIN);
const byIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
const byUser = (req) => `user:${req.user.id}`;
function rateLimit(limiter, keyOf = byIp) {
  return (req, res, next) => {
    const r = limiter.allow(keyOf(req));
    if (!r.allowed) {
      res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many attempts — please wait a bit and retry' });
    }
    next();
  };
}

const PROVIDER_LABEL = { google: 'Google', github: 'GitHub' };

const nowSeconds = () => Math.floor(Date.now() / 1000);

// A display name: no control characters and none of the marks that reorder text on screen
// (a right-to-left override makes "evil‮nimda" read as "eviladmin"). Pure.
const cleanName = (raw) => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim() : '');

// What the page keeps about the signed-in user; the same from sign-up, sign-in and /me.
const USER_COLUMNS = 'id, email, name, created_at, subscription_tier, is_admin';

// Compared when the address is unknown or has no password, so that answer takes as long
// as a wrong password does: the timing told a caller which addresses have accounts.
const DUMMY_HASH = bcrypt.hashSync('no-such-account', 10);

const validEmail = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// One link or notice to an address per window, whoever asks for it: a form that sends
// mail to any address typed into it must not be a way to fill someone's inbox.
const mailLimiter = makeLimiter(AUTH_LIMITS.RESET);
const mailAllowed = (email) => mailLimiter.allow(`mail:${String(email).toLowerCase()}`).allowed;

// An account made by a confirmed sign-up that has not opened its link yet.
const awaitingConfirm = (user) => !!(user && user.confirm_required && !user.email_verified);

// The link that confirms an account's address. Not awaited by its callers: the answer must
// not take longer for an address that gets mail than for one that does not.
function sendConfirmLink(user) {
  return createToken(user.id, 'verify', AUTH_LIMITS.TOKEN_TTL_MIN.VERIFY)
    .then((tok) => sendEmail({
      to: user.email, kind: 'verify', userId: user.id,
      subject: 'Confirm your SenIQ email',
      text: `Hi ${user.name},\n\nConfirm this email address to finish creating your SenIQ account:\n${APP_URL}/api/auth/verify-email?token=${tok}\n\nThe link is valid for 24 hours and works once. If you didn't create this account, ignore this email and nothing will happen.`,
    }))
    .catch((err) => console.error('Confirmation email error:', err.message));
}

const validPassword = (p) => typeof p === 'string' && p.length >= AUTH_LIMITS.MIN_PASSWORD_CHARS && p.length <= AUTH_LIMITS.MAX_PASSWORD_CHARS;
const PASSWORD_RULE = `Password must be ${AUTH_LIMITS.MIN_PASSWORD_CHARS}–${AUTH_LIMITS.MAX_PASSWORD_CHARS} characters`;

// ─── POST /api/auth/signup ───────────────────────────────────
router.post('/signup', rateLimit(loginLimiter), async (req, res) => {
  try {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const name = cleanName(body.name).slice(0, 80);
    const { password } = body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_RULE });

    // Hashed before the address is looked up, so every answer below takes as long.
    const passwordHash = await bcrypt.hash(password, 10);
    const existing = await queryOne(
      'SELECT id, email, name, email_verified, confirm_required FROM users WHERE LOWER(email) = LOWER($1)', [email]);

    // With an email provider the address is confirmed before the account can be used, and
    // the answer is the same whether or not the address already has an account ("Email
    // already registered" told anyone who asked which addresses are SenIQ users). What
    // differs is the email: a link for a new sign-up, a notice for an existing account.
    if (emailEnabled()) {
      const reply = { confirm: true, email, message: `Check your inbox: we sent a link to ${email}. Open it to finish creating your account.` };
      if (!existing) {
        const created = await queryOne(
          `INSERT INTO users (email, password_hash, name, confirm_required) VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
          [email, passwordHash, name]);
        if (created && mailAllowed(email)) sendConfirmLink(created);
      } else if (awaitingConfirm(existing)) {
        // A sign-up that was never confirmed is started again: the link confirms the name
        // and password typed last, and the earlier link stops working (createToken).
        await execute('UPDATE users SET password_hash = $1, name = $2 WHERE id = $3', [passwordHash, name, existing.id]);
        if (mailAllowed(email)) sendConfirmLink({ id: existing.id, email: existing.email, name });
      } else if (mailAllowed(email)) {
        sendEmail({
          to: existing.email, kind: 'signup_existing', userId: existing.id,
          subject: 'You already have a SenIQ account',
          text: `Hi ${existing.name},\n\nSomeone tried to create a SenIQ account with this email address, and it already has one.\n\nIf that was you, sign in here:\n${APP_URL}/app?auth=login\nIf you have forgotten the password, choose "Forgot password" on that page.\n\nIf it was not you, ignore this email: nothing has changed.`,
        });
      }
      return res.status(202).json(reply);
    }

    // No email provider (local development): no link can be sent, so the account is
    // usable at once and an address that is taken is said to be.
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const created = await queryOne(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
      [email, passwordHash, name]
    );

    await sessions.startSession(res, created.id, req);
    res.status(201).json({ user: { id: created.id, email, name, created_at: created.created_at, subscription_tier: created.subscription_tier || 'free', is_admin: !!created.is_admin } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/login ────────────────────────────────────
router.post('/login', rateLimit(loginLimiter), async (req, res) => {
  try {
    const { password } = req.body || {};
    // Sign-up trims the address, so sign-in does too: a pasted trailing space is not a wrong password.
    const email = typeof (req.body || {}).email === 'string' ? req.body.email.trim() : '';
    if (typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // OAuth-born accounts have no password until the user sets one.
    if (!user.password_hash) {
      await bcrypt.compare(password, DUMMY_HASH);
      const label = PROVIDER_LABEL[user.oauth_provider] || 'social';
      return res.status(401).json({
        error: `This account uses ${label} sign-in — use that button, or reset your password to add one.`,
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Reached only with the right password, so it tells a stranger nothing. A new link goes
    // out with the refusal: the first one may have expired or been lost.
    if (awaitingConfirm(user)) {
      const resent = emailEnabled() && mailAllowed(user.email);
      if (resent) sendConfirmLink(user);
      return res.status(403).json({
        confirm: true,
        error: resent
          ? `Confirm your email address first. We have sent a new link to ${user.email}.`
          : `Confirm your email address first: open the link we sent to ${user.email}.`,
      });
    }

    await sessions.startSession(res, user.id, req);
    res.json({ user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at, subscription_tier: user.subscription_tier || 'free', is_admin: !!user.is_admin } });
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

// ─── GET /api/auth/session ───────────────────────────────────
// "Is anyone signed in?", asked by the page each time it loads. Always a 200: { user } or
// { user: null }. Asking /me for this made every signed-out page load log a 401.
router.get('/session', async (req, res) => {
  try {
    const s = await sessions.findSession(sessions.readCookie(req, SESSION.COOKIE));
    if (!s) return res.json({ user: null });
    const user = await queryOne(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [s.user_id]);
    res.json({ user: user || null });
  } catch (err) {
    console.error('Session check error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/auth/me ────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
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
    const trimmed = cleanName((req.body || {}).name);
    if (!trimmed) return res.status(400).json({ error: 'Name is required' });
    if (trimmed.length > 80) return res.status(400).json({ error: 'Name too long' });
    // The same columns as /me: the page replaces what it knows of the user with this.
    const user = await queryOne(
      `UPDATE users SET name = $1 WHERE id = $2 RETURNING ${USER_COLUMNS}`,
      [trimmed, req.user.id]
    );
    res.json({ user });
  } catch (err) {
    console.error('Update name error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/change-password ─────────────────────────
router.post('/change-password', authMiddleware, rateLimit(passwordLimiter, byUser), async (req, res) => {
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

    if (user.password_hash && await bcrypt.compare(newPassword, user.password_hash)) {
      return res.status(400).json({ error: 'The new password is the same as the current one' });
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
    const email = typeof (req.body || {}).email === 'string' ? req.body.email.trim() : '';
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const reply = { message: 'If that email is registered, a reset link is on its way.' };
    const user = await queryOne('SELECT id, name FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!user) return res.json(reply);

    const tok = await createToken(user.id, 'reset', AUTH_LIMITS.TOKEN_TTL_MIN.RESET);
    const link = `${APP_URL}/app?reset=${tok}`;
    const message = {
      to: email, kind: 'reset', userId: user.id,
      subject: 'Reset your SenIQ password',
      text: `Hi ${user.name},\n\nReset your SenIQ password here:\n${link}\n\nThe link is valid for ${AUTH_LIMITS.TOKEN_TTL_MIN.RESET} minutes and works once. If you didn't request this, ignore this email — your password is unchanged.`,
    };

    // In production the send runs after the answer. Waiting for the mail server made a
    // registered address answer seconds slower than an unknown one — the same message, but
    // the delay told a caller which addresses have accounts. sendEmail never throws and
    // records a failure in email_log.
    if (isProd) {
      sendEmail(message);
      return res.json(reply);
    }
    const sent = await sendEmail(message);
    if (!sent.delivered) reply.devResetLink = link; // local dev without a working email provider
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
    // The link went to the account's own address, so using it confirms that address too
    // (not when the link was shown on screen because no email provider is set up).
    await queryOne(
      `UPDATE users SET password_hash = $1, password_changed_at = to_timestamp($2),
              email_verified = email_verified OR $4 WHERE id = $3 RETURNING id`,
      [hash, nowSeconds(), consumed.user_id, emailEnabled()]);
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

// ─── POST /api/auth/change-email ─────────────────────────────
// Asks for the account's address to be changed. Nothing changes here: a link goes to the
// new address and a notice to the current one, and the address changes when the link is
// opened (GET /confirm-email-change). The answer is the same when the new address belongs
// to another account, which then gets no mail and never becomes this account's.
router.post('/change-email', authMiddleware, rateLimit(passwordLimiter, byUser), async (req, res) => {
  try {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || !validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!emailEnabled()) return res.status(503).json({ error: 'Email is not set up on this server yet, so a new address cannot be confirmed.' });

    const user = await queryOne('SELECT id, email, name, password_hash, oauth_provider FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.password_hash) {
      const label = PROVIDER_LABEL[user.oauth_provider] || 'social';
      return res.status(400).json({ error: `This account uses ${label} sign-in and has no password. Set a password first, then change the address.` });
    }
    if (typeof body.password !== 'string' || !body.password) return res.status(400).json({ error: 'Your password is required' });
    if (!(await bcrypt.compare(body.password, user.password_hash))) return res.status(401).json({ error: 'Password is incorrect' });
    if (email.toLowerCase() === user.email.toLowerCase()) return res.status(400).json({ error: 'That is already this account\'s address' });

    const reply = { message: `We sent a link to ${email}. Your address changes when you open it.` };
    const taken = await queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2', [email, user.id]);
    if (!taken && mailAllowed(email)) {
      await execute('UPDATE users SET pending_email = $1 WHERE id = $2', [email, user.id]);
      createToken(user.id, 'email_change', AUTH_LIMITS.TOKEN_TTL_MIN.VERIFY)
        .then((tok) => sendEmail({
          to: email, kind: 'email_change', userId: user.id,
          subject: 'Confirm your new SenIQ email',
          text: `Hi ${user.name},\n\nOpen this link to make this the email address of your SenIQ account:\n${APP_URL}/api/auth/confirm-email-change?token=${tok}\n\nThe link is valid for 24 hours and works once. If you didn't ask for this, ignore this email: the account keeps its current address.`,
        }))
        .catch((err) => console.error('Email change link error:', err.message));
      sendEmail({
        to: user.email, kind: 'email_change_notice', userId: user.id,
        subject: 'A change of your SenIQ email was requested',
        text: `Hi ${user.name},\n\nSomeone signed in to your SenIQ account asked to change its email address to ${email}.\n\nIf that was you, open the link we sent to the new address. Until then your account stays on this one.\n\nIf it was not you, change your password now:\n${APP_URL}/app`,
      });
    }
    res.json(reply);
  } catch (err) {
    console.error('Change email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/auth/confirm-email-change?token=… ──────────────
// Landed from the link sent to the new address. The address changes only if no other
// account took it in the meantime. Reset links already sent to the old address stop working.
router.get('/confirm-email-change', async (req, res) => {
  try {
    const consumed = await consumeToken(String(req.query.token || ''), 'email_change');
    const changed = consumed && await queryOne(
      `UPDATE users SET email = pending_email, pending_email = NULL, email_verified = TRUE
        WHERE id = $1 AND pending_email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users o WHERE LOWER(o.email) = LOWER(users.pending_email) AND o.id <> users.id)
        RETURNING id`, [consumed.user_id]);
    if (!changed) return res.redirect('/app?email_changed=0');
    await execute(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'reset' AND used_at IS NULL`, [changed.id]);
    res.redirect('/app?email_changed=1');
  } catch (err) {
    console.error('Confirm email change error:', err);
    res.redirect('/app?email_changed=0');
  }
});

// ─── POST /api/auth/delete-account ───────────────────────────
// Removes the account and everything kept for it: holdings, alerts, briefs, conversations,
// follows, webhooks, saved strategies, paper deployments, API keys and sessions go with the
// users row (ON DELETE CASCADE), and the log of emails sent to its address is removed here.
// What stays is the count and cost of its AI calls, with no user attached. The caller types
// the account's address, and its password when it has one; an account with no password
// (Google or GitHub only) must have signed in within the last SESSION.REAUTH_MINUTES.
router.post('/delete-account', authMiddleware, rateLimit(passwordLimiter, byUser), async (req, res) => {
  try {
    const body = req.body || {};
    const user = await queryOne('SELECT id, email, password_hash, is_admin FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (typeof body.confirm !== 'string' || body.confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
      return res.status(400).json({ error: 'Type this account\'s email address to confirm' });
    }
    if (user.password_hash) {
      if (typeof body.password !== 'string' || !body.password) return res.status(400).json({ error: 'Your password is required' });
      if (!(await bcrypt.compare(body.password, user.password_hash))) return res.status(401).json({ error: 'Password is incorrect' });
    } else {
      const at = req.session && req.session.reauth_at ? new Date(req.session.reauth_at).getTime() : 0;
      if (Date.now() - at > SESSION.REAUTH_MINUTES * 60_000) {
        return res.status(403).json({ error: `To delete this account, sign out, sign in again, and delete it within ${SESSION.REAUTH_MINUTES} minutes.` });
      }
    }
    if (user.is_admin) {
      const others = await queryOne('SELECT count(*)::int AS n FROM users WHERE is_admin AND id <> $1', [user.id]);
      if (!others || !others.n) return res.status(409).json({ error: 'This is the only admin account. Make another account an admin before deleting it.' });
    }

    await tx(async (client) => {
      await client.query('DELETE FROM email_log WHERE user_id = $1 OR LOWER(to_email) = LOWER($2)', [user.id, user.email]);
      await client.query('DELETE FROM users WHERE id = $1', [user.id]);
    });
    sessions.clearSessionCookie(res);
    res.json({ message: 'Your account and its data have been deleted.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { router, authMiddleware, cleanName };
