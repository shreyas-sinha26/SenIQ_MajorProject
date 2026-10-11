/**
 * The Finnhub gate: every call to Finnhub goes through here, so no caller has to know what
 * the others are sending.
 *
 * Finnhub counts company-news calls and every other call (quotes, the IPO calendar)
 * separately, so there are two meters, `news` and `other`, picked from the path. Each has
 * two lanes:
 *   - background: the pipeline and the other scheduled jobs. One call at a time,
 *     FINNHUB.BACKGROUND_GAP_MS apart, in the order asked. A call waits for its place; it is
 *     never dropped.
 *   - interactive: someone's page or click. Sent at once, up to FINNHUB.INTERACTIVE_PER_MINUTE
 *     in any 60 seconds. Past that the call is not sent (`held`), and the caller falls back.
 * The two together stay inside FINNHUB.PER_MINUTE.
 *
 * A call is background when it is made inside background(fn), or says so; otherwise it is
 * interactive. Nothing is retried: a refusal (429) is returned to the caller, which stops
 * its job for the run. The refusal is logged beside the gate's own count for that minute, so
 * the log shows whether Finnhub refused a call the gate had room for.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { FINNHUB } = require('../config');

const lanes = new AsyncLocalStorage();
const MINUTE = 60_000;

// Run `fn` with every Finnhub call inside it on the background lane.
const background = (fn) => lanes.run('background', fn);
const currentLane = () => lanes.getStore() || 'interactive';

const meterOf = (path) => (path.startsWith('/company-news') ? 'news' : 'other');

function createGate({
  limits = FINNHUB,
  fetchImpl = (...a) => fetch(...a),
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  apiKey = () => process.env.FINNHUB_API_KEY || '',
  warn = console.warn,
} = {}) {
  const newMeter = () => ({ queue: Promise.resolve(), nextSlot: 0, sent: [], interactive: [], counts: {}, refused: 0, held: 0 });
  const meters = { news: newMeter(), other: newMeter() };
  const lastMinute = (stamps) => { const t = now() - MINUTE; while (stamps.length && stamps[0] <= t) stamps.shift(); return stamps.length; };

  // A background call's place: after the one before it, and no sooner than the gap allows.
  function placeInLine(m) {
    const turn = m.queue.then(async () => {
      const wait = m.nextSlot - now();
      if (wait > 0) await sleep(wait);
      m.nextSlot = now() + limits.BACKGROUND_GAP_MS;
    });
    m.queue = turn;
    return turn;
  }

  /**
   * GET a Finnhub path. `purpose` names what the call is for in the run's log line.
   * @returns {{ ok, status, data, held }} — `status` is the HTTP status, 0 when the request
   *   failed outright or was not sent; `held` is 'budget' or 'no_key' when it was not sent.
   */
  async function get(path, params = {}, { purpose = 'other', lane = currentLane(), timeoutMs = limits.TIMEOUT_MS } = {}) {
    const key = apiKey();
    if (!key) return { ok: false, status: 0, data: null, held: 'no_key' };
    const name = meterOf(path);
    const m = meters[name];
    if (lane === 'background') {
      await placeInLine(m);
    } else {
      if (lastMinute(m.interactive) >= limits.INTERACTIVE_PER_MINUTE) { m.held++; return { ok: false, status: 0, data: null, held: 'budget' }; }
      m.interactive.push(now());
    }
    m.sent.push(now());
    m.counts[purpose] = (m.counts[purpose] || 0) + 1;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${limits.BASE_URL}${path}?${new URLSearchParams(params)}`, { headers: { 'X-Finnhub-Token': key }, signal: ctrl.signal });
      if (res.status === 429) {
        m.refused++;
        const left = res.headers && res.headers.get ? res.headers.get('x-ratelimit-remaining') : null;
        warn(`   ⚠️  Finnhub refused a ${name} call (${purpose}, ${lane}): the gate had sent ${lastMinute(m.sent)} in the last minute, its limit is ${limits.PER_MINUTE}${left != null ? `; Finnhub says ${left} left` : ''}`);
      }
      if (!res.ok) return { ok: false, status: res.status, data: null, held: null };
      return { ok: true, status: res.status, data: await res.json(), held: null };
    } catch {
      return { ok: false, status: 0, data: null, held: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // What has been sent since this was last asked, by meter and purpose, then start again.
  function takeCounts() {
    const out = {};
    for (const [name, m] of Object.entries(meters)) {
      out[name] = { calls: Object.values(m.counts).reduce((a, b) => a + b, 0), byPurpose: m.counts, refused: m.refused, held: m.held };
      m.counts = {}; m.refused = 0; m.held = 0;
    }
    return out;
  }

  return { get, takeCounts };
}

// One meter's part of the run's log line: "news 107 (held 8, ipo 9, rotation 90)". Pure.
function describe(name, { calls, byPurpose, refused, held }) {
  const parts = Object.entries(byPurpose).map(([p, n]) => `${p} ${n}`).join(', ');
  return `${name} ${calls}${parts ? ` (${parts})` : ''}${refused ? `, ${refused} refused` : ''}${held ? `, ${held} not sent` : ''}`;
}
const summary = (counts) => Object.entries(counts).map(([name, c]) => describe(name, c)).join('; ');

const gate = createGate();

module.exports = { createGate, background, currentLane, meterOf, summary, get: gate.get, takeCounts: gate.takeCounts };
