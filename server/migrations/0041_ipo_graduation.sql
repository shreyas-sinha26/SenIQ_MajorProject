-- 0041 IPO Watch — graduation, and the three-month return.
--
-- A company that has listed, and whose ticker a price confirms, graduates into the company
-- reference so it can be searched, held, priced and matched to news like any listed stock.
-- It gets a tier of its own, 'ipo': the 'listed' tier is rebuilt from server/data/listed.json
-- on every boot and any row not in that file is switched off, which would undo a graduation.
-- The seed leaves 'ipo' rows alone, and moves one to 'listed' when the file gains its ticker.
--
-- ipos.graduated_at:    when the issue's company entered the reference (or was found there).
-- ipos.graduation_note: why it did not — its ticker already belongs to another company.
-- ipo_outcomes.close_3m / ret_3m_pct: the close on the first trading day on or after
--   listing + 90 days, and its return over the issue price.

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_tier_chk;
ALTER TABLE companies ADD CONSTRAINT companies_tier_chk CHECK (tier IN ('curated', 'listed', 'ipo'));

ALTER TABLE ipos
  ADD COLUMN IF NOT EXISTS graduated_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS graduation_note TEXT;

ALTER TABLE ipo_outcomes
  ADD COLUMN IF NOT EXISTS close_3m   NUMERIC,
  ADD COLUMN IF NOT EXISTS ret_3m_pct NUMERIC;
