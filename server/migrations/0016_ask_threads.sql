-- 0016 Ask threads (E6 v2) — saved conversations.
--
-- ask_threads  — one row per conversation ("New conversation" starts one). Title = the
--   first question. updated_at drives both the recent-threads list and retention: threads
--   untouched for QA.THREAD_RETENTION_DAYS are purged by the daily job.
-- ask_messages — the turns, in order. The server is the source of truth for follow-up
--   history (the client no longer sends it), so a forged "assistant said…" turn can't be
--   injected. Only the last QA.HISTORY_TURNS pairs are ever sent back to Claude.

CREATE TABLE IF NOT EXISTS ask_threads (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ask_threads_user ON ask_threads(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ask_threads_updated ON ask_threads(updated_at);

CREATE TABLE IF NOT EXISTS ask_messages (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id  BIGINT NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  writer     TEXT,                         -- assistant turns: claude | deterministic | scope
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ask_messages_thread ON ask_messages(thread_id, id);
