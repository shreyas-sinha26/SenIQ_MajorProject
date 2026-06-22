-- 0005 news relevance + de-spam (Phase 3.5).
-- The feed and the alert path both spammed: dedupe was URL/id-only (the same event
-- from ET/Mint/Moneycontrol/Reuters stored as 4 rows), and RSS pulled whole feeds so
-- generic filler reached every user. These columns let ingest FLAG each article's
-- relevance + cluster it with its duplicates, so the feed shows one card per real
-- event in three buckets (holdings / market / world) and alerts fire once per event.
--
-- Decision: keep ALL articles in the DB (so the 90-day z-score baseline + threshold
-- re-tuning survive) and filter on is_relevant at read time — nothing is dropped.

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS cluster_key    TEXT,
  ADD COLUMN IF NOT EXISTS relevance_tier TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS importance     REAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_relevant    BOOLEAN NOT NULL DEFAULT true;

-- holding = about a tracked company/asset; market = broad market-moving; world =
-- major world affairs that move markets; none = filtered out of the feed.
ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_relevance_tier_chk;
ALTER TABLE articles
  ADD CONSTRAINT articles_relevance_tier_chk
  CHECK (relevance_tier IN ('holding', 'market', 'world', 'none'));

-- One alert per (user, event-cluster): the dedupe key that stops N articles about
-- one event from firing N alerts. Existing rows get a NULL key (no back-dedupe).
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS cluster_key TEXT;

CREATE INDEX IF NOT EXISTS idx_articles_cluster ON articles(cluster_key);
CREATE INDEX IF NOT EXISTS idx_articles_relevance
  ON articles(relevance_tier, is_relevant, published_at DESC);
-- Fast "has this user already been alerted for this event?" lookups.
CREATE INDEX IF NOT EXISTS idx_alerts_user_cluster ON alerts(user_id, cluster_key);
