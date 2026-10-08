-- 0025 report emails — scheduled summaries by email (services/reportEmails.js).
--   users.email_reports : the user's switch for report emails, separate from alert emails.
--                         Turned off by the unsubscribe link in every report or from Profile.
--   users.home_market   : 'IN' | 'US' — which market's morning the daily report is timed for.
--                         NULL = worked out from the portfolio each time.
--   report_sends        : one row per report per user per local day. Claimed BEFORE sending,
--                         so a report can never go out twice, whatever the scheduler does.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_reports BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_market TEXT CHECK (home_market IN ('IN', 'US'));

CREATE TABLE IF NOT EXISTS report_sends (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                 -- daily | weekly
  report_date DATE NOT NULL,                 -- the user's LOCAL date the report is for
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, report_date)
);
