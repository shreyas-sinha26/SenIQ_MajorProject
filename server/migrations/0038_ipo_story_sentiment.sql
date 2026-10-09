-- 0038 IPO Watch — the tone of each linked story.
-- article_sentiments holds a reading per TICKER, and an issue has none before it lists, so
-- a story about an IPO alone has no reading stored anywhere — and where one exists it is
-- about another company (Reliance, for a Jio Platforms story). The reading of a story as
-- news about the issue is kept here, on the link.
--
-- read_at marks a link as looked at; the sentiment columns stay empty when the story covers
-- several issues at once, since one reading of the whole text is about none of them.

ALTER TABLE ipo_articles
  ADD COLUMN IF NOT EXISTS sentiment_label      TEXT,
  ADD COLUMN IF NOT EXISTS sentiment_score      REAL,     -- 0 most negative, 0.5 neutral, 1 most positive
  ADD COLUMN IF NOT EXISTS sentiment_confidence REAL,
  ADD COLUMN IF NOT EXISTS sentiment_model      TEXT,     -- 'finbert' or 'lexicon'
  ADD COLUMN IF NOT EXISTS read_at              TIMESTAMPTZ;
