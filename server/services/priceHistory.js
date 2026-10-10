/**
 * What a price did over the past year, for Ask (plan step P4).
 *
 * Daily bars are fetched when a question asks, never stored, and never shown: no page, no
 * /mcp tool and no /v1 route carries them. What reaches the model is a set of figures worked
 * out here — the change over fixed periods, the highest and lowest price traded and the
 * highest and lowest close with their dates, the latest session's high and low, average
 * volume — and two short runs of closes. A year of daily bars would not fit a tool
 * result, and a model left to do the arithmetic gets it wrong.
 *
 * Shares and commodities come from Yahoo's chart route (the one priceService uses for Indian
 * quotes and IPO Watch for returns); coins from CoinGecko, which already prices them and
 * names each coin exactly where a Yahoo symbol can belong to another token.
 *
 * It describes what the price did. It calls no trend and makes no forecast.
 */

const { QA, IPO_WATCH } = require('../config');

const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
const px = (n) => round(n, n < 1 ? 6 : 2);
const addDays = (date, n) => new Date(Date.parse(date) + n * 86400e3).toISOString().slice(0, 10);

// ── Pure ──

// Yahoo's chart reply → { currency, bars: [{ date, close, high, low, volume }] }, oldest first, in the
// exchange's own dates. A day's open is not read: nobody asks for it. Days with no close are dropped. A price in US cents ("USX": grains,
// sugar, coffee, cotton) becomes dollars. Pure.
function parseYahoo(json) {
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r || !q || !Array.isArray(r.timestamp)) return { currency: null, bars: [] };
  const offset = (r.meta?.gmtoffset || 0) * 1000;
  const cents = r.meta?.currency === 'USX';
  const bars = r.timestamp
    .map((t, i) => ({ date: new Date(t * 1000 + offset).toISOString().slice(0, 10), close: q.close?.[i], high: q.high?.[i], low: q.low?.[i], volume: q.volume?.[i] }))
    .filter((b) => typeof b.close === 'number' && b.close > 0)
    .map((b) => {
      const price = (v) => (typeof v === 'number' && v > 0 ? px(cents ? v / 100 : v) : null);
      return { date: b.date, close: price(b.close), high: price(b.high), low: price(b.low), volume: typeof b.volume === 'number' && b.volume > 0 ? b.volume : null };
    });
  return { currency: cents ? 'USD' : r.meta?.currency || null, bars };
}

// CoinGecko's market_chart reply → the same shape, one bar a UTC day (the last reading of
// a day wins: the final point is "now"). Volume there is the day's traded value in USD. It
// gives one reading a day and no high or low, so a coin's bars carry none. Pure.
function parseCoinGecko(json) {
  const byDay = new Map();
  const vols = new Map((json?.total_volumes || []).map(([t, v]) => [new Date(t).toISOString().slice(0, 10), v]));
  for (const [t, p] of json?.prices || []) {
    if (typeof p !== 'number' || !(p > 0)) continue;
    const date = new Date(t).toISOString().slice(0, 10);
    byDay.set(date, { date, close: px(p), high: null, low: null, volume: typeof vols.get(date) === 'number' && vols.get(date) > 0 ? Math.round(vols.get(date)) : null });
  }
  return { currency: 'USD', bars: [...byDay.values()] };
}

/**
 * The figures Ask may quote, from daily bars (oldest first). Pure.
 * A change is measured from the last session on or before the day that far back; where the
 * history starts a few days short of it, from the first session. A period the history does
 * not reach is null, and `history_starts` says when it begins. `year_to_date` is measured
 * from the last close of the calendar year before.
 */
function summarize(bars) {
  if (!bars || bars.length < 2) return null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  const changes = {};
  for (const [key, days] of QA.PRICE_HISTORY_PERIODS) {
    const target = addDays(last.date, -days);
    let ref = null;
    for (let i = bars.length - 2; i >= 0; i--) if (bars[i].date <= target) { ref = bars[i]; break; }
    if (!ref && first.date <= addDays(target, QA.PRICE_HISTORY_SLACK_DAYS) && first !== last) ref = first;
    changes[key] = ref ? { from: ref.date, from_close: ref.close, change_pct: round(((last.close - ref.close) / ref.close) * 100) } : null;
  }
  // "This year" is the calendar year: from the last close of the year before.
  const yearEnd = [...bars].reverse().find((b) => b.date < `${last.date.slice(0, 4)}-01-01`);
  changes.year_to_date = yearEnd ? { from: yearEnd.date, from_close: yearEnd.close, change_pct: round(((last.close - yearEnd.close) / yearEnd.close) * 100) } : null;
  let high = first;
  let low = first;
  for (const b of bars) { if (b.close > high.close) high = b; if (b.close < low.close) low = b; }
  // The highest and lowest price traded, from each session's high and low, where the source
  // gives them (shares and commodities; not coins). These are what "its high" usually means.
  let traded = {};
  const ranged = bars.filter((b) => b.high != null && b.low != null);
  if (ranged.length === bars.length) {
    let top = bars[0];
    let bottom = bars[0];
    for (const b of bars) { if (b.high > top.high) top = b; if (b.low < bottom.low) bottom = b; }
    traded = {
      highest_price: { date: top.date, price: top.high, last_close_below_by: px(top.high - last.close), last_close_pct_below: round(((top.high - last.close) / top.high) * 100) },
      lowest_price: { date: bottom.date, price: bottom.low, last_close_above_by: px(last.close - bottom.low), last_close_pct_above: round(((last.close - bottom.low) / bottom.low) * 100) },
      latest_session: { date: last.date, high: last.high, low: last.low, close: last.close },
    };
  }
  const vols = bars.map((b) => b.volume).filter((v) => v != null);
  const recentVols = bars.slice(-QA.PRICE_HISTORY_VOLUME_SESSIONS).map((b) => b.volume).filter((v) => v != null);
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  // The last close of each calendar month before the current one.
  const monthEnds = [];
  for (let i = 0; i < bars.length - 1; i++) if (bars[i].date.slice(0, 7) !== bars[i + 1].date.slice(0, 7)) monthEnds.push([bars[i].date, bars[i].close]);
  const short = Object.values(changes).some((c) => c === null);
  return {
    period: { from: first.date, to: last.date, sessions: bars.length },
    ...(short ? { history_starts: first.date } : {}),
    last_close: { date: last.date, close: last.close },
    changes,
    highest_close: { date: high.date, close: high.close },
    lowest_close: { date: low.date, close: low.close },
    // How far the last close stands from the two, so nobody has to subtract.
    last_close_vs_highest_close: { below_by: px(high.close - last.close), pct_below: round(((high.close - last.close) / high.close) * 100) },
    last_close_vs_lowest_close: { above_by: px(last.close - low.close), pct_above: round(((last.close - low.close) / low.close) * 100) },
    ...traded,
    avg_daily_volume: vols.length ? { [`last_${QA.PRICE_HISTORY_VOLUME_SESSIONS}_sessions`]: avg(recentVols), period: avg(vols) } : null,
    recent_closes: bars.slice(-QA.PRICE_HISTORY_RECENT).map((b) => [b.date, b.close]),
    month_end_closes: monthEnds.slice(-12),
  };
}

const NOTE = 'Changes and closes are closing prices. highest_price and lowest_price are the highest and lowest prices TRADED in the period (each session\'s high and low), and are what "its high" or "its low" means; highest_close and lowest_close are closing prices. latest_session is the most recent trading session, which may not be today: give its date. Quote these figures as given, each with its dates; do not work out a change over any other period, and do not describe what the price did on days between the closes listed. The period ends on period.to. The latest session may still be in progress. Describe what the price did: do not call a trend, forecast, or say whether it is a good time to buy or sell.';
const COIN_NOTE = ' This is a coin: it trades all day, there is one price reading a day here and no session high or low, so the highest and lowest are daily readings; last_24_hours is its high and low over the last 24 hours.';

// The tool result for one company. Pure.
function buildHistory(company, { currency, bars, volumeUnit, last24h = null }, { held = false } = {}) {
  const s = summarize(bars);
  const head = { kind: 'price_history', ticker: company.ticker, name: company.name || company.ticker, held };
  if (!s) return { ...head, history: null, note: 'No price history is available for it right now. Say so; do not describe its past prices from memory.' };
  const coin = !s.highest_price;
  return { ...head, currency, ...s, ...(last24h ? { last_24_hours: last24h } : {}), ...(s.avg_daily_volume ? { volume_unit: volumeUnit } : {}), note: NOTE + (coin ? COIN_NOTE : '') };
}

// ── Network ──

// Which route a company's history comes from: { coin } | { yahoo: [symbols to try] } | null.
function sourceFor(company, markets = {}) {
  const { COMMODITY_YAHOO, indianMarketOf } = require('./priceService');
  const { coingeckoIdFor } = require('./assetRegistry');
  const cls = company.asset_class || company.assetClass || 'equity';
  if (cls === 'crypto') { const coin = coingeckoIdFor(company.ticker); return coin ? { coin } : null; }
  if (cls === 'commodity') return COMMODITY_YAHOO[company.ticker] ? { yahoo: [COMMODITY_YAHOO[company.ticker]] } : null;
  if (cls !== 'equity') return null;
  const market = indianMarketOf(company, markets);
  if (!market) return { yahoo: [company.ticker] };
  return { yahoo: market === 'BSE' ? [`${company.ticker}.BO`, `${company.ticker}.NS`] : [`${company.ticker}.NS`, `${company.ticker}.BO`] };
}

const cache = new Map(); // ticker → { at, data }
const getJson = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': IPO_WATCH.USER_AGENT }, signal: AbortSignal.timeout(QA.PRICE_HISTORY_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} replied ${res.status}`);
  return res.json();
};

// A year of daily bars for one company: { currency, bars, volumeUnit }. Empty bars when the
// source has nothing or refuses; never throws.
async function fetchHistory(company) {
  const hit = cache.get(company.ticker);
  if (hit && Date.now() - hit.at < QA.PRICE_HISTORY_TTL_MS) return hit.data;
  let data = { currency: null, bars: [], volumeUnit: null };
  try {
    const { indianMarkets } = require('./priceService');
    const src = sourceFor(company, (company.asset_class || company.assetClass || 'equity') === 'equity' ? await indianMarkets() : {});
    if (src && src.coin) {
      data = { ...parseCoinGecko(await getJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(src.coin)}/market_chart?vs_currency=usd&days=365&interval=daily`)), volumeUnit: 'USD traded a day' };
      // The last 24 hours' high and low come from a second route; without it the rest still stands.
      const m = await getJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(src.coin)}`).then((j) => (Array.isArray(j) ? j[0] : null)).catch(() => null);
      if (m && m.high_24h > 0 && m.low_24h > 0) data.last24h = { high: px(m.high_24h), low: px(m.low_24h) };
    } else if (src) {
      for (const sym of src.yahoo) {
        const parsed = await getJson(`${IPO_WATCH.YAHOO_CHART_URL}/${encodeURIComponent(sym)}?range=1y&interval=1d`).then(parseYahoo).catch(() => null);
        if (parsed && parsed.bars.length) { data = { ...parsed, volumeUnit: (company.asset_class || company.assetClass) === 'commodity' ? 'contracts a day' : 'shares a day' }; break; }
      }
    }
  } catch (err) {
    console.error(`price history for ${company.ticker} failed:`, err.message);
  }
  if (data.bars.length) cache.set(company.ticker, { at: Date.now(), data });
  return data;
}

async function priceHistory(company, { held = false } = {}) {
  return buildHistory(company, await fetchHistory(company), { held });
}

module.exports = { parseYahoo, parseCoinGecko, summarize, buildHistory, sourceFor, fetchHistory, priceHistory };
