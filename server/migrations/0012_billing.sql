-- Phase 6 — Tiers & billing.
-- subscription_tier gates features (enforced in middleware/tier.js); is_admin unlocks the
-- tier switcher + admin endpoints. Tier is read from the DB per request (NOT baked into the
-- JWT) so an admin flip or a checkout takes effect immediately without re-login.

ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'free'
  CHECK (subscription_tier IN ('free', 'plus', 'pro'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Forward-compat for real Stripe/Razorpay wiring at deploy (unused by the dev stub):
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_period TEXT;       -- 'monthly' | 'annual'
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_country TEXT;           -- region gate (card BIN later)
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_provider TEXT;          -- 'stripe' | 'razorpay'
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_customer_id TEXT;
