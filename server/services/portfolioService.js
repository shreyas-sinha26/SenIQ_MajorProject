/**
 * Portfolio weighting — the exposure weights that Portfolio Impact Scoring (the
 * North Star) is built on. Enriches a user's holdings with a live price, market
 * value, and two weights:
 *   - weight_pct:   true value/total, or null when a holding can't be priced
 *                   (this is what the portfolio UI shows — honest "N/A").
 *   - exposure_pct: same, but with an EQUAL-weight fallback so every holding has
 *                   *some* exposure for scoring (no Finnhub key / commodities /
 *                   India equities must not be invisible to impact scoring).
 */

const { query } = require('../db');
const { getQuotes } = require('./priceService');

async function getWeightedHoldings(userId) {
  const holdings = await query(
    `SELECT id, ticker, company_name, asset_class, exchange, quantity, cost_basis, added_at
       FROM portfolio WHERE user_id = $1 ORDER BY added_at DESC`,
    [userId]
  );
  if (holdings.length === 0) return [];

  const quotes = await getQuotes(holdings.map((h) => ({ ticker: h.ticker, assetClass: h.asset_class })));

  const enriched = holdings.map((h) => {
    const quote = quotes[h.ticker] || null;
    const price = quote ? quote.price : null;
    const qty = h.quantity != null ? Number(h.quantity) : null;
    const marketValue = price != null && qty != null ? price * qty : null;
    return {
      ...h,
      quantity: qty,
      cost_basis: h.cost_basis != null ? Number(h.cost_basis) : null,
      price,
      currency: quote ? quote.currency : null,
      market_value: marketValue,
      weight_pct: null,   // display: true value/total, null when unpriced
      exposure_pct: null, // scoring: same, but with an equal-weight fallback
    };
  });

  const round1 = (n) => Math.round(n * 10) / 10;

  // weight_pct (display): honest share of the *priced* portfolio; stays null when
  // a holding can't be priced.
  const totalValue = enriched.reduce((sum, h) => sum + (h.market_value || 0), 0);
  if (totalValue > 0) {
    for (const h of enriched) {
      if (h.market_value != null) h.weight_pct = round1((h.market_value / totalValue) * 100);
    }
  }

  // exposure_pct (scoring): a NORMALIZED share across ALL holdings that sums to
  // ~100, so impact can honestly read "affects N% of your portfolio". Unpriced
  // holdings are imputed the average priced value (equal weight if nothing prices)
  // so they're never invisible — but exposure is still a share, not a flat 100.
  const priced = enriched.filter((h) => h.market_value != null);
  const avgPriced = priced.length
    ? priced.reduce((s, h) => s + h.market_value, 0) / priced.length
    : 0;
  const imputedTotal = enriched.reduce(
    (sum, h) => sum + (h.market_value != null ? h.market_value : avgPriced),
    0
  );
  for (const h of enriched) {
    if (imputedTotal > 0) {
      const v = h.market_value != null ? h.market_value : avgPriced;
      h.exposure_pct = round1((v / imputedTotal) * 100);
    } else {
      h.exposure_pct = round1(100 / enriched.length);
    }
  }

  return enriched;
}

module.exports = { getWeightedHoldings };
