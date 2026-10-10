-- 0043 News retention — what is kept once old stories are pruned (services/retention.js).
--
-- Until now every story was kept for good. Nothing the app shows reads one older than 90
-- days (the sentiment baseline, news search and Ask all stop there), but a strategy's SenIQ
-- sentiment factors read every day there is, and deleting an article deletes its readings
-- with it (article_sentiments cascades). So before a story goes, what the factors need from
-- it is added to its ticker's day here.
--
-- sentiment_daily: one row per ticker per day, holding the PRUNED stories' share of that day
--   as sums — never an average — so a day that still has some live stories adds up exactly:
--     n_articles : how many readings went
--     score_sum  : their scores added (the plain mean is score_sum / n_articles)
--     w_sum      : their weights added (source credibility × confidence, as signalHistory.js works it out)
--     w_score    : weight × score, added
--   A ticker's day as the factors see it = this row + whatever is still in article_sentiments.
--   `day` is the story's published day as the database session's clock had it when the story
--   was pruned, the same day the live query gives it.
--
-- ipo_news_summary: an issue's news as IPO Watch last showed it, written once, the first time
--   any of its stories is pruned (only after the issue is finished and off the calendar).
--   The listing-gain data set (IPO_PLAN.md, Change 5) reads it beside ipo_outcomes.
--
-- retention_runs: one row per run that removed something — what went, and the archive file
--   the removed stories were written to first.

CREATE TABLE IF NOT EXISTS sentiment_daily (
  ticker      TEXT             NOT NULL,
  day         DATE             NOT NULL,
  n_articles  INTEGER          NOT NULL CHECK (n_articles > 0),
  score_sum   DOUBLE PRECISION NOT NULL,
  w_sum       DOUBLE PRECISION NOT NULL,
  w_score     DOUBLE PRECISION NOT NULL,
  updated_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, day)
);

CREATE TABLE IF NOT EXISTS ipo_news_summary (
  ipo_id        INTEGER PRIMARY KEY REFERENCES ipos(id) ON DELETE CASCADE,
  stories       INTEGER NOT NULL,          -- linked to the issue
  stories_read  INTEGER NOT NULL,          -- of those, read for tone (about this issue alone, named in the headline)
  tone_score    REAL,                      -- 0–1, 0.5 neutral; null when none was read
  tone_label    TEXT,
  first_story   DATE,
  last_story    DATE,
  by_day        JSONB NOT NULL DEFAULT '[]',   -- [{ day, stories, score }], oldest first
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retention_runs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  unused_days      INTEGER NOT NULL,
  used_days        INTEGER NOT NULL,
  unused_deleted   INTEGER NOT NULL DEFAULT 0,
  used_deleted     INTEGER NOT NULL DEFAULT 0,
  readings_rolled  INTEGER NOT NULL DEFAULT 0,   -- article_sentiments rows added into sentiment_daily
  ticker_days      INTEGER NOT NULL DEFAULT 0,   -- sentiment_daily rows written or added to
  ipo_summaries    INTEGER NOT NULL DEFAULT 0,
  archive_file     TEXT,
  archive_sha256   TEXT,
  archive_bytes    BIGINT
);
