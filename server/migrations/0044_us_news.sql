-- 0044 US coverage — company news for the US shares nobody holds (services/usNews.js).
--
-- The per-company fetch ran for held tickers only, so a US share nobody held had almost no
-- stories: the general feeds are Indian and crypto outlets. With US_LISTED_NEWS=1 the pipeline
-- takes those shares through Finnhub's company news a few at a time.
--
-- companies.news_checked_at: when the rotation last asked for this company's news. The next
--   batch is the names checked longest ago, never-checked first, so a restart carries on
--   where the last run stopped. Null for every name that is not in the rotation.
--
-- articles.feeds: the tickers whose company-news feed this story was fetched from. A US
--   listed name is tagged only on a story from its own feed (entityResolver), and a stored
--   story that later turns up in another ticker's feed is read once more for that ticker.
--   Empty for a story from a general feed, and for every story stored before this.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS news_checked_at TIMESTAMPTZ;
ALTER TABLE articles  ADD COLUMN IF NOT EXISTS feeds TEXT[] NOT NULL DEFAULT '{}';
