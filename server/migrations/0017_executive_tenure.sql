-- 0017 executive tenure + provenance.
-- The executives table only knew (name, ticker, role), so a CEO change left a stale
-- name with nothing to show it. This adds:
--   aliases   : headline short forms ("Musk", "Buffett") — matched whole-word and
--               case-sensitively by the entity resolver
--   as_of     : the date the entry was last checked against a source (NULL = never)
--   source    : where it was checked ('fmp' | 'yahoo' | 'web'; NULL = hand-curated, unchecked)
--   ended_on  : set when the person left the role. Former executives are KEPT so
--               transition and older headlines still resolve to the company.
-- Seeded on boot from server/data/executives.json — see seedUniverse().

ALTER TABLE executives ADD COLUMN IF NOT EXISTS aliases  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE executives ADD COLUMN IF NOT EXISTS as_of    DATE;
ALTER TABLE executives ADD COLUMN IF NOT EXISTS source   TEXT;
ALTER TABLE executives ADD COLUMN IF NOT EXISTS ended_on DATE;
