-- 0022 disclosures — company filings from the regulator (primary sources), kept apart from news.
-- News says what was reported; a filing is what the company itself told the market, on a
-- known date. They are stored separately on purpose: filings do not feed the sentiment
-- score, story clustering or alerts, which were tuned on news.
--   disclosures      : one row per filing. `items` are the form's own item codes (an 8-K's
--                      "2.02", "5.02"); `title` is those codes in plain words; `excerpt` is
--                      cleaned text from the main document and its press release.
--   disclosure_sync  : per-ticker fetch state, so filings are pulled lazily (only for
--                      tickers someone holds) and a ticker the regulator does not know is
--                      not asked about on every run.

CREATE TABLE IF NOT EXISTS disclosures (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      TEXT NOT NULL,                 -- 'sec'
  ticker      TEXT NOT NULL,
  accession   TEXT NOT NULL,                 -- the source's own filing id
  form        TEXT NOT NULL,                 -- 8-K, 8-K/A
  items       TEXT[] NOT NULL DEFAULT '{}',
  title       TEXT NOT NULL,
  filed_at    DATE NOT NULL,                 -- when it became public
  report_date DATE,                          -- the event date the filing reports
  url         TEXT NOT NULL,
  excerpt     TEXT NOT NULL DEFAULT '',
  search_tsv  tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(excerpt, '')), 'B')
              ) STORED,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, accession)
);
CREATE INDEX IF NOT EXISTS idx_disclosures_ticker ON disclosures(ticker, filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_disclosures_tsv ON disclosures USING GIN (search_tsv);

CREATE TABLE IF NOT EXISTS disclosure_sync (
  ticker       TEXT PRIMARY KEY,
  source       TEXT NOT NULL DEFAULT 'sec',
  source_id    TEXT,                         -- the regulator's company id (SEC CIK); NULL = not listed there
  last_checked TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT
);
