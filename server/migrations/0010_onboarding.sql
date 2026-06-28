-- 0010 onboarding (Engine Phase E4) — "adding a holding feels smart".
--
-- A per-holding "monitoring-since" watermark so a freshly-added holding never pings
-- the user about OLD news: an event can alert that holding only if it was first seen
-- at/after the moment the user started monitoring it. Older events still show in the
-- feed + the on-add company brief (silent historical backfill) — they just don't fire
-- an alert. Separate from added_at so the gate can be re-set later (e.g. re-arm) without
-- rewriting when the row was created.

ALTER TABLE portfolio
  ADD COLUMN IF NOT EXISTS monitoring_since TIMESTAMPTZ NOT NULL DEFAULT now();

-- Existing holdings: align the watermark with when they were actually added, so the
-- migration itself doesn't silence events that legitimately post-date the holding.
UPDATE portfolio SET monitoring_since = added_at WHERE monitoring_since > added_at;

CREATE INDEX IF NOT EXISTS idx_portfolio_monitoring ON portfolio(user_id, ticker, monitoring_since);
