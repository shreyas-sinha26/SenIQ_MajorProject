/**
 * The user's own clock.
 *
 * Two clocks matter and they are not the same. The MARKET clock says what a trading day
 * was (NSE closes 15:30 in Kolkata, NYSE 16:00 in New York). The USER clock says when it is
 * morning or evening for the person, what "today" is for them, and when their daily limits
 * start again. Someone in Dubai holding Indian stocks lives on Dubai time.
 *
 * A user's zone is users.time_zone (an IANA name, set from the browser or in Profile). Until
 * that is known, it is the zone of their market: users.home_market, else the market most of
 * their stocks trade in — which is what the app assumed for everyone before.
 */

const { REPORT_EMAIL } = require('../config');
const { UNIVERSE } = require('../data/universe');

const COUNTRY_BY_TICKER = new Map(UNIVERSE.map((c) => [c.ticker, c.country]));

// Whether the runtime knows this zone name. Pure.
function isValidTimeZone(tz) {
  // A named zone ("Area/City") or UTC — not an offset like "+05:30", which the runtime also
  // accepts but which cannot follow daylight saving.
  if (typeof tz !== 'string' || tz.length > 64 || !/^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)+)$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// ── Pure: which market is this portfolio mostly in? ──
// Stocks only (crypto and commodities trade everywhere). A stored choice always wins.
function guessMarket(holdings, stored = null) {
  if (stored && REPORT_EMAIL.MARKETS[stored]) return stored;
  let india = 0, us = 0;
  for (const h of holdings || []) {
    if (h.asset_class && h.asset_class !== 'equity') continue;
    const exchange = String(h.exchange || '').toUpperCase();
    const country = COUNTRY_BY_TICKER.get(h.ticker);
    if (REPORT_EMAIL.IN_EXCHANGES.includes(exchange) || (!exchange && country === 'IN')) india++;
    else us++;
  }
  if (india === us) return REPORT_EMAIL.DEFAULT_MARKET;
  return india > us ? 'IN' : 'US';
}

// ── Pure: the user's zone → { timeZone, source: 'user' | 'market' } ──
function zoneFor(user, holdings) {
  if (user && isValidTimeZone(user.time_zone)) return { timeZone: user.time_zone, source: 'user' };
  const market = guessMarket(holdings, user && user.home_market);
  return { timeZone: REPORT_EMAIL.MARKETS[market].timeZone, source: 'market' };
}

// ── Pure: the wall clock in a time zone → { date:'YYYY-MM-DD', weekday:0–6, minutes } ──
const clockParts = (now, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
}).formatToParts(now).map((p) => [p.type, p.value]));

function localClock(now, timeZone) {
  const parts = clockParts(now, timeZone);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// ── Pure: the instant the local day began in that zone → Date ──
// Counted back from the wall clock, so on the two days a year the clocks change it can be an
// hour out. Daily limits can live with that.
function localDayStart(now, timeZone) {
  const p = clockParts(now, timeZone);
  const t = new Date(now).getTime();
  return new Date(t - (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 - (t % 1000));
}

// ── DB: zones, cached briefly so a loop over alerts does not ask per row ──
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // userId → { at, zone }

async function userZone(userId) {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.zone;
  const { query, queryOne } = require('../db');
  const user = await queryOne('SELECT time_zone, home_market FROM users WHERE id = $1', [userId]);
  // Holdings are only needed when the zone has to be guessed from the market.
  const holdings = user && isValidTimeZone(user.time_zone) ? []
    : await query('SELECT ticker, exchange, asset_class FROM portfolio WHERE user_id = $1', [userId]);
  const zone = zoneFor(user, holdings);
  cache.set(key, { at: Date.now(), zone });
  return zone;
}
const forgetUserZone = (userId) => cache.delete(String(userId));

/**
 * When this user's day began — what a daily limit counts from. If the zone cannot be read,
 * falls back to midnight UTC (how limits were counted before), so a limit never fails open
 * or blocks a feature because of a lookup.
 */
async function userDayStart(userId, now = new Date()) {
  try {
    return localDayStart(now, (await userZone(userId)).timeZone);
  } catch {
    return new Date(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  }
}

// The user's local date, 'YYYY-MM-DD' (UTC date if the zone cannot be read).
async function userLocalDate(userId, now = new Date()) {
  try {
    return localClock(now, (await userZone(userId)).timeZone).date;
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

module.exports = {
  isValidTimeZone, guessMarket, zoneFor, localClock, localDayStart,
  userZone, forgetUserZone, userDayStart, userLocalDate,
};
