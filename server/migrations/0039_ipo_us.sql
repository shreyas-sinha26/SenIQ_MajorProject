-- 0039 IPO Watch — US issues.
-- The calendar gains a second market. A US issue comes from Finnhub's IPO calendar and is a
-- different shape from an Indian one: it has a ticker from the day it files and a status the
-- source states outright (filed / expected / priced / withdrawn), and it has no board, lot
-- size, grey market or subscription figures.
--
-- market:        'IN' or 'US'. The same company name may exist in both, so a row is now
--                unique on (market, name_key).
-- board:         India only (mainboard / sme); empty for the US.
-- source_status: the status as the source gave it; a US issue's stage is read from it.
-- status_date:   the day that status dates from when it is not a listing day — the filing
--                day of a filed issue, the withdrawal day of a withdrawn one.
-- shares, issue_size_usd: shares on offer and their total value in dollars.
-- is_spac:       a blank-check company (a shell that lists to buy a business later). Kept,
--                but left off the calendar unless asked for.

ALTER TABLE ipos ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'IN';
ALTER TABLE ipos DROP CONSTRAINT IF EXISTS ipos_market_chk;
ALTER TABLE ipos ADD CONSTRAINT ipos_market_chk CHECK (market IN ('IN', 'US'));

ALTER TABLE ipos ALTER COLUMN board DROP NOT NULL;
ALTER TABLE ipos DROP CONSTRAINT IF EXISTS ipos_board_check;
ALTER TABLE ipos ADD CONSTRAINT ipos_board_check
  CHECK ((market = 'IN' AND board IN ('mainboard', 'sme')) OR (market = 'US' AND board IS NULL));

ALTER TABLE ipos DROP CONSTRAINT IF EXISTS ipos_name_key_key;
ALTER TABLE ipos DROP CONSTRAINT IF EXISTS ipos_market_name_key;
ALTER TABLE ipos ADD CONSTRAINT ipos_market_name_key UNIQUE (market, name_key);

ALTER TABLE ipos
  ADD COLUMN IF NOT EXISTS source_status  TEXT,
  ADD COLUMN IF NOT EXISTS status_date    DATE,
  ADD COLUMN IF NOT EXISTS shares         BIGINT,
  ADD COLUMN IF NOT EXISTS issue_size_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS is_spac        BOOLEAN NOT NULL DEFAULT false;
