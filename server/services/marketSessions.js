/**
 * Market sessions — what each holding's market last did, read from the price feed.
 *
 * The end-of-day report goes out on the USER's clock, but a trading day belongs to the
 * MARKET. At 20:00 in Kolkata the NSE session of that day is over while New York has barely
 * opened, so "today's move" means a different session for each holding. This reads the last
 * COMPLETED session for a symbol from Yahoo's daily bars: its date in the exchange's own
 * zone, its move against the session before, and when it ended.
 *
 * No holiday list is kept: a market that was shut simply has no bar for the day, so its
 * last completed session is an earlier one. (A per-exchange calendar would still be useful
 * for SAYING why it was shut — "closed for Diwali" — if one is ever added.)
 *
 * Yahoo's endpoint is unofficial (see priceService.js); a failed read is null and the
 * holding falls back to its ordinary quote.
 */

const { localClock } = require('./userTime');
const { COMMODITY_YAHOO, indianMarketOf, indianMarkets } = require('./priceService');

const HOUR = 3600 * 1000;
const cache = new Map(); // symbol → { at, result }
const CACHE_MS = 5 * 60 * 1000;

/**
 * Pure: Yahoo's chart reply (daily bars) → the last completed session, or null.
 * → { date, changePct, close, endedAt (ms), inProgress, timeZone }
 * inProgress = a newer session is under way right now, so `date` is the one before it.
 */
function sessionFromChart(result, now = Date.now()) {
  const meta = result && result.meta;
  const stamps = (result && result.timestamp) || [];
  const closes = (result && result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  if (!meta || !stamps.length) return null;
  let bars = stamps.map((t, i) => ({ t: t * 1000, close: closes[i] })).filter((b) => typeof b.close === 'number' && b.close > 0);
  const period = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  const start = period ? period.start * 1000 : null;
  const end = period ? period.end * 1000 : null;

  // The newest bar is today's session still trading: it is not a completed session yet.
  let inProgress = false;
  if (bars.length && start != null && end != null && bars[bars.length - 1].t >= start && now < end) {
    bars = bars.slice(0, -1);
    inProgress = true;
  }
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const timeZone = meta.exchangeTimezoneName || 'UTC';
  // A bar is stamped at its session's open; the session is as long as the current one.
  const length = start != null && end != null ? end - start : 6.5 * HOUR;
  const endedAt = start != null && last.t >= start ? end : last.t + length;
  return {
    date: localClock(new Date(last.t), timeZone).date,
    changePct: Math.round(((last.close - prev.close) / prev.close) * 10000) / 100,
    close: last.close,
    endedAt,
    inProgress,
    timeZone,
  };
}

async function fetchSession(symbol, now = Date.now()) {
  const hit = cache.get(symbol);
  if (hit && now - hit.at < CACHE_MS) return hit.result;
  let result = null;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) result = sessionFromChart((await res.json())?.chart?.result?.[0], now);
  } catch { /* null */ }
  cache.set(symbol, { at: now, result });
  return result;
}

// Pure: the Yahoo symbols to try for a holding, and which market it trades in.
// → { market: 'IN' | 'US' | 'COMMODITY' | 'CRYPTO', symbols: [...] }
function marketOf(holding, indian = {}) {
  const cls = holding.asset_class || 'equity';
  if (cls === 'crypto') return { market: 'CRYPTO', symbols: [] };
  if (cls === 'commodity') {
    const sym = COMMODITY_YAHOO[String(holding.ticker).toUpperCase()];
    return { market: 'COMMODITY', symbols: sym ? [sym] : [] };
  }
  const ex = indianMarketOf(holding, indian);
  if (ex) return { market: 'IN', symbols: ex === 'BSE' ? [`${holding.ticker}.BO`, `${holding.ticker}.NS`] : [`${holding.ticker}.NS`, `${holding.ticker}.BO`] };
  return { market: 'US', symbols: [String(holding.ticker).replace(/\./g, '-')] }; // BRK.B → BRK-B
}

/**
 * The last completed session for each holding. → { TICKER: { market, session | null } }.
 * Crypto trades around the clock and has no session; its entry carries session: null.
 */
async function sessionsFor(holdings, { now = Date.now(), fetchFn = fetchSession } = {}) {
  const indian = await indianMarkets();
  const out = {};
  for (const h of holdings || []) {
    const { market, symbols } = marketOf(h, indian);
    let session = null;
    for (const sym of symbols) {
      session = await fetchFn(sym, now);
      if (session) break;
    }
    out[h.ticker] = { market, session };
  }
  return out;
}

module.exports = { sessionFromChart, fetchSession, marketOf, sessionsFor };
