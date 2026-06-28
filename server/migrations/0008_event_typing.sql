-- 0008 event typing + sectors (Engine Phase E2).
-- Articles carry the sector THEMES the resolver found ("IT sector", "banks"); events
-- aggregate them so a sector-wide story can touch a user's holdings in that sector
-- (relevance = SECTOR_RELEVANCE), not just exact-ticker matches. event_type itself
-- already exists on events (0007) and is filled by the typing pass in events.js.

ALTER TABLE articles ADD COLUMN IF NOT EXISTS sectors TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE events   ADD COLUMN IF NOT EXISTS sectors TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
