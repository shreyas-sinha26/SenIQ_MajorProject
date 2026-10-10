const { asyncRouter } = require('../middleware/asyncRouter');
const { query, queryOne, execute, tx } = require('../db');
const { getCompanyName } = require('../services/tickerMatcher');
const { resolveAsset, isLaunchAssetClass, isValidTicker } = require('../services/assetRegistry');
const { getWeightedHoldings } = require('../services/portfolioService');
const { getQuotes } = require('../services/priceService');
const { onboardHolding, buildCompanyBrief } = require('../services/onboarding');
const { authMiddleware } = require('./auth');
const { attachTier, upsell } = require('../middleware/tier');

const router = asyncRouter();

// All portfolio routes require auth + tier context (req.tier / req.tierCfg).
router.use(authMiddleware, attachTier);

// The largest quantity or per-unit cost a holding may carry. Far above any real position;
// its job is to stop a slip of the keyboard (or 1e30) from becoming 100% of the portfolio
// and pushing every other holding's weight to zero.
const MAX_AMOUNT = 1e12;
// How long an add waits for the new holding's price before answering without one.
const ADD_QUOTE_WAIT_MS = 4000;

// Parse an optional non-negative number; '' / null / undefined → null.
// Returns the sentinel `INVALID` for anything that isn't a valid number.
const INVALID = Symbol('invalid');
function parseOptionalNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return INVALID;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return INVALID;
  return n;
}

// The new holding's price, with a time limit: an add must not hang on a slow price source.
// → the quote, null when no source has a price, undefined when the lookup did not finish.
function quoteWithin(ticker, assetClass, exchange, ms = ADD_QUOTE_WAIT_MS) {
  const lookup = getQuotes([{ ticker, assetClass, exchange }]).then((q) => q[ticker] || null).catch(() => undefined);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
  return Promise.race([lookup, timeout]);
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
    if (typeof rawTicker !== 'string' && typeof rawTicker !== 'number') {
      return res.status(400).json({ error: 'That does not look like a ticker symbol — use letters and digits, e.g. AAPL or RELIANCE.' });
    }

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
    if (quantity === INVALID) return res.status(400).json({ error: 'Quantity must be a number from 0 to 1,000,000,000,000' });
    if (costBasis === INVALID) return res.status(400).json({ error: 'Cost basis must be a number from 0 to 1,000,000,000,000' });

    const companyName = name || (ref && ref.name) || getCompanyName(ticker);

    // The duplicate check, the plan's holdings limit and the insert run as one step per
    // user. Done apart, several adds sent at once all pass the same count and a Free
    // account ends up over its limit, or two adds of one symbol race into a database error.
    const cap = req.tierCfg?.maxHoldings ?? Infinity;
    const added = await tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`portfolio:${req.user.id}`]);
      const held = await client.query('SELECT ticker FROM portfolio WHERE user_id = $1', [req.user.id]);
      if (held.rows.some((r) => r.ticker === ticker)) return { status: 409, body: { error: `${ticker} already in portfolio` } };
      // Phase 6 — tier holdings cap (Free = 7; Plus/Pro unlimited).
      if (Number.isFinite(cap) && held.rows.length >= cap) {
        return { status: 402, body: upsell('plus', `Free plan is limited to ${cap} holdings. Upgrade to add more.`) };
      }
      const row = await client.query(
        `INSERT INTO portfolio (user_id, ticker, company_name, asset_class, exchange, quantity, cost_basis)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, monitoring_since`,
        [req.user.id, ticker, companyName, assetClass, exchange, quantity, costBasis]
      );
      return { created: row.rows[0] };
    });
    if (!added.created) return res.status(added.status).json(added.body);
    const { created } = added;

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

    // The page draws the new row from this answer, so it carries the price and coverage
    // the portfolio list would show for it.
    const quote = await quoteWithin(ticker, assetClass, exchange);
    if (quote) {
      holding.price = quote.price;
      holding.currency = quote.currency;
      holding.change_pct = quote.changePct != null ? Math.round(quote.changePct * 100) / 100 : null;
    }
    const curated = await queryOne("SELECT 1 AS yes FROM companies WHERE ticker = $1 AND is_active AND tier = 'curated'", [ticker]);
    holding.coverage = curated ? 'full' : 'basic';

    // A symbol in no company list with no price anywhere is most likely a typo. It is still
    // added — a real but obscure listing must not be refused — and the page says so.
    const warning = assetClass === 'equity' && !ref && quote === null
      ? `${ticker} is not in our company list and no price was found for it. If it is a typo, remove it and add the right symbol.`
      : null;
    res.status(201).json({ holding, brief, ...(warning ? { warning } : {}) });
  } catch (err) {
    // Two adds of one symbol that slipped past the check above: the table's own rule caught it.
    if (err && err.code === '23505') return res.status(409).json({ error: 'That holding is already in your portfolio' });
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
