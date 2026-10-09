-- 0040 IPO Watch — when a US issue actually began trading.
-- Finnhub says when a US deal was priced, not when its shares first traded. The first day
-- the price feed has for the ticker is that day; it is kept here, the issue counts as
-- trading from then, and its outcome (first-day open and close, later closes) is measured
-- from it against the IPO price.

ALTER TABLE ipos ADD COLUMN IF NOT EXISTS first_trade_date DATE;
