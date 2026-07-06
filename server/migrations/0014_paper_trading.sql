-- Phase 7 — Paper Trade: replay-from-inception deployments.
-- A deployment pins {strategy, symbol, cash} at a start date; positions/equity/
-- trades are recomputed on read by deterministically replaying deploy→today
-- through the sim engine. No trade state is stored. The strategy definition is
-- SNAPSHOTTED at deploy time so editing/deleting the saved strategy never
-- rewrites a running paper track record.

CREATE TABLE IF NOT EXISTS paper_deployments (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,             -- label at deploy time (from the saved strategy)
  kind           TEXT NOT NULL CHECK (kind IN ('custom', 'registry')),
  spec           JSONB,                     -- snapshot: Builder spec (kind='custom')
  strategy_name  TEXT,                      -- snapshot: registry name (kind='registry')
  params         JSONB,                     -- snapshot: registry params
  symbol         TEXT NOT NULL,
  exchange       TEXT NOT NULL DEFAULT 'US',
  initial_cash   NUMERIC NOT NULL DEFAULT 100000,
  deployed_at    DATE NOT NULL DEFAULT CURRENT_DATE,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  stopped_at     DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paper_deployments_user ON paper_deployments(user_id);
