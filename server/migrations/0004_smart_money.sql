-- 0004 smart money — Phase 3: track where smart money moves (two tabs).
--
--   • Institutions (13F): SEC EDGAR is free. We poll each tracked fund's submissions
--     feed, parse the latest 13F-HR information table, and store per-holding rows with
--     a change vs the prior quarter. 13F is quarterly with a ~45-day legal lag, so we
--     keep BOTH the period-of-report (quarter end) and the filing date and surface them.
--   • Politicians (Congress): STOCK Act periodic transaction reports, from a free
--     community dataset (configurable URL) with a bundled sample fallback. Up to ~45-day
--     disclosure lag, so we keep BOTH the trade date and the disclosure date.
--
-- Every NEW filing/disclosure emits an instant alert (these events are rare + discrete,
-- so no spam) — scoped by default to followed entities + anything touching the user's
-- holdings (followed_entities). Pro/API users can also register outbound webhooks so
-- their own systems get POSTed the event.

-- ─── Tracked institutions (seeded with the launch top-10 13F filers) ──────────
CREATE TABLE IF NOT EXISTS institutions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cik         TEXT UNIQUE NOT NULL,          -- 10-digit zero-padded SEC Central Index Key
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  manager     TEXT NOT NULL DEFAULT '',       -- the famous person behind the fund
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per 13F filing we've ingested — lets the poller tell a NEW filing from one
-- it already has, and anchors holdings to a specific quarter.
CREATE TABLE IF NOT EXISTS institution_filings (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id   BIGINT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  accession        TEXT UNIQUE NOT NULL,      -- SEC accession number (the filing id)
  form             TEXT NOT NULL DEFAULT '13F-HR',
  period_of_report DATE,                       -- quarter end the holdings reflect
  filed_at         DATE,                       -- when it was actually filed (weeks later)
  holdings_count   INTEGER NOT NULL DEFAULT 0,
  total_value      NUMERIC NOT NULL DEFAULT 0, -- summed USD value of the reported book
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS institution_holdings (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id   BIGINT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  filing_id        BIGINT NOT NULL REFERENCES institution_filings(id) ON DELETE CASCADE,
  cusip            TEXT NOT NULL,
  ticker           TEXT,                       -- best-effort CUSIP→ticker (null if unmapped)
  issuer_name      TEXT NOT NULL DEFAULT '',
  shares           NUMERIC NOT NULL DEFAULT 0,
  value            NUMERIC NOT NULL DEFAULT 0, -- USD market value at quarter end
  pct_of_portfolio REAL NOT NULL DEFAULT 0,
  change_type      TEXT NOT NULL DEFAULT 'baseline', -- new|added|reduced|unchanged|baseline
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (filing_id, cusip)
);

-- ─── Congress (politicians) periodic transaction reports ──────────────────────
CREATE TABLE IF NOT EXISTS congress_trades (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id         TEXT UNIQUE NOT NULL,      -- stable dedupe key from the source
  politician        TEXT NOT NULL,
  chamber           TEXT NOT NULL DEFAULT 'house', -- house|senate
  party             TEXT,
  state             TEXT,
  ticker            TEXT,                       -- null when the asset isn't a listed equity
  asset_description TEXT NOT NULL DEFAULT '',
  transaction_type  TEXT NOT NULL DEFAULT 'buy', -- buy|sell|exchange
  transaction_date  DATE,                       -- when the trade actually happened
  disclosure_date   DATE,                       -- when it was disclosed (weeks later)
  amount_range      TEXT,                       -- e.g. "$1,001 - $15,000"
  amount_min        NUMERIC,
  amount_max        NUMERIC,
  is_sample         BOOLEAN NOT NULL DEFAULT false, -- bundled demo row, not a live disclosure
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Who each user follows (default alert scope = followed + holdings) ─────────
CREATE TABLE IF NOT EXISTS followed_entities (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,                    -- institution|politician
  entity_ref  TEXT NOT NULL,                    -- institution slug, or normalized politician name
  label       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, entity_type, entity_ref)
);

-- ─── Outbound webhooks (Pro/API tier) — the real "webhook" feature ────────────
-- SEC/Congress portals don't push; we emulate inbound via the poller. But Pro users
-- CAN register a URL we POST events to (HMAC-signed) so their systems react.
CREATE TABLE IF NOT EXISTS webhooks (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,                  -- shared secret for X-SenIQ-Signature (HMAC-SHA256)
  event_types   TEXT NOT NULL DEFAULT 'smart_money', -- csv of event types to deliver
  active        BOOLEAN NOT NULL DEFAULT true,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_status   INTEGER,
  last_attempt_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inst_holdings_filing ON institution_holdings(filing_id);
CREATE INDEX IF NOT EXISTS idx_inst_holdings_ticker ON institution_holdings(ticker);
CREATE INDEX IF NOT EXISTS idx_inst_filings_inst ON institution_filings(institution_id, period_of_report DESC);
CREATE INDEX IF NOT EXISTS idx_congress_ticker ON congress_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_congress_disclosure ON congress_trades(disclosure_date DESC);
CREATE INDEX IF NOT EXISTS idx_followed_user ON followed_entities(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);

-- ─── Seed the launch top-10 institutional filers (CIKs verified against EDGAR) ─
INSERT INTO institutions (cik, name, slug, manager) VALUES
  ('0001067983', 'Berkshire Hathaway',            'berkshire-hathaway',  'Warren Buffett'),
  ('0001697748', 'ARK Investment Management',     'ark-invest',          'Cathie Wood'),
  ('0001350694', 'Bridgewater Associates',        'bridgewater',         'Ray Dalio'),
  ('0001649339', 'Scion Asset Management',        'scion',               'Michael Burry'),
  ('0001167483', 'Tiger Global Management',       'tiger-global',        'Chase Coleman'),
  ('0001037389', 'Renaissance Technologies',      'renaissance',         'Jim Simons'),
  ('0001336528', 'Pershing Square Capital',       'pershing-square',     'Bill Ackman'),
  ('0001423053', 'Citadel Advisors',              'citadel',             'Ken Griffin'),
  ('0001179392', 'Two Sigma Investments',         'two-sigma',           'Two Sigma'),
  ('0001656456', 'Appaloosa',                     'appaloosa',           'David Tepper')
ON CONFLICT (cik) DO NOTHING;
