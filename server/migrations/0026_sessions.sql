-- Browser sign-in sessions (services/sessions.js). The browser holds a random id in an
-- HttpOnly cookie; only its SHA-256 is stored here, so a copy of this table cannot be used
-- to sign in. A session ends when it is revoked (sign-out, password change), when it has
-- gone unused for the idle limit, or at expires_at whatever the activity.
CREATE TABLE IF NOT EXISTS sessions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  reauth_at     TIMESTAMPTZ,            -- when the user last proved who they are in this session
  revoked_at    TIMESTAMPTZ,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
