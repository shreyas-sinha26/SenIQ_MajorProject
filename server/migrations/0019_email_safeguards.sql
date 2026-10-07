-- 0019 email safeguards — what has to exist before SenIQ emails real users.
--   users.email_alerts : the user's switch for alert emails. Turned off by the
--                        unsubscribe link in every alert email or from Profile.
--                        Verification and password-reset mail ignore it.
--   email_log          : one row per email sent, failed, or deliberately skipped
--                        (unverified address, unsubscribed). Without it there is
--                        no way to answer "did that alert reach them?".

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_alerts BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS email_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  to_email    TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- alert | verify | reset | other
  subject     TEXT,
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  reason      TEXT,                          -- http_422 | network | unverified | unsubscribed
  provider_id TEXT,                          -- the provider's message id, for tracing a bounce
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_log_user_created ON email_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_status_created ON email_log(status, created_at DESC);
