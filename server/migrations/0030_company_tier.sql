-- 0030 company tier.
-- The company reference gains a second tier. 'curated' is the hand-written universe
-- (server/data/universe.js: aliases, brands, executives) that feeds entity resolution.
-- 'listed' is everything else a user may hold — the S&P 1500 and the Nifty 500, built from
-- published constituent lists (server/data/listed.json): symbol, name and sector only. A
-- listed company can be searched, added, priced and given its sector; in news it is matched
-- strictly, and only while someone holds it (entityResolver.js).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'curated';

ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_tier_chk;
ALTER TABLE companies
  ADD CONSTRAINT companies_tier_chk CHECK (tier IN ('curated', 'listed'));

CREATE INDEX IF NOT EXISTS idx_companies_tier ON companies(tier);
