-- 0007 persistent events (Engine Phase E1b — the keystone).
-- Until now a "story" was only a per-batch cluster_key on articles; impact and alerts
-- grouped article rows in memory each run. This promotes clusters to a DURABLE event:
-- a story is remembered across runs (a duplicate tomorrow joins the same event), with
-- aggregate fields (type, tier, importance, source_count, first/last seen, primary
-- ticker). Impact, alerts, and the feed now key off events, not article rows. This is
-- the foundation for event typing (E2), change-detection, and the daily report.

CREATE TABLE IF NOT EXISTS events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_key    TEXT UNIQUE NOT NULL,
  title          TEXT NOT NULL,
  url            TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT '',
  relevance_tier TEXT NOT NULL DEFAULT 'none',
  event_type     TEXT NOT NULL DEFAULT 'unknown',   -- filled by E2
  importance     REAL NOT NULL DEFAULT 0,
  primary_ticker TEXT,
  source_count   INTEGER NOT NULL DEFAULT 1,
  first_seen     TIMESTAMPTZ,
  last_seen      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_events_tier ON events(relevance_tier, last_seen DESC);

-- Articles attach to their event (set after the event is upserted each run).
ALTER TABLE articles ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_articles_event ON articles(event_id);

-- Portfolio impact now keyed on the event, not the representative article.
-- Existing rows are safe to clear — recomputeImpacts() repopulates every pass.
DELETE FROM event_portfolio_impact;
ALTER TABLE event_portfolio_impact ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE event_portfolio_impact DROP CONSTRAINT IF EXISTS event_portfolio_impact_user_id_article_id_key;
ALTER TABLE event_portfolio_impact DROP COLUMN IF EXISTS article_id;
ALTER TABLE event_portfolio_impact ADD CONSTRAINT uq_epi_user_event UNIQUE (user_id, event_id);
CREATE INDEX IF NOT EXISTS idx_epi_user_score ON event_portfolio_impact(user_id, impact_score DESC);

-- Alerts dedupe on the event (one alert per user per event).
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_user_event ON alerts(user_id, event_id);
