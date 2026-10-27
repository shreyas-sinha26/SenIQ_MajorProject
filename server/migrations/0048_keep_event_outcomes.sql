-- 0048 Event outcomes outlive their events.
--
-- event_outcomes.event_id referenced events(id) ON DELETE CASCADE, and events are removed
-- EVENTS.WINDOW_DAYS (7) after they were last seen (events.js), so every outcome went with
-- its event: the table only ever held about the last week, and the 1- and 3-day moves it
-- exists to collect never built up. An outcome row already copies what it needs from its
-- event (ticker, type, severity, sources, sentiment, z, impact, first_seen), and nothing
-- reads it through events, so the link is dropped. event_id stays the primary key: event
-- ids come from an identity column and are never reused.

ALTER TABLE event_outcomes DROP CONSTRAINT IF EXISTS event_outcomes_event_id_fkey;
