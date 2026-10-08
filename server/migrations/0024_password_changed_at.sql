-- Sessions end when the password changes: a session token issued before this moment is
-- refused (routes/auth.js authMiddleware). NULL = never changed since this column existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
