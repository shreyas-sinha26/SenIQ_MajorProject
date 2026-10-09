-- 0031 IPO Watch — the calendar.
-- One row per Indian public issue (mainboard or SME), from the day a source first lists it
-- to after it lists. The lifecycle stage (upcoming / open / closed / listed) is worked out
-- from the dates on read (services/ipoWatch), never stored, so it cannot go stale.
--
-- A company has no ticker until it lists, so a row is keyed on its name (name_key: lower
-- case, company suffixes dropped). `symbol` is filled in when the exchange assigns one.
-- Every row says where it came from and when it was last fetched.

CREATE TABLE IF NOT EXISTS ipos (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  name_key       TEXT NOT NULL UNIQUE,
  board          TEXT NOT NULL CHECK (board IN ('mainboard', 'sme')),
  exchange       TEXT,                          -- 'BSE', 'NSE' or 'BSE, NSE'
  symbol         TEXT,                          -- null until the exchange assigns one
  open_date      DATE,
  close_date     DATE,
  allotment_date DATE,
  listing_date   DATE,
  price_low      NUMERIC,                       -- price band, ₹ per share
  price_high     NUMERIC,
  lot_size       INTEGER,                       -- shares in one retail lot
  issue_size_cr  NUMERIC,                       -- ₹ crore, whole issue
  fresh_issue_cr NUMERIC,                       -- ₹ crore raised by the company
  ofs_cr         NUMERIC,                       -- ₹ crore sold by existing holders
  withdrawn      BOOLEAN NOT NULL DEFAULT false,
  source         TEXT NOT NULL,                 -- the source that last updated the row
  source_ref     TEXT,                          -- that source's id or page for the issue
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ipos_open_date_idx ON ipos (open_date DESC NULLS FIRST);
CREATE INDEX IF NOT EXISTS ipos_listing_date_idx ON ipos (listing_date DESC NULLS LAST);
