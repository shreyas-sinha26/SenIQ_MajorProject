/**
 * Price Service
 * Best-effort current prices so a captured quantity becomes a real exposure
 * weight (the Portfolio Impact Scoring input). Cheapest-viable sources:
 *   - equities  → Finnhub /quote (needs FINNHUB_API_KEY)
 *   - crypto    → CoinGecko /simple/price (free, no key)
 *   - commodity/fx/index → no free spot source yet → null (surfaced as N/A)
 *
 * Everything degrades gracefully: a missing key, an offline source, or a bad
 * symbol yields a null price, never a thrown error — listing a portfolio must
 * not depend on a third-party API being up.
 */

const { NON_EQUITY_ASSETS } = require('./assetRegistry');

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // ticker -> { price, currency, at }

function getCached(ticker) {
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  return null;
}

async function fetchEquityQuote(ticker, apiKey) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    // Finnhub returns c:0 for symbols it can't price (e.g. non-US on free tier).
    return data && data.c ? { price: data.c, currency: 'USD' } : null;
  } catch {
    return null;
  }
}

async function fetchCryptoQuotes(ids) {
  if (ids.length === 0) return {};
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
    const res = await fetch(url);
    if (!res.ok) return {};
    return await res.json(); // { bitcoin: { usd: 12345 }, ... }
  } catch {
    return {};
  }
}

/**
 * Resolve current prices for a set of holdings.
 * @param {Array<{ticker, assetClass}>} holdings
 * @returns {Promise<Record<string, {price:number, currency:string}|null>>}
 */
async function getQuotes(holdings) {
  const apiKey = process.env.FINNHUB_API_KEY || '';
  const out = {};

  const cryptoToFetch = []; // [{ ticker, coingeckoId }]
  const equityFetches = []; // Promise<void>[]

  for (const h of holdings) {
    const ticker = h.ticker;
    if (out[ticker] !== undefined) continue; // dedupe

    const cached = getCached(ticker);
    if (cached) { out[ticker] = { price: cached.price, currency: cached.currency }; continue; }

    if (h.assetClass === 'crypto') {
      const id = NON_EQUITY_ASSETS[ticker]?.coingeckoId;
      if (id) cryptoToFetch.push({ ticker, coingeckoId: id });
      else out[ticker] = null;
    } else if (h.assetClass === 'equity' && apiKey) {
      equityFetches.push(
        fetchEquityQuote(ticker, apiKey).then((q) => {
          out[ticker] = q;
          if (q) cache.set(ticker, { ...q, at: Date.now() });
        })
      );
    } else {
      out[ticker] = null; // commodity/fx/index, or equity without an API key
    }
  }

  const cryptoFetch = fetchCryptoQuotes(cryptoToFetch.map((c) => c.coingeckoId)).then((prices) => {
    for (const { ticker, coingeckoId } of cryptoToFetch) {
      const usd = prices[coingeckoId]?.usd;
      const q = usd ? { price: usd, currency: 'USD' } : null;
      out[ticker] = q;
      if (q) cache.set(ticker, { ...q, at: Date.now() });
    }
  });

  await Promise.allSettled([...equityFetches, cryptoFetch]);
  return out;
}

module.exports = { getQuotes };
