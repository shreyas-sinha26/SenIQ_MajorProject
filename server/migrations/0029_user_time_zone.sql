-- 0029 user time zone — each user's own clock (services/userTime.js).
--   users.time_zone      : an IANA zone name ('Asia/Kolkata', 'America/New_York'), set from the
--                          browser at sign-in or chosen in Profile. A name, not an offset, so
--                          daylight saving is handled. NULL = not known yet: fall back to the
--                          zone of the user's market (home_market, or worked out from holdings).
--   report_sends.outcome : sent | skipped. The end-of-day report is skipped on a day with no
--                          trading and no new news; the row still claims the day so it is
--                          decided once.
-- What follows the user's clock: when reports go out, the date on the daily brief, and when
-- daily limits reset. What a market did on a day still follows the market's clock.

ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone TEXT;
ALTER TABLE report_sends ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'sent';
