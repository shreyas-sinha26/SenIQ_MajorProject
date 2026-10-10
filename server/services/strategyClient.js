/**
 * Phase 8+ — strategy-service client + request helpers, shared by the web routes
 * (routes/strategies.js, routes/paper.js) and the key-authenticated transports
 * (routes/mcp.js, routes/v1.js): transport failure normalizes to 503 "engine
 * offline", service-level 4xx passes detail through.
 */
const { STRATEGY_SERVICE } = require('../config');

const MAX_WATCH_SYMBOLS = 5;
const WARMUP_DAYS = 400; // paper replay: history handed to the engine for indicator warmup

function serviceHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (STRATEGY_SERVICE.SECRET) h['X-Service-Secret'] = STRATEGY_SERVICE.SECRET;
  return h;
}

async function callService(path, { method = 'GET', body, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || STRATEGY_SERVICE.TIMEOUT_MS);
  try {
    const res = await fetch(`${STRATEGY_SERVICE.URL}${path}`, {
      method,
      headers: serviceHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { status: 503, data: { detail: 'strategy engine is offline' } };
  } finally {
    clearTimeout(timer);
  }
}

// 422 = FastAPI/pydantic validation; its detail is an array of field errors.
function flattenDetail(data) {
  return Array.isArray(data.detail)
    ? data.detail.map((d) => `${(d.loc || []).filter((x) => x !== 'body').join('.')}: ${d.msg}`).join('; ')
    : data.detail;
}

// The markets the engine can price. NASDAQ / NYSE / AMEX are accepted as other names for US.
const EXCHANGES = ['US', 'NASDAQ', 'NYSE', 'AMEX', 'NSE', 'BSE', 'CRYPTO', 'COMMODITY'];
const EXCHANGES_SHOWN = 'US, NSE, BSE, CRYPTO or COMMODITY';
const SYMBOL = /^[A-Z0-9.\-&]{1,20}$/;
const isExchange = (x) => typeof x === 'string' && EXCHANGES.includes(x.trim().toUpperCase());

const ENGINE_OFFLINE = 'Strategy engine is offline — try again later.';
const ENGINE_FAILED = 'The strategy engine is running but could not complete this request. Check the inputs; trying again unchanged will likely fail the same way.';

/**
 * The engine's own refusals, in the user's terms. The engine answers in its vocabulary
 * ("interval '1d' lookback 7587d exceeds cap 1825d", "no bars returned for US:ZZZZ …") and
 * that text used to reach the page as it was. A refusal this does not recognise is passed
 * on unchanged: a strange message is still better than none. Pure.
 */
function plainEngineError(detail) {
  const d = typeof detail === 'string' ? detail.trim() : '';
  if (!d) return d;
  let m;
  if ((m = /lookback (\d+)d exceeds cap (\d+)d/.exec(d))) {
    const years = (n) => Math.round((Number(n) / 365) * 10) / 10;
    return `That date range is too long: price history here covers at most ${years(m[2])} years, and this asks for about ${years(m[1])}. Shorten the range.`;
  }
  if (/^end \S+ before start \S+/.test(d)) return 'The end date is before the start date.';
  if ((m = /no bars returned for (\w+):(\S+) (\S+?)\.\.(\S+)/.exec(d))) {
    return `No price data for ${m[2]} on ${m[1]} between ${m[3]} and ${m[4]}. Check the symbol and the market.`;
  }
  if ((m = /unsupported exchange for \w+: (.+)$/.exec(d))) return `Unknown market "${m[1]}". Use ${EXCHANGES_SHOWN}.`;
  if ((m = /unsupported commodity for \w+: (.+)$/.exec(d))) return `No price history for the commodity "${m[1]}". The ones available are XAU, XAG, WTI, BRENT and NG.`;
  if ((m = /unknown strategy: '([^']*)'/.exec(d))) return `There is no built-in strategy called "${m[1]}".`;
  if ((m = /(?:OHLC out of \[low,high\]|high<low) for \w+:(\S+) @ (\d{4}-\d{2}-\d{2})/.exec(d))) {
    return `The price data for ${m[1]} has a faulty bar on ${m[2]}. Try a range that ends before that date.`;
  }
  if (/too short for \d+ splits/.test(d)) return 'That date range is too short for the robustness check. Use a longer one.';
  if ((m = /^interval '([^']*)' not supported/.exec(d))) return `The interval "${m[1]}" is not supported.`;
  return d;
}

/**
 * What an engine reply that is not a 200 means for the caller: { status, error }.
 *   503       the engine could not be reached (callService's own answer)
 *   400 / 404 the engine refused the request; its reason, in plain words
 *   else      the engine answered with a failure of its own → 502, and NOT "offline":
 *             it is up, and saying otherwise sends the user to restart something healthy.
 */
function engineFailure(out, fallback = 'invalid request') {
  if (out.status === 503) return { status: 503, error: ENGINE_OFFLINE };
  if (out.status === 400 || out.status === 404 || out.status === 422) {
    return { status: out.status === 422 ? 400 : out.status, error: plainEngineError(flattenDetail(out.data || {})) || fallback };
  }
  return { status: 502, error: ENGINE_FAILED };
}

// A backtest's starting capital: a plain number inside the same bounds a paper deployment
// uses. Absent → the default. Anything else is refused with a message instead of being
// replaced or passed on: "0" used to become 100,000 without a word, and 1e30 reached the
// engine, failed there and came back as "engine offline".
const CAPITAL = { MIN: 1000, MAX: 100000000, DEFAULT: 100000 };
const CAPITAL_ERROR = 'Starting capital must be a number between 1,000 and 100,000,000.';
function parseCapital(raw) {
  if (raw == null || raw === '') return { ok: true, value: String(CAPITAL.DEFAULT) };
  if (typeof raw !== 'number' && typeof raw !== 'string') return { ok: false, error: CAPITAL_ERROR };
  const n = typeof raw === 'number' ? raw : (raw.trim() === '' ? NaN : Number(raw));
  if (!Number.isFinite(n) || n < CAPITAL.MIN || n > CAPITAL.MAX) return { ok: false, error: CAPITAL_ERROR };
  return { ok: true, value: String(n) };
}

// Same normalization the web routes apply: [{symbol, exchange}], max 5. Lenient: what does
// not look like a symbol is dropped. For a one-off run, where a bad entry simply comes back
// as that row's error. What is about to be STORED goes through checkSymbols instead.
function cleanSymbols(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => ({
      symbol: String((s && s.symbol) || '').trim().toUpperCase().slice(0, 20),
      exchange: String((s && s.exchange) || 'US').trim().toUpperCase().slice(0, 12),
    }))
    .filter((s) => SYMBOL.test(s.symbol))
    .slice(0, MAX_WATCH_SYMBOLS);
}

/**
 * A watchlist that is about to be saved: every entry must be a symbol on a known market,
 * and there may be at most MAX_WATCH_SYMBOLS. Nothing is dropped or cut short without a
 * word — a saved "TSLA:NASDQ" used to be kept and then fail on every page load. Pure.
 * → { ok: true, symbols } | { ok: false, error }
 */
function checkSymbols(raw) {
  if (raw == null) return { ok: true, symbols: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'symbols must be a list such as [{"symbol":"NVDA","exchange":"US"}]' };
  if (raw.length > MAX_WATCH_SYMBOLS) return { ok: false, error: `A watchlist holds at most ${MAX_WATCH_SYMBOLS} symbols; this one has ${raw.length}.` };
  const symbols = [];
  for (const entry of raw) {
    const symbol = String((entry && entry.symbol) || '').trim().toUpperCase();
    const exchange = String((entry && entry.exchange) || 'US').trim().toUpperCase();
    if (!SYMBOL.test(symbol)) return { ok: false, error: `"${symbol.slice(0, 30) || '(empty)'}" does not look like a symbol.` };
    if (!isExchange(exchange)) return { ok: false, error: `Unknown market "${exchange.slice(0, 20)}" for ${symbol}. Use ${EXCHANGES_SHOWN}.` };
    symbols.push({ symbol, exchange });
  }
  return { ok: true, symbols };
}

// pg DATE columns come back as JS Dates at LOCAL midnight; format in local
// time so the date doesn't shift a day east of GMT (same fix as routes/paper.js).
const iso = (d) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

// Replay a paper deployment (a paper_deployments row) from its deploy date to now, or to
// the day it was stopped. Replay-from-inception: indicators warm up on pre-deploy history,
// but `trade_from` stops any signal trading before the deployment existed.
async function replayPaper(row) {
  const { seniqDataIfNeeded } = require('./signalHistory'); // lazy: signalHistory needs the DB
  const deployed = new Date(row.deployed_at);
  const start = new Date(deployed);
  start.setDate(start.getDate() - WARMUP_DAYS);
  const end = row.status === 'stopped' && row.stopped_at ? new Date(row.stopped_at) : new Date();

  return callService('/api/backtest', {
    method: 'POST',
    body: {
      ...(row.kind === 'custom'
        ? { custom: row.spec, seniq_data: await seniqDataIfNeeded(row.spec, row.symbol) }
        : { strategy: row.strategy_name, params: row.params || {} }),
      symbol: row.symbol,
      exchange: row.exchange,
      start_date: iso(start),
      end_date: iso(end),
      trade_from: iso(deployed),
      initial_cash: String(row.initial_cash),
    },
  });
}

module.exports = {
  callService, flattenDetail, engineFailure, plainEngineError, ENGINE_OFFLINE, ENGINE_FAILED,
  cleanSymbols, checkSymbols, isExchange, EXCHANGES, EXCHANGES_SHOWN, SYMBOL,
  parseCapital, CAPITAL, iso, replayPaper, MAX_WATCH_SYMBOLS, WARMUP_DAYS,
};
