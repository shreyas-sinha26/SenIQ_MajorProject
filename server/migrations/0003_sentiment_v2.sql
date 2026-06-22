-- 0003 sentiment v2 — multi-source ingestion + decay/z-score scoring + impact.
-- articles gain a platform tag (which surface a story came from); article_sentiments
-- gain per-row confidence + which model produced the score (lexicon vs finbert), so
-- the windowed engine can weight by confidence and the FinBERT batch pass can upsert
-- over the cheap lexicon scores. event_portfolio_impact holds the North Star output:
-- exposure-weighted impact of an event on a specific user's portfolio.

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'news';

ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_platform_chk;
ALTER TABLE articles
  ADD CONSTRAINT articles_platform_chk
  CHECK (platform IN ('news', 'reddit', 'x', 'macro'));

ALTER TABLE article_sentiments
  ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS model      TEXT NOT NULL DEFAULT 'lexicon';

-- One score per (article, ticker) so the FinBERT pass can upsert over the lexicon row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_article_sentiments_article_ticker
  ON article_sentiments(article_id, ticker);

-- Per-user, per-event portfolio impact (the North Star feed).
CREATE TABLE IF NOT EXISTS event_portfolio_impact (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id   BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  impact_score REAL NOT NULL,
  exposure_pct REAL NOT NULL DEFAULT 0,
  direction    TEXT NOT NULL DEFAULT 'neutral',
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_event_impact_user_score
  ON event_portfolio_impact(user_id, impact_score DESC);
CREATE INDEX IF NOT EXISTS idx_article_sentiments_created
  ON article_sentiments(created_at);
