-- 0032 IPO Watch — grey market premium (GMP).
-- GMP is what an issue's shares change hands for, above the issue price, in the unofficial
-- market before listing. It is hearsay compiled by aggregator sites, so every reading says
-- which source gave it and when it was fetched, and it is kept as a series — one reading
-- per issue, per source, per market day — so the trend can be shown, not only the last
-- number. A second poll on the same day replaces that day's reading.

CREATE TABLE IF NOT EXISTS ipo_gmp (
  id          SERIAL PRIMARY KEY,
  ipo_id      INTEGER NOT NULL REFERENCES ipos(id) ON DELETE CASCADE,
  observed_on DATE NOT NULL,                    -- the market day (Asia/Kolkata) of the reading
  gmp         NUMERIC NOT NULL,                 -- ₹ per share over the issue price; can be 0 or negative
  source      TEXT NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ipo_id, source, observed_on)
);
CREATE INDEX IF NOT EXISTS ipo_gmp_latest_idx ON ipo_gmp (ipo_id, observed_on DESC);
