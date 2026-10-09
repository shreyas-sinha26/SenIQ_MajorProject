-- 0034 IPO Watch — outcomes.
-- What actually happened at listing, logged from day one so a listing-gain model has
-- something to learn from later (IPO_PLAN.md, Change 5). One row per issue, written the
-- first time a source reports its listing price and never rewritten.
--
-- This holds the label only. The features are joined at training time from where they
-- already live: the issue itself (ipos), its grey market series (ipo_gmp) and its
-- subscription series (ipo_subscriptions).

CREATE TABLE IF NOT EXISTS ipo_outcomes (
  ipo_id           INTEGER PRIMARY KEY REFERENCES ipos(id) ON DELETE CASCADE,
  issue_price      NUMERIC,                     -- top of the price band when the outcome was logged
  listing_price    NUMERIC NOT NULL,            -- ₹ per share, as the source reported it
  listing_gain_pct NUMERIC,                     -- (listing_price / issue_price − 1) × 100
  source           TEXT NOT NULL,
  logged_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
