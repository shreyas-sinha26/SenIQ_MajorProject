-- 0035 IPO Watch — outcomes when the source shows the gain but not the price.
-- On the source's page most listing prices are hidden (its host rewrites "L@74.20" as a
-- protected e-mail address), while the listing gain beside it stays readable. The gain is
-- the label that matters, so it is logged as given, and the price is worked back from the
-- issue price and marked as derived. A price can be missing only when the issue price is.

ALTER TABLE ipo_outcomes ALTER COLUMN listing_price DROP NOT NULL;
ALTER TABLE ipo_outcomes ADD COLUMN IF NOT EXISTS price_derived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ipo_outcomes DROP CONSTRAINT IF EXISTS ipo_outcomes_has_result_chk;
ALTER TABLE ipo_outcomes ADD CONSTRAINT ipo_outcomes_has_result_chk
  CHECK (listing_price IS NOT NULL OR listing_gain_pct IS NOT NULL);
