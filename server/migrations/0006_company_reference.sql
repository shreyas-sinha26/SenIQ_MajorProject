-- 0006 company reference (Engine Phase E1).
-- The curated universe that powers entity resolution: matching news to the right
-- ticker, a sector so sector-wide news touches holdings, and key executives so a
-- name like "Tim Cook" resolves to AAPL even with no ticker in the headline. This
-- replaces the brittle static alias map in tickerMatcher.js. Seeded on boot from
-- server/data/universe.js (idempotent upsert) — see seedUniverse() in entityResolver.js.

CREATE TABLE IF NOT EXISTS companies (
  ticker      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  sector      TEXT,
  asset_class TEXT NOT NULL DEFAULT 'equity',
  exchange    TEXT,
  country     TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS executives (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name TEXT NOT NULL,
  ticker    TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
  role      TEXT,
  UNIQUE (full_name, ticker)
);

CREATE INDEX IF NOT EXISTS idx_companies_sector ON companies(sector);
CREATE INDEX IF NOT EXISTS idx_executives_ticker ON executives(ticker);
