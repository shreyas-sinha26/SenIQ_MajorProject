/**
 * Phase 5 — OAuth sign-in (Google + GitHub), authorization-code flow.
 *
 *   GET /api/auth/oauth/:provider            → 302 to the provider's consent page
 *   GET /api/auth/oauth/:provider/callback   → code exchange → SenIQ JWT → /app?oauth=<jwt>
 *
 * Design notes:
 * - No SDKs: the exchanges are two fetch() calls per provider (Node ≥18).
 * - CSRF: `state` is a short-lived signed JWT carrying a nonce that must also
 *   match an HttpOnly SameSite=Lax cookie set at the start of the flow.
 * - Account model (per PLAN.md): a provider identity links to a user row by
 *   VERIFIED email, so password + Google land on the same account. We only
 *   trust emails the provider itself marks verified.
 * - OAuth-born accounts have password_hash = NULL; they can add a password
 *   later via reset or the profile page.
 * - Errors never 500 the browser: every failure redirects back to the login
 *   tab with a human-readable ?oauth_error=…
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { queryOne } = require('../db');
const { OAUTH, APP_URL } = require('../config');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const STATE_COOKIE = 'seniq_oauth_nonce';

const PROVIDERS = {
  google: {
    label: 'Google',
    cfg: () => OAUTH.GOOGLE,
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: OAUTH.GOOGLE.ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },
    // → { sub, email, emailVerified, name, avatar }
    async fetchProfile(code, redirectUri) {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: OAUTH.GOOGLE.ID,
          client_secret: OAUTH.GOOGLE.SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) throw new Error('Google rejected the sign-in code');
      const { access_token } = await tokenRes.json();
      if (!access_token) throw new Error('Google returned no access token');

      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!infoRes.ok) throw new Error('Could not read your Google profile');
      const p = await infoRes.json();
      return {
        sub: String(p.sub),
        email: (p.email || '').trim(),
        emailVerified: p.email_verified === true || p.email_verified === 'true',
        name: p.name || (p.email ? p.email.split('@')[0] : 'Google user'),
        avatar: p.picture || null,
      };
    },
  },

  github: {
    label: 'GitHub',
    cfg: () => OAUTH.GITHUB,
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: OAUTH.GITHUB.ID,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
      });
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async fetchProfile(code, redirectUri) {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: OAUTH.GITHUB.ID,
          client_secret: OAUTH.GITHUB.SECRET,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error('GitHub rejected the sign-in code');
      const { access_token } = await tokenRes.json();
      if (!access_token) throw new Error('GitHub returned no access token');

      const gh = { Authorization: `Bearer ${access_token}`, 'User-Agent': 'SenIQ', Accept: 'application/vnd.github+json' };
      const userRes = await fetch('https://api.github.com/user', { headers: gh });
      if (!userRes.ok) throw new Error('Could not read your GitHub profile');
      const u = await userRes.json();

      // The profile email is often private/null — the emails endpoint has the
      // verified primary, which is the only one we trust for account linking.
      let email = '';
      let emailVerified = false;
      const emailsRes = await fetch('https://api.github.com/user/emails', { headers: gh });
      if (emailsRes.ok) {
        const emails = await emailsRes.json();
        const primary = Array.isArray(emails)
          ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified)
          : null;
        if (primary) { email = primary.email; emailVerified = true; }
      }
      return {
        sub: String(u.id),
        email: (email || '').trim(),
        emailVerified,
        name: u.name || u.login || 'GitHub user',
        avatar: u.avatar_url || null,
      };
    },
  },
};

function redirectUriFor(provider) {
  return `${APP_URL}/api/auth/oauth/${provider}/callback`;
}

function failRedirect(res, message) {
  return res.redirect(`/app?auth=login&oauth_error=${encodeURIComponent(message)}`);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Find-or-create the user for a verified provider identity.
async function upsertOAuthUser(provider, profile) {
  // 1) Exact identity match — the normal repeat sign-in.
  let user = await queryOne(
    'SELECT * FROM users WHERE oauth_provider = $1 AND oauth_sub = $2',
    [provider, profile.sub]
  );
  if (user) {
    if (profile.avatar && profile.avatar !== user.avatar_url) {
      await queryOne('UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id', [profile.avatar, user.id]);
    }
    return user;
  }

  // Past this point we key on email, so it must be provider-verified.
  if (!profile.email || !profile.emailVerified) {
    throw new Error(`Your ${PROVIDERS[provider].label} account has no verified email — add one there and retry`);
  }

  // 2) Same verified email as an existing account → link (or just sign in if
  //    the row is already linked to another provider; we don't overwrite links).
  user = await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [profile.email]);
  if (user) {
    if (!user.oauth_provider) {
      await queryOne(
        `UPDATE users SET oauth_provider = $1, oauth_sub = $2,
                avatar_url = COALESCE(avatar_url, $3), email_verified = TRUE
          WHERE id = $4 RETURNING id`,
        [provider, profile.sub, profile.avatar, user.id]
      );
    }
    return user;
  }

  // 3) Brand-new user — no password until they set one.
  return queryOne(
    `INSERT INTO users (email, name, password_hash, oauth_provider, oauth_sub, avatar_url, email_verified)
     VALUES ($1, $2, NULL, $3, $4, $5, TRUE)
     RETURNING *`,
    [profile.email, profile.name.slice(0, 80), provider, profile.sub, profile.avatar]
  );
}

// ─── GET /api/auth/oauth/:provider — start the flow ─────────
router.get('/:provider', (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) return failRedirect(res, 'Unknown sign-in provider');
  if (!provider.cfg().enabled) {
    return failRedirect(res, `${provider.label} sign-in isn't configured on this server`);
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const state = jwt.sign(
    { purpose: 'oauth-state', provider: req.params.provider, nonce },
    JWT_SECRET,
    { expiresIn: `${OAUTH.STATE_TTL_MIN}m` }
  );
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${STATE_COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/api/auth/oauth; Max-Age=${OAUTH.STATE_TTL_MIN * 60}${secure}`
  );
  res.redirect(provider.authorizeUrl(state, redirectUriFor(req.params.provider)));
});

// ─── GET /api/auth/oauth/:provider/callback ──────────────────
router.get('/:provider/callback', async (req, res) => {
  const providerKey = req.params.provider;
  const provider = PROVIDERS[providerKey];
  if (!provider || !provider.cfg().enabled) return failRedirect(res, 'Unknown sign-in provider');

  try {
    const { code, state, error } = req.query;
    if (error) {
      // User hit "cancel" on the consent screen — not an error worth alarming over.
      const msg = error === 'access_denied' ? 'Sign-in was cancelled' : `Provider error: ${error}`;
      return failRedirect(res, msg);
    }
    if (!code || !state) return failRedirect(res, 'Sign-in response was incomplete — please retry');

    // CSRF guard: state must be our signed token AND echo the browser's cookie nonce.
    let decoded;
    try {
      decoded = jwt.verify(String(state), JWT_SECRET);
    } catch {
      return failRedirect(res, 'Sign-in link expired — please retry');
    }
    const cookieNonce = readCookie(req, STATE_COOKIE);
    if (decoded.purpose !== 'oauth-state' || decoded.provider !== providerKey ||
        !cookieNonce || decoded.nonce !== cookieNonce) {
      return failRedirect(res, 'Sign-in session mismatch — please retry');
    }
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth/oauth; Max-Age=0`);

    const profile = await provider.fetchProfile(String(code), redirectUriFor(providerKey));
    const user = await upsertOAuthUser(providerKey, profile);

    // Same JWT shape the password flow issues — everything downstream is identical.
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.redirect(`/app?oauth=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error(`OAuth ${providerKey} callback error:`, err.message);
    return failRedirect(res, err.message || 'Sign-in failed — please retry');
  }
});

module.exports = router;
