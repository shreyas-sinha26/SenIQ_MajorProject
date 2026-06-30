const express = require('express');
const { query, queryOne, execute } = require('../db');
const { getCompanyName } = require('../services/tickerMatcher');
const { resolveAsset, isLaunchAssetClass } = require('../services/assetRegistry');
const { getWeightedHoldings } = require('../services/portfolioService');
const { onboardHolding, buildCompanyBrief } = require('../services/onboarding');
const { authMiddleware } = require('./auth');
const { attachTier, upsell } = require('../middleware/tier');

const router = express.Router();

// All portfolio routes require auth + tier context (req.tier / req.tierCfg).
router.use(authMiddleware, attachTier);

// Parse an optional non-negative number; '' / null / undefined → null.
// Returns the sentinel `INVALID` for anything that isn't a valid number.
const INVALID = Symbol('invalid');
function parseOptionalNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return INVALID;
  return n;
}

// ─── GET /api/portfolio ──────────────────────────────────────
// Returns holdings enriched with a live price, market value, and a derived
// exposure weight (the Portfolio Impact Scoring input). Pricing is best-effort:
// holdings without quantity or an available price get null value/weight.
router.get('/', async (req, res) => {
  try {
    const holdings = await getWeightedHoldings(req.user.id);
    res.json({ holdings });
  } catch (err) {
    console.error('List portfolio error:', err);
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
});

// ─── POST /api/portfolio ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { ticker: rawTicker, asset_class: rawClass, exchange } = req.body;
    if (!rawTicker) return res.status(400).json({ error: 'Ticker is required' });

    const { ticker, assetClass, name } = resolveAsset(rawTicker, rawClass);

    if (!isLaunchAssetClass(assetClass)) {
      return res.status(400).json({
        error: `Unsupported asset class "${assetClass}". Supported: equity, crypto, commodity.`,
      });
    }

    const quantity = parseOptionalNumber(req.body.quantity);
    const costBasis = parseOptionalNumber(req.body.cost_basis);
    if (quantity === INVALID) return res.status(400).json({ error: 'Quantity must be a non-negative number' });
    if (costBasis === INVALID) return res.status(400).json({ error: 'Cost basis must be a non-negative number' });

    const companyName = name || getCompanyName(ticker);

    const existing = await queryOne(
      'SELECT id FROM portfolio WHERE user_id = $1 AND ticker = $2',
      [req.user.id, ticker]
    );
    if (existing) return res.status(409).json({ error: `${ticker} already in portfolio` });

    // Phase 6 — tier holdings cap (Free = 7; Plus/Pro unlimited).
    const cap = req.tierCfg?.maxHoldings ?? Infinity;
    if (Number.isFinite(cap)) {
      const { n } = await queryOne('SELECT count(*)::int AS n FROM portfolio WHERE user_id = $1', [req.user.id]);
      if (n >= cap) {
        return res.status(402).json(upsell('plus',
          `Free plan is limited to ${cap} holdings. Upgrade to add more.`));
      }
    }

    const created = await queryOne(
      `INSERT INTO portfolio (user_id, ticker, company_name, asset_class, exchange, quantity, cost_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, monitoring_since`,
      [req.user.id, ticker, companyName, assetClass, exchange || null, quantity, costBasis]
    );

    const holding = {
      id: created.id,
      ticker,
      company_name: companyName,
      asset_class: assetClass,
      exchange: exchange || null,
      quantity,
      cost_basis: costBasis,
      monitoring_since: created.monitoring_since,
    };

    // E4 onboarding: silent historical backfill (no alerts) + a deterministic company
    // brief. Best-effort — a failure here must never block the add itself.
    let brief = null;
    try {
      ({ brief } = await onboardHolding(req.user.id, ticker, holding));
    } catch (err) {
      console.error('Onboarding error:', err.message);
    }

    res.status(201).json({ holding, brief });
  } catch (err) {
    console.error('Add asset error:', err);
    res.status(500).json({ error: 'Failed to add asset' });
  }
});

// ─── GET /api/portfolio/:ticker/brief ────────────────────────
// Re-fetch the E4 company brief for a held ticker (same packet returned on add).
router.get('/:ticker/brief', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const holding = await queryOne(
      `SELECT company_name, asset_class, exchange, monitoring_since
         FROM portfolio WHERE user_id = $1 AND ticker = $2`,
      [req.user.id, ticker]
    );
    if (!holding) return res.status(404).json({ error: 'Asset not in portfolio' });
    const brief = await buildCompanyBrief(req.user.id, ticker, holding);
    res.json({ brief });
  } catch (err) {
    console.error('Brief error:', err);
    res.status(500).json({ error: 'Failed to build brief' });
  }
});

// ─── DELETE /api/portfolio/:ticker ───────────────────────────
router.delete('/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const result = await execute(
      'DELETE FROM portfolio WHERE user_id = $1 AND ticker = $2',
      [req.user.id, ticker]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Asset not in portfolio' });
    res.json({ message: `${ticker} removed from portfolio` });
  } catch (err) {
    console.error('Delete asset error:', err);
    res.status(500).json({ error: 'Failed to remove asset' });
  }
});

module.exports = router;
