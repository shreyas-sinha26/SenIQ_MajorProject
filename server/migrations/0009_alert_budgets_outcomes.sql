-- 0009 alert budgets + outcome logging (Engine Phase E3).
-- Budgets: every material event still gets an alert row (nothing lost), but only the
-- top few per user per day are flagged 'realtime' (push-worthy); the rest are 'digest'
-- (batched), so a volatile day can't spam. `dismissed` captures the negative
-- engagement signal alongside `read` (opened) for future learning.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS delivery  TEXT NOT NULL DEFAULT 'realtime';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_delivery_chk;
ALTER TABLE alerts ADD CONSTRAINT alerts_delivery_chk CHECK (delivery IN ('realtime', 'digest'));
CREATE INDEX IF NOT EXISTS idx_alerts_user_delivery_created ON alerts(user_id, delivery, created_at);

-- One row per event: a snapshot of the features that drove our decision + the outcome
-- (did the primary ticker move materially in 1–3 days). This is the self-assembling
-- dataset the v2 supervised model trains on — no historical corpus needed.
CREATE TABLE IF NOT EXISTS event_outcomes (
  event_id         BIGINT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  primary_ticker   TEXT,
  event_type       TEXT,
  relevance_tier   TEXT,
  severity         REAL,
  source_count     INTEGER,
  sentiment_score  REAL,
  z_score          REAL,
  max_impact       REAL,
  price_at_event   REAL,
  price_1d         REAL,
  price_3d         REAL,
  move_1d          REAL,
  move_3d          REAL,
  materially_moved BOOLEAN,
  first_seen       TIMESTAMPTZ,
  logged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_1d_at   TIMESTAMPTZ,
  resolved_3d_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_event_outcomes_unresolved ON event_outcomes(first_seen) WHERE price_3d IS NULL;
