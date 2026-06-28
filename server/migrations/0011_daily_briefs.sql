-- 0011 daily briefs (Engine Phase E5) — the analyst voice.
--
-- E5 turns the engine's structured output into a human-readable daily brief written by
-- Claude (Haiku by default), grounded entirely in the user's own holdings. Two tables:
--
-- daily_briefs — one brief per user per day. Stores the grounding `packet` (so tomorrow's
--   "what changed since yesterday" diff has something to diff against) + the written
--   `narrative` + which writer produced it. Doubles as the cache: a day's brief is
--   generated once and re-read, never regenerated on demand.
--
-- claude_calls — a row per Claude API call (cost guardrail: log every call with tokens +
--   estimated cost). Drives the per-user daily quota and the global daily spend kill-switch
--   without a separate counter table — both are COUNT/SUM queries over this log.

CREATE TABLE IF NOT EXISTS daily_briefs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brief_date  DATE NOT NULL,
  packet      JSONB NOT NULL,             -- the grounding packet this brief was written from
  narrative   TEXT NOT NULL DEFAULT '',   -- the written brief
  headline    TEXT NOT NULL DEFAULT '',   -- the single most important thing (lead line)
  writer      TEXT NOT NULL DEFAULT 'deterministic', -- claude | ollama | deterministic
  model       TEXT,                        -- e.g. claude-haiku-4-5 (null for non-Claude)
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, brief_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_briefs_user ON daily_briefs(user_id, brief_date DESC);

CREATE TABLE IF NOT EXISTS claude_calls (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'daily_brief', -- what the call was for
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC NOT NULL DEFAULT 0,           -- estimated, from config pricing
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claude_calls_user_day ON claude_calls(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claude_calls_day ON claude_calls(created_at);
