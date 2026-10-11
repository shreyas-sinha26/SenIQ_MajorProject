-- 0045 IPO Watch — company news for every US issue with a ticker, a share of them each run.
--
-- The pipeline asked Finnhub for the company news of the newest 10 US issues on every run, so
-- the rest never had a story to link. It now takes all of them (not a SPAC, not withdrawn) in
-- turn, a third each run (IPO_WATCH.MONITOR_RUNS).
--
-- ipos.news_checked_at: when the pipeline last asked for this issue's company news. A run
--   takes the issues asked for longest ago, never-asked first, so one cut short by a refusal
--   starts the next with the names it did not reach. Null for an issue that is not monitored.

ALTER TABLE ipos ADD COLUMN IF NOT EXISTS news_checked_at TIMESTAMPTZ;
