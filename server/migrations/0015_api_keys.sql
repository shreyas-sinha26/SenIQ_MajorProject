-- Phase 8 — MCP server: per-user API keys.
-- Only a SHA-256 hash of the key is stored; the plaintext is shown once at
-- creation. key_prefix (first characters) lets the UI identify a key without
-- being able to reconstruct it. Revocation keeps the row (revoked_at set) so
-- the list explains itself; tier is NOT stored — it's read from users per
-- request, so a downgrade shuts keys off immediately.

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,   -- sha256 hex of the full key
  key_prefix   TEXT NOT NULL,          -- e.g. "seniq_ab12cd34" (display only)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
