-- 0027 India smart money — the Indian side of the Institutions and Congress tabs.
--
--   • Institutions (India): NSE bulk and block deals. A bulk deal is one client trading
--     more than 0.5% of a company's shares in a day; a block deal is a large single trade
--     in the exchange's block window. NSE publishes both the same evening with the client
--     NAMED, so unlike a 13F there is almost no lag — but only the large trades show.
--   • "Congress" (India): there is no Indian equivalent of STOCK Act trade reports. The
--     closest disclosure by people with privileged information is SEBI's insider-trading
--     rule (PIT Regulation 7): promoters, directors and key managers report their trades
--     to the exchange, usually within two trading days.
--
-- The US tables (institutions, institution_filings, congress_trades) are US-shaped (CIK,
-- chamber, party) and are left alone. The investors users can follow are a short curated
-- list in server/data/indiaInvestors.js — a deal row stores the slug it matched.

CREATE TABLE IF NOT EXISTS india_deals (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     TEXT UNIQUE NOT NULL,          -- stable dedupe key built from the row
  deal_type     TEXT NOT NULL,                  -- bulk|block
  deal_date     DATE NOT NULL,
  ticker        TEXT NOT NULL,                  -- NSE symbol (our ticker)
  security_name TEXT NOT NULL DEFAULT '',
  client_name   TEXT NOT NULL,                  -- as the exchange reports it
  investor_slug TEXT,                           -- curated investor it matched, else null
  side          TEXT NOT NULL,                  -- buy|sell
  quantity      NUMERIC NOT NULL DEFAULT 0,
  price         NUMERIC NOT NULL DEFAULT 0,     -- INR, traded / weighted-average price
  value         NUMERIC NOT NULL DEFAULT 0,     -- INR, quantity × price
  remarks       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS india_deals_ticker_idx ON india_deals (ticker, deal_date DESC);
CREATE INDEX IF NOT EXISTS india_deals_date_idx ON india_deals (deal_date DESC);
CREATE INDEX IF NOT EXISTS india_deals_investor_idx ON india_deals (investor_slug) WHERE investor_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS india_insider_trades (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     TEXT UNIQUE NOT NULL,
  ticker        TEXT NOT NULL,
  company       TEXT NOT NULL DEFAULT '',
  person        TEXT NOT NULL,
  category      TEXT,                           -- Promoters, Director, Key Managerial Personnel, …
  security_type TEXT,                           -- Equity Shares, …
  mode          TEXT,                           -- Market Purchase, Market Sale, Off Market, ESOP, Gift, …
  side          TEXT NOT NULL DEFAULT 'other',  -- buy|sell|pledge|other
  quantity      NUMERIC,
  value         NUMERIC,                        -- INR
  shares_before NUMERIC,
  shares_after  NUMERIC,
  pct_before    REAL,
  pct_after     REAL,
  trade_from    DATE,                           -- when the trade happened (start of the range)
  trade_to      DATE,
  intimated_at  DATE,                           -- when the person told the company
  disclosed_at  DATE,                           -- when the exchange published it
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS india_insider_ticker_idx ON india_insider_trades (ticker, disclosed_at DESC);
CREATE INDEX IF NOT EXISTS india_insider_disclosed_idx ON india_insider_trades (disclosed_at DESC);

-- One row per symbol we have asked NSE about. No row = first contact, so that symbol's
-- history is ingested silently; the timestamp also orders the daily rotation.
CREATE TABLE IF NOT EXISTS india_insider_sync (
  ticker         TEXT PRIMARY KEY,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
