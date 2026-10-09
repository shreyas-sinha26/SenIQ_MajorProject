const { asyncRouter } = require('../middleware/asyncRouter');
const { query, queryOne, execute } = require('../db');
const { getCompanyName } = require('../services/tickerMatcher');
const { resolveAsset, isLaunchAssetClass, isValidTicker } = require('../services/assetRegistry');
const { getWeightedHoldings } = require('../services/portfolioService');
const { onboardHolding, buildCompanyBrief } = require('../services/onboarding');
const { authMiddleware } = require('./auth');
const { attachTier, upsell } = require('../middleware/tier');

const router = asyncRouter();

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
    // coverage: 'full' for a ticker in the curated universe (aliases, executives, sector news),
    // 'basic' for anything else (matched on name and symbol only) — so thin news on such a
    // holding reads as a known limit, not a fault.
    const universe = new Set((await query("SELECT ticker FROM companies WHERE is_active AND tier = 'curated'")).map((r) => r.ticker));
    res.json({ holdings: holdings.map((h) => ({ ...h, coverage: universe.has(h.ticker) ? 'full' : 'basic' })) });
  } catch (err) {
    console.error('List portfolio error:', err);
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
});

// ─── GET /api/portfolio/search?q= ────────────────────────────
// The add-holding box: any company in the reference, curated or listed, by symbol or name.
// An exact symbol comes first, then symbols that start with the text, then names.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 40).replace(/[%_\\]/g, '\\$&');
    if (!q) return res.json({ results: [] });
    const results = await query(
      `SELECT ticker, name, asset_class, exchange, country, tier
         FROM companies
        WHERE is_active AND (ticker ILIKE $1 || '%' OR name ILIKE '%' || $1 || '%')
        ORDER BY (upper(ticker) = upper($1)) DESC, (ticker ILIKE $1 || '%') DESC,
                 (tier = 'curated') DESC, length(name), ticker
        LIMIT 8`,
      [q]
    );
    res.json({ results });
  } catch (err) {
    console.error('Asset search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── POST /api/portfolio ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { ticker: rawTicker, asset_class: rawClass } = req.body || {};
    if (!rawTicker) return res.status(400).json({ error: 'Ticker is required' });

    const { ticker, assetClass, name } = resolveAsset(rawTicker, rawClass);
    if (!isValidTicker(ticker)) {
      return res.status(400).json({ error: 'That does not look like a ticker symbol — use letters and digits, e.g. AAPL or RELIANCE.' });
    }
    // The company reference knows a listed stock's name and, for an Indian one, its exchange
    // (which is what prices it in rupees) — the client only sends the symbol.
    const ref = assetClass === 'equity' ? await queryOne('SELECT name, exchange, country FROM companies WHERE ticker = $1 AND is_active', [ticker]) : null;
    const exchange = req.body.exchange == null || req.body.exchange === ''
      ? (ref && ref.country === 'IN' ? ref.exchange : null) : String(req.body.exchange).trim().toUpperCase();
    if (exchange && !/^[A-Z]{1,12}$/.test(exchange)) return res.status(400).json({ error: 'Unknown exchange' });

    if (!isLaunchAssetClass(assetClass)) {
      return res.status(400).json({
        error: `Unsupported asset class "${assetClass}". Supported: equity, crypto, commodity.`,
      });
    }

    const quantity = parseOptionalNumber(req.body.quantity);
    const costBasis = parseOptionalNumber(req.body.cost_basis);
    if (quantity === INVALID) return res.status(400).json({ error: 'Quantity must be a non-negative number' });
    if (costBasis === INVALID) return res.status(400).json({ error: 'Cost basis must be a non-negative number' });

    const companyName = name || (ref && ref.name) || getCompanyName(ticker);

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
      [req.user.id, ticker, companyName, assetClass, exchange, quantity, costBasis]
    );

    const holding = {
      id: created.id,
      ticker,
      company_name: companyName,
      asset_class: assetClass,
      exchange,
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
