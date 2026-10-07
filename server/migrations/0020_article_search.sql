-- 0020 article full-text search — the lexical half of Ask's hybrid news search.
-- Embeddings match on meaning but are weak on exact names, tickers and numbers
-- ("Q2", "8-K", "Jio"); Postgres full-text covers those and needs no extension or
-- API token, so it works on every environment.
--   articles.search_tsv : title (weight A) + summary (weight B), kept current by
--                         Postgres itself (generated column) — no pipeline step.
-- Adding a stored generated column rewrites the table once; articles is small.

ALTER TABLE articles ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_articles_search_tsv ON articles USING GIN (search_tsv);
