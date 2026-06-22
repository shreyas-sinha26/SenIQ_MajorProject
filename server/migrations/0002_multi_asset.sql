-- 0002 multi-asset — portfolio holds more than equities, and captures position size.
-- asset_class drives symbol/price resolution + news matching; quantity/cost_basis
-- feed Portfolio Impact Scoring (exposure weights) starting in Phase 2.

ALTER TABLE portfolio
  ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'equity',
  ADD COLUMN IF NOT EXISTS exchange    TEXT,
  ADD COLUMN IF NOT EXISTS quantity    NUMERIC,
  ADD COLUMN IF NOT EXISTS cost_basis  NUMERIC;

-- Enum guard. fx/index are valid in the schema but gated off in v1 config.
ALTER TABLE portfolio
  DROP CONSTRAINT IF EXISTS portfolio_asset_class_chk;
ALTER TABLE portfolio
  ADD CONSTRAINT portfolio_asset_class_chk
  CHECK (asset_class IN ('equity', 'crypto', 'commodity', 'fx', 'index'));

CREATE INDEX IF NOT EXISTS idx_portfolio_asset_class ON portfolio(asset_class);
