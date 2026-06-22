-- 0001 init — baseline schema (ported from the original SQLite copilot.db)

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portfolio (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker       TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, ticker)
);

CREATE TABLE IF NOT EXISTS articles (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id  TEXT UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS article_sentiments (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id      BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  ticker          TEXT NOT NULL,
  sentiment_label TEXT NOT NULL DEFAULT 'neutral',
  sentiment_score REAL NOT NULL DEFAULT 0.5,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker          TEXT,
  article_id      BIGINT REFERENCES articles(id) ON DELETE SET NULL,
  alert_type      TEXT NOT NULL DEFAULT 'sentiment',
  sentiment_label TEXT,
  sentiment_score REAL,
  message         TEXT NOT NULL,
  read            BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker        TEXT NOT NULL,
  avg_sentiment REAL NOT NULL,
  article_count INTEGER NOT NULL DEFAULT 0,
  snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_user ON portfolio(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_ticker ON portfolio(ticker);
CREATE INDEX IF NOT EXISTS idx_article_sentiments_ticker ON article_sentiments(ticker);
CREATE INDEX IF NOT EXISTS idx_article_sentiments_article ON article_sentiments(article_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
CREATE INDEX IF NOT EXISTS idx_sentiment_snapshots_ticker ON sentiment_snapshots(ticker, snapshot_at);
