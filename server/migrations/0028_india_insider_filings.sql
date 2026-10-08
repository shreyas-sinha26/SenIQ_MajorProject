-- 0028 India insider filings — NSE's insider-trading format from May 2026 ("PIT V2.0").
--
-- NSE now publishes each insider disclosure as a FILING: one whole-market list of filings,
-- each pointing to an XBRL file that holds the trades (person, quantity, value). The older
-- per-symbol route that 0027 was built on stops at April 2026. Trades still land in
-- india_insider_trades; this table records which filings have been read, so a filing is
-- fetched once even when it yields no trade.

CREATE TABLE IF NOT EXISTS india_insider_filings (
  app_id       TEXT PRIMARY KEY,               -- NSE's id for the filing
  ticker       TEXT NOT NULL,
  broadcast_at DATE,                            -- when the exchange published it
  trades       INTEGER NOT NULL DEFAULT 0,      -- trades parsed out of it
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS india_insider_filings_ticker_idx ON india_insider_filings (ticker, broadcast_at DESC);
