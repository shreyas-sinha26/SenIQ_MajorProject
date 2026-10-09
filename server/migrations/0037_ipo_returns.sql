-- 0037 IPO Watch — returns after listing.
-- The rest of an issue's outcome: where the share closed on its listing day, a week later
-- and a month later, each as a return over the issue price. They need the issue's ticker
-- (0036) and are filled in one at a time as each day passes — each written once and then
-- left alone, like the listing result. open_listing_day is the price feed's own first trade,
-- kept beside the source's listing price rather than over it.
--
--   1 week  = the first trading day on or after listing day + 7
--   1 month = the first trading day on or after listing day + 30

ALTER TABLE ipo_outcomes
  ADD COLUMN IF NOT EXISTS open_listing_day    NUMERIC,
  ADD COLUMN IF NOT EXISTS close_listing_day   NUMERIC,
  ADD COLUMN IF NOT EXISTS close_1w            NUMERIC,
  ADD COLUMN IF NOT EXISTS close_1m            NUMERIC,
  ADD COLUMN IF NOT EXISTS ret_listing_day_pct NUMERIC,     -- (close / issue_price − 1) × 100
  ADD COLUMN IF NOT EXISTS ret_1w_pct          NUMERIC,
  ADD COLUMN IF NOT EXISTS ret_1m_pct          NUMERIC,
  ADD COLUMN IF NOT EXISTS returns_checked_at  TIMESTAMPTZ; -- last price lookup, so it is one a day
