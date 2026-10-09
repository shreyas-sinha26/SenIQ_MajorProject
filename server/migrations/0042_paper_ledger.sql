-- 0042 Paper Trade — a stored ledger.
--
-- Until now a deployment's state existed only while someone looked at it: every read replayed
-- deploy→today through the engine and nothing was kept (0014). Two things were missing. A
-- fill could not tell anyone it happened, because nothing ran unless the page was open. And
-- the record was not fixed: a replay reads today's price history, so a price the data source
-- revised later (a split, a dividend adjustment) silently rewrote past trades.
--
-- A daily job (services/paperLedger.js) now replays each deployment and writes down what it
-- has not written before. Rows are append-only: a recorded fill or day is never updated.
--
-- paper_fills:  one row per simulated fill (entry or exit), as the engine reported it.
--   filled_on : the bar's date as the engine stamped it (the exchange's day).
--   notify    : 'pending' → to be emailed; 'sent'; 'skipped' (no address, switched off, not
--               Pro, too old by the time email worked); 'none' → recorded as history, never
--               meant to be emailed (the first pass over an older deployment).
-- paper_equity: the deployment's value at the close of each completed day.
-- paper_deployments.last_marked_at / last_mark_error: when the job last ran for this
--   deployment, and why it failed if it did (engine offline, no bars).
-- paper_deployments.ledger_closed_at: set once a stopped deployment has been recorded
--   through its stop date; the job then leaves it alone.
-- paper_deployments.ledger_note: set when a fresh replay no longer agrees with the fills
--   already recorded. The recorded ledger stands.

CREATE TABLE IF NOT EXISTS paper_fills (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deployment_id  INTEGER NOT NULL REFERENCES paper_deployments(id) ON DELETE CASCADE,
  filled_at      TIMESTAMPTZ NOT NULL,
  filled_on      DATE NOT NULL,
  side           TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  price          NUMERIC NOT NULL,
  charges        NUMERIC NOT NULL DEFAULT 0,
  notify         TEXT NOT NULL DEFAULT 'none' CHECK (notify IN ('pending', 'sent', 'skipped', 'none')),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, filled_at, side)
);

CREATE INDEX IF NOT EXISTS idx_paper_fills_pending ON paper_fills(notify) WHERE notify = 'pending';

CREATE TABLE IF NOT EXISTS paper_equity (
  deployment_id    INTEGER NOT NULL REFERENCES paper_deployments(id) ON DELETE CASCADE,
  day              DATE NOT NULL,
  equity           NUMERIC NOT NULL,
  cash             NUMERIC NOT NULL,
  positions_value  NUMERIC NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, day)
);

ALTER TABLE paper_deployments
  ADD COLUMN IF NOT EXISTS last_marked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_mark_error  TEXT,
  ADD COLUMN IF NOT EXISTS ledger_closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ledger_note      TEXT;
