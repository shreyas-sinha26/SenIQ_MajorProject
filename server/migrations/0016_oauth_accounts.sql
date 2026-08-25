-- Phase 5 — Auth & Accounts (OAuth + password reset).
-- OAuth identities link to a user row by VERIFIED provider email so password and
-- Google/GitHub sign-in land on the same account. password_hash becomes nullable:
-- an OAuth-born account has no password until the user sets one (via reset or the
-- profile page). auth_tokens holds one-time email tokens (password reset + email
-- verification) — only the sha256 hash is stored, plaintext lives in the link.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider TEXT;   -- 'google' | 'github'
ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_sub TEXT;        -- provider's stable user id
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- One provider identity maps to exactly one account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth_identity
  ON users(oauth_provider, oauth_sub) WHERE oauth_sub IS NOT NULL;

-- Email lookups for OAuth linking are case-insensitive.
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('reset', 'verify')),
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 hex of the emailed token
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose);
