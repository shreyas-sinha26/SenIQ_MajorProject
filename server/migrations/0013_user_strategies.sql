-- Phase 7 — Your Strategies: saved strategies + per-strategy watchlists.
-- A saved strategy is either a Builder spec (kind='custom', spec JSONB) or a
-- configured preset (kind='registry', strategy_name + params). Live signals are
-- computed on read by the strategy service — nothing signal-related is stored.

CREATE TABLE IF NOT EXISTS user_strategies (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('custom', 'registry')),
  spec          JSONB,           -- Builder spec (kind='custom')
  strategy_name TEXT,            -- registry name (kind='registry')
  params        JSONB,           -- registry params (kind='registry')
  symbols       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{"symbol":"NVDA","exchange":"US"}, ...]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_strategies_user ON user_strategies(user_id);
