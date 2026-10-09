-- 0033 IPO Watch — subscription.
-- How many times over an issue has been bid for, in total and by investor class: QIB
-- (institutions), NII (non-institutional, "HNI" — split into small and big where the source
-- gives it) and retail. 2.7 means bids for 2.7 times the shares on offer.
--
-- Kept as a series: one reading per issue, per source, per day of the figures themselves
-- (the source's own "as of" day, not the day we fetched), so the build-up over the days an
-- issue is open can be shown, and the final figure is stored once however often it is seen.

CREATE TABLE IF NOT EXISTS ipo_subscriptions (
  id          SERIAL PRIMARY KEY,
  ipo_id      INTEGER NOT NULL REFERENCES ipos(id) ON DELETE CASCADE,
  observed_on DATE NOT NULL,                    -- the day the figures are as of
  total       NUMERIC NOT NULL,                 -- times subscribed, whole issue
  qib         NUMERIC,
  nii         NUMERIC,
  nii_small   NUMERIC,                          -- "sHNI": bids of ₹2–10 lakh
  nii_big     NUMERIC,                          -- "bHNI": bids above ₹10 lakh
  retail      NUMERIC,
  source      TEXT NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ipo_id, source, observed_on)
);
CREATE INDEX IF NOT EXISTS ipo_subscriptions_latest_idx ON ipo_subscriptions (ipo_id, observed_on DESC);
