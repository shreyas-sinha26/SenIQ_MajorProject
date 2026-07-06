/**
 * Phase 8+ — strategy-service client + request helpers shared by the
 * key-authenticated transports (routes/mcp.js and routes/v1.js).
 *
 * Same contract as the copies in routes/strategies.js / routes/paper.js
 * (kept separate there to leave the web routes untouched): transport failure
 * normalizes to 503 "engine offline", service-level 4xx passes detail through.
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
    ? data.detail.map((d) => `${(d.loc || []).join('.')}: ${d.msg}`).join('; ')
    : data.detail;
}

// Same normalization the web routes apply: [{symbol, exchange}], max 5.
function cleanSymbols(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => ({
      symbol: String((s && s.symbol) || '').trim().toUpperCase().slice(0, 20),
      exchange: String((s && s.exchange) || 'US').trim().toUpperCase().slice(0, 12),
    }))
    .filter((s) => /^[A-Z0-9.\-&]{1,20}$/.test(s.symbol))
    .slice(0, MAX_WATCH_SYMBOLS);
}

// pg DATE columns come back as JS Dates at LOCAL midnight; format in local
// time so the date doesn't shift a day east of GMT (same fix as routes/paper.js).
const iso = (d) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

module.exports = { callService, flattenDetail, cleanSymbols, iso, MAX_WATCH_SYMBOLS, WARMUP_DAYS };
