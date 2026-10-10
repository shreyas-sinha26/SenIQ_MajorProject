/**
 * Price Service
 * Best-effort current prices + day change, so a captured quantity becomes a real
 * exposure weight (the Portfolio Impact Scoring input) AND the UI can show a live
 * price next to each holding. Cheapest-viable sources:
 *   - crypto    → CoinGecko /simple/price (free, no key) + 24h change
 *   - Indian equities → Yahoo Finance chart endpoint (free, no key; the same data
 *                 yfinance reads), as TICKER.NS, or TICKER.BO for BSE. Quoted in INR.
 *   - other equities → Finnhub /quote (FINNHUB_API_KEY, generous free tier) if set;
 *                 Yahoo when Finnhub has no price; then Financial Modeling Prep (FMP_API_KEY)
 *   - commodity → Yahoo front-month futures (GC=F, CL=F, …); FMP as the fallback
 *                 (gold GCUSD works there; oil CLUSD is premium → null)
 *
 * Quotes carry their own currency. usdRates() gives the conversion portfolioService
 * needs to weigh an INR holding against a USD one.
 *
 * Yahoo's endpoint is unofficial: it can throttle or change without notice, and NSE/BSE
 * prices on it run about 15 minutes late. Its quotes are cached for PRICE_TTL_SLOW.
 *
 * ⚠️ FMP free tier is ~250 calls/day and is SHARED with the congress poller, so
 * FMP-sourced prices are cached longer (PRICE_TTL_FMP) to stay within budget. Add
 * a free FINNHUB_API_KEY for unthrottled live equity prices. Everything degrades to
 * a null price (shown as N/A) — listing a portfolio never depends on a third party.
 */

const { NON_EQUITY_ASSETS, coingeckoIdFor } = require('./assetRegistry');

const PRICE_TTL_FAST = 60_000;      // CoinGecko / Finnhub — generous limits
const PRICE_TTL_FMP = 5 * 60_000;   // FMP — protect the shared daily quota
const PRICE_TTL_SLOW = 5 * 60_000;  // Yahoo — unofficial endpoint, keep the request rate low
const FX_TTL = 60 * 60_000;
const MARKETS_TTL = 10 * 60_000;
const cache = new Map(); // ticker -> { price, currency, changePct, at, ttl }

// Commodity ticker → FMP symbol (the ones FMP serves on the free tier).
const COMMODITY_FMP = {
  XAU: 'GCUSD', GOLD: 'GCUSD', GC: 'GCUSD',
  XAG: 'SIUSD', SILVER: 'SIUSD', SI: 'SIUSD',
  XPT: 'PLUSD', XPD: 'PAUSD',
  WTI: 'CLUSD', OIL: 'CLUSD', CL: 'CLUSD', BRENT: 'BZUSD', NG: 'NGUSD',
};

// Commodity ticker → Yahoo front-month futures symbol.
const COMMODITY_YAHOO = {
  XAU: 'GC=F', GOLD: 'GC=F', GC: 'GC=F',
  XAG: 'SI=F', SILVER: 'SI=F', SI: 'SI=F',
  XPT: 'PL=F', XPD: 'PA=F', HG: 'HG=F', COPPER: 'HG=F',
  WTI: 'CL=F', OIL: 'CL=F', CL: 'CL=F', BRENT: 'BZ=F', NG: 'NG=F',
  ALUMINIUM: 'ALI=F', WHEAT: 'ZW=F', CORN: 'ZC=F', SOYBEAN: 'ZS=F',
  SUGAR: 'SB=F', COFFEE: 'KC=F', COTTON: 'CT=F', COCOA: 'CC=F',
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
    // h / l = the session's high and low (0 when Finnhub has none).
    return d && d.c ? { price: d.c, currency: 'USD', changePct: d.dp ?? null, dayHigh: d.h || null, dayLow: d.l || null } : null;
  } catch { return null; }
}

// ─── Yahoo Finance (Indian equities, commodities, FX) ────────
async function fetchYahoo(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const meta = (await res.json())?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== 'number' || !(price > 0)) return null;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    // The latest session's high and low, where the feed gives them.
    const range = (k) => (typeof meta[k] === 'number' && meta[k] > 0 ? meta[k] / (meta.currency === 'USX' ? 100 : 1) : null);
    const day = { dayHigh: range('regularMarketDayHigh'), dayLow: range('regularMarketDayLow') };
    // Grains, sugar, coffee and cotton are quoted in US cents ("USX"): a dollar price here.
    if (meta.currency === 'USX') {
      return { price: price / 100, currency: 'USD', changePct: typeof prev === 'number' && prev > 0 ? ((price - prev) / prev) * 100 : null, ...day };
    }
    return {
      price,
      currency: meta.currency || 'USD',
      changePct: typeof prev === 'number' && prev > 0 ? ((price - prev) / prev) * 100 : null,
      ...day,
    };
  } catch { return null; }
}

// Tickers are stored bare (TCS, RELIANCE), so the market comes from the holding's
// exchange, else from the company reference. → 'NSE' | 'BSE' | null (not Indian).
let marketsCache = { at: 0, byTicker: {} };
async function indianMarkets() {
  if (Date.now() - marketsCache.at < MARKETS_TTL) return marketsCache.byTicker;
  try {
    const rows = await require('../db').query("SELECT ticker, exchange FROM companies WHERE country = 'IN'");
    marketsCache = { at: Date.now(), byTicker: Object.fromEntries(rows.map((r) => [r.ticker, r.exchange === 'BSE' ? 'BSE' : 'NSE'])) };
  } catch { /* keep the last good map */ }
  return marketsCache.byTicker;
}
function indianMarketOf(h, markets) {
  const ex = String(h.exchange || '').toUpperCase();
  if (ex === 'NSE' || ex === 'BSE') return ex;
  return ex ? null : markets[h.ticker] || null;
}
// NSE first, BSE second (or the reverse for a BSE holding): some names list on one only.
async function fetchIndian(ticker, market) {
  const order = market === 'BSE' ? ['.BO', '.NS'] : ['.NS', '.BO'];
  return (await fetchYahoo(ticker + order[0])) || fetchYahoo(ticker + order[1]);
}

// How many units of each currency one US dollar buys ({ USD: 1, INR: 96.8 }); a
// currency with no rate available is left out.
const fxCache = new Map(); // currency -> { rate, at }
async function usdRates(currencies) {
  const out = { USD: 1 };
  await Promise.all([...new Set(currencies)].filter((c) => c && c !== 'USD').map(async (c) => {
    const hit = fxCache.get(c);
    if (hit && Date.now() - hit.at < FX_TTL) { out[c] = hit.rate; return; }
    const q = await fetchYahoo(`USD${c}=X`);
    if (q) { fxCache.set(c, { rate: q.price, at: Date.now() }); out[c] = q.price; }
    else if (hit) out[c] = hit.rate; // a stale rate beats no weight at all
  }));
  return out;
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
  const yahooFetches = [];                  // Promise<void>[]
  const markets = holdings.some((h) => h.assetClass === 'equity') ? await indianMarkets() : {};
  const queueFmp = (sym, ticker) => { fmpSymbols.push(sym); fmpSymbolToTicker[sym] = ticker; };

  for (const h of holdings) {
    const ticker = h.ticker;
    if (out[ticker] !== undefined) continue;

    const cached = getCached(ticker);
    if (cached) { out[ticker] = { price: cached.price, currency: cached.currency, changePct: cached.changePct ?? null, dayHigh: cached.dayHigh ?? null, dayLow: cached.dayLow ?? null }; continue; }

    if (h.assetClass === 'crypto') {
      const id = coingeckoIdFor(ticker);
      if (id) cryptoToFetch.push({ ticker, coingeckoId: id });
      else out[ticker] = null;
    } else if (h.assetClass === 'commodity') {
      const ySym = COMMODITY_YAHOO[ticker];
      const fSym = (COMMODITY_FMP[ticker] || NON_EQUITY_ASSETS[ticker]?.fmpSymbol);
      yahooFetches.push((async () => {
        let q = ySym ? await fetchYahoo(ySym) : null;
        let ttl = PRICE_TTL_SLOW;
        if (!q && fSym && fmpKey) { q = await fetchFmpOne(fSym, fmpKey); ttl = PRICE_TTL_FMP; }
        out[ticker] = q; setCached(ticker, q, ttl);
      })());
    } else if (h.assetClass === 'equity') {
      const inMarket = indianMarketOf(h, markets);
      if (inMarket) {
        yahooFetches.push(fetchIndian(ticker, inMarket).then((q) => { out[ticker] = q; setCached(ticker, q, PRICE_TTL_SLOW); }));
      } else if (finnhubKey) {
        finnhubFetches.push((async () => {
          let q = await fetchFinnhub(ticker, finnhubKey);
          let ttl = PRICE_TTL_FAST;
          if (!q) { q = await fetchYahoo(ticker); ttl = PRICE_TTL_SLOW; }
          out[ticker] = q; setCached(ticker, q, ttl);
        })());
      } else if (fmpKey) {
        queueFmp(ticker, ticker);
      } else {
        yahooFetches.push(fetchYahoo(ticker).then((q) => { out[ticker] = q; setCached(ticker, q, PRICE_TTL_SLOW); }));
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

  await Promise.allSettled([...finnhubFetches, ...yahooFetches, cryptoFetch, fmpFetch]);
  return out;
}

module.exports = { getQuotes, usdRates, fetchYahoo, indianMarketOf, indianMarkets, COMMODITY_YAHOO };
