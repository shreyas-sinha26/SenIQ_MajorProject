-- 0036 IPO Watch — the pre-listing registry.
-- A company has no ticker before it lists, so news cannot reach it through the company
-- reference. The ipos table is its entry until then: headlines are matched to it by name,
-- and when it lists its row is linked to the ticker it was given.
--
-- aliases:  other names the news uses ("Jio" for Jio Platforms), added by hand.
-- symbol_checked_at: when the ticker was last looked up, so a listed issue with no ticker
--   found yet is asked about once a day, not on every run.
-- ipo_articles: which stored stories are about which issue, and what in the story matched.

ALTER TABLE ipos ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE ipos ADD COLUMN IF NOT EXISTS symbol_checked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ipo_articles (
  ipo_id     INTEGER NOT NULL REFERENCES ipos(id) ON DELETE CASCADE,
  article_id BIGINT  NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  matched_on TEXT    NOT NULL CHECK (matched_on IN ('name', 'alias')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ipo_id, article_id)
);
CREATE INDEX IF NOT EXISTS ipo_articles_article_idx ON ipo_articles (article_id);
