/**
 * Price Service
 * Best-effort current prices + day change, so a captured quantity becomes a real
 * exposure weight (the Portfolio Impact Scoring input) AND the UI can show a live
 * price next to each holding. Cheapest-viable sources:
 *   - crypto    → CoinGecko /simple/price (free, no key) + 24h change
 *   - equities  → Finnhub /quote (FINNHUB_API_KEY, generous free tier) if set,
 *                 else Financial Modeling Prep batch /quote (FMP_API_KEY)
 *   - commodity → FMP batch /quote for the symbols it carries on the free tier
 *                 (gold GCUSD works; oil CLUSD is premium → null)
 *
 * ⚠️ FMP free tier is ~250 calls/day and is SHARED with the congress poller, so
 * FMP-sourced prices are cached longer (PRICE_TTL_FMP) to stay within budget. Add
 * a free FINNHUB_API_KEY for unthrottled live equity prices. Everything degrades to
 * a null price (shown as N/A) — listing a portfolio never depends on a third party.
 */

const { NON_EQUITY_ASSETS } = require('./assetRegistry');

const PRICE_TTL_FAST = 60_000;      // CoinGecko / Finnhub — generous limits
const PRICE_TTL_FMP = 5 * 60_000;   // FMP — protect the shared daily quota
const cache = new Map(); // ticker -> { price, currency, changePct, at, ttl }

// Commodity ticker → FMP symbol (the ones FMP serves on the free tier).
const COMMODITY_FMP = {
  XAU: 'GCUSD', GOLD: 'GCUSD', GC: 'GCUSD',
  XAG: 'SIUSD', SILVER: 'SIUSD', SI: 'SIUSD',
  XPT: 'PLUSD', XPD: 'PAUSD',
  WTI: 'CLUSD', OIL: 'CLUSD', CL: 'CLUSD', BRENT: 'BZUSD', NG: 'NGUSD',
};

function getCached(ticker) {
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < hit.ttl) return hit;
  return null;
}
function setCached(ticker, q, ttl) {
  if (q) cache.set(ticker, { ...q, at: Date.now(), ttl });
}

// ─── Finnhub (equities) ──────────────────────────────────────
async function fetchFinnhub(ticker, apiKey) {
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`);
    if (!res.ok) return null;
    const d = await res.json();
    // c = current price, dp = percent change. c:0 → can't price (e.g. non-US on free tier).
    return d && d.c ? { price: d.c, currency: 'USD', changePct: d.dp ?? null } : null;
  } catch { return null; }
}

// ─── FMP (equities + commodities) ────────────────────────────
// Free tier only serves the single-symbol /stable/quote (batch + multi-symbol are
// premium), so we fetch each symbol in parallel. Bounded by the PRICE_TTL_FMP cache.
async function fetchFmpOne(sym, apiKey) {
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(sym)}&apikey=${apiKey}`);
    if (!res.ok) return null;
    const rows = await res.json();
    const r = Array.isArray(rows) ? rows[0] : rows;
    return r && typeof r.price === 'number'
      ? { price: r.price, currency: 'USD', changePct: r.changePercentage ?? null }
      : null;
  } catch { return null; }
}
async function fetchFmp(symbols, apiKey) {
  const out = {}; // fmpSymbol -> { price, currency, changePct }
  if (!symbols.length || !apiKey) return out;
  await Promise.all(symbols.map(async (s) => { out[s] = await fetchFmpOne(s, apiKey); }));
  return out;
}

// ─── CoinGecko (crypto) ──────────────────────────────────────
async function fetchCrypto(ids) {
  if (!ids.length) return {};
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`
    );
    if (!res.ok) return {};
    return await res.json(); // { bitcoin: { usd: 123, usd_24h_change: -1.2 }, ... }
  } catch { return {}; }
}

/**
 * Resolve current prices for a set of holdings.
 * @returns {Promise<Record<string,{price,currency,changePct}|null>>}
 */
async function getQuotes(holdings) {
  const finnhubKey = process.env.FINNHUB_API_KEY || '';
  const fmpKey = process.env.FMP_API_KEY || '';
  const out = {};

  const cryptoToFetch = [];                 // [{ ticker, coingeckoId }]
  const finnhubFetches = [];                // Promise<void>[]
  const fmpSymbols = [];                    // ['GCUSD', ...] (commodities + equities w/o Finnhub)
  const fmpSymbolToTicker = {};             // fmpSymbol -> our ticker

  for (const h of holdings) {
    const ticker = h.ticker;
    if (out[ticker] !== undefined) continue;

    const cached = getCached(ticker);
    if (cached) { out[ticker] = { price: cached.price, currency: cached.currency, changePct: cached.changePct ?? null }; continue; }

    if (h.assetClass === 'crypto') {
      const id = NON_EQUITY_ASSETS[ticker]?.coingeckoId;
      if (id) cryptoToFetch.push({ ticker, coingeckoId: id });
      else out[ticker] = null;
    } else if (h.assetClass === 'commodity') {
      const sym = COMMODITY_FMP[ticker] || (NON_EQUITY_ASSETS[ticker]?.fmpSymbol);
      if (sym && fmpKey) { fmpSymbols.push(sym); fmpSymbolToTicker[sym] = ticker; }
      else out[ticker] = null;
    } else if (h.assetClass === 'equity') {
      if (finnhubKey) {
        finnhubFetches.push(fetchFinnhub(ticker, finnhubKey).then((q) => { out[ticker] = q; setCached(ticker, q, PRICE_TTL_FAST); }));
      } else if (fmpKey) {
        fmpSymbols.push(ticker); fmpSymbolToTicker[ticker] = ticker;
      } else {
        out[ticker] = null;
      }
    } else {
      out[ticker] = null; // fx / index / unknown
    }
  }

  const cryptoFetch = fetchCrypto(cryptoToFetch.map((c) => c.coingeckoId)).then((prices) => {
    for (const { ticker, coingeckoId } of cryptoToFetch) {
      const row = prices[coingeckoId];
      const q = row && row.usd ? { price: row.usd, currency: 'USD', changePct: row.usd_24h_change ?? null } : null;
      out[ticker] = q; setCached(ticker, q, PRICE_TTL_FAST);
    }
  });

  const fmpFetch = fetchFmp([...new Set(fmpSymbols)], fmpKey).then((quotes) => {
    for (const sym of Object.keys(fmpSymbolToTicker)) {
      const ticker = fmpSymbolToTicker[sym];
      const q = quotes[sym] || null;
      out[ticker] = q; setCached(ticker, q, PRICE_TTL_FMP);
    }
  });

  await Promise.allSettled([...finnhubFetches, cryptoFetch, fmpFetch]);
  return out;
}

module.exports = { getQuotes };
