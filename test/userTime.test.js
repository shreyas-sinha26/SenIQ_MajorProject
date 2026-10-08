/**
 * Offline tests for the user's own clock (services/userTime.js): which zone a user is on,
 * the wall clock and the start of the day in that zone, when the daily brief is due, and
 * where daily limits count from. No network; the database is a two-statement stand-in.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');

// ── Stand-in for server/db.js: one user row and their holdings ──
const db = { user: null, holdings: [], fail: false, reads: 0 };
async function run(sql) {
  if (db.fail) throw new Error('database down');
  db.reads++;
  if (/FROM users WHERE id/.test(sql)) return db.user ? [db.user] : [];
  if (/FROM portfolio WHERE user_id/.test(sql)) return db.holdings;
  throw new Error(`stand-in db: unexpected statement: ${sql.slice(0, 80)}`);
}
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: { query: run, queryOne: async (s, p) => (await run(s, p))[0] || null, execute: async () => ({ rowCount: 0 }) },
};

const T = require('../server/services/userTime');
const { briefDue } = require('../server/services/reports');
const { dueReport } = require('../server/services/reportEmails');
const { REPORTS, REPORT_EMAIL } = require('../server/config');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

const eq = (ticker, exchange) => ({ ticker, exchange, asset_class: 'equity' });

section('which zone:');
check('a zone is a name, not an offset', () => {
  for (const tz of ['Asia/Kolkata', 'America/New_York', 'Asia/Dubai', 'America/Argentina/Buenos_Aires', 'UTC']) assert.strictEqual(T.isValidTimeZone(tz), true, tz);
  for (const tz of ['+05:30', 'GMT+5', 'IST', 'Mars/Phobos', 'Asia/Kolkata; DROP', '', null, 42, 'A'.repeat(80)]) assert.strictEqual(T.isValidTimeZone(tz), false, String(tz));
});
check('the user\'s own setting wins; without one it is their market\'s zone', () => {
  assert.deepStrictEqual(T.zoneFor({ time_zone: 'Asia/Dubai', home_market: 'IN' }, [eq('TCS')]), { timeZone: 'Asia/Dubai', source: 'user' });
  assert.deepStrictEqual(T.zoneFor({ time_zone: null, home_market: 'US' }, [eq('TCS')]), { timeZone: 'America/New_York', source: 'market' });
  assert.deepStrictEqual(T.zoneFor({ time_zone: null, home_market: null }, [eq('TCS'), eq('X', 'NSE')]), { timeZone: 'Asia/Kolkata', source: 'market' });
  assert.deepStrictEqual(T.zoneFor({ time_zone: 'nonsense', home_market: null }, [eq('AAPL')]), { timeZone: 'America/New_York', source: 'market' });
  assert.deepStrictEqual(T.zoneFor(null, []), { timeZone: REPORT_EMAIL.MARKETS[REPORT_EMAIL.DEFAULT_MARKET].timeZone, source: 'market' });
});

section('the clock in a zone:');
const NOW = new Date('2026-10-08T14:35:20.500Z');
check('one instant is a different date and time in different zones', () => {
  assert.deepStrictEqual(T.localClock(NOW, 'Asia/Kolkata'), { date: '2026-10-08', weekday: 4, minutes: 20 * 60 + 5 });
  assert.deepStrictEqual(T.localClock(NOW, 'America/Los_Angeles'), { date: '2026-10-08', weekday: 4, minutes: 7 * 60 + 35 });
  assert.strictEqual(T.localClock(new Date('2026-10-08T20:00:00Z'), 'Asia/Kolkata').date, '2026-10-09');
  assert.strictEqual(T.localClock(new Date('2026-10-08T02:00:00Z'), 'America/New_York').date, '2026-10-07');
});
check('the day starts at local midnight, to the millisecond', () => {
  assert.strictEqual(T.localDayStart(NOW, 'Asia/Kolkata').toISOString(), '2026-10-07T18:30:00.000Z');
  assert.strictEqual(T.localDayStart(NOW, 'America/New_York').toISOString(), '2026-10-08T04:00:00.000Z');
  assert.strictEqual(T.localDayStart(NOW, 'Asia/Dubai').toISOString(), '2026-10-07T20:00:00.000Z');
  assert.strictEqual(T.localDayStart(NOW, 'UTC').toISOString(), '2026-10-08T00:00:00.000Z');
});
check('daylight saving is followed (New York is UTC-5 in January, UTC-4 in July)', () => {
  assert.strictEqual(T.localDayStart(new Date('2026-01-15T12:00:00Z'), 'America/New_York').toISOString(), '2026-01-15T05:00:00.000Z');
  assert.strictEqual(T.localDayStart(new Date('2026-07-15T12:00:00Z'), 'America/New_York').toISOString(), '2026-07-15T04:00:00.000Z');
});

section('what runs on the user\'s clock:');
check('the brief is due from 05:30 their time, for the length of the window', () => {
  const at = (h, m) => ({ minutes: h * 60 + m });
  assert.strictEqual(briefDue(at(5, 29)), false);
  assert.strictEqual(briefDue(at(REPORTS.LOCAL_TIME.HOUR, REPORTS.LOCAL_TIME.MINUTE)), true);
  assert.strictEqual(briefDue(at(8, 29)), true);
  assert.strictEqual(briefDue(at(8, 30)), false);
  assert.strictEqual(briefDue(at(23, 0)), false);
});
check('the same instant is brief time in Kolkata and not in New York', () => {
  const t = new Date('2026-10-08T00:30:00Z'); // 06:00 in Kolkata, 20:30 the evening before in New York
  assert.strictEqual(briefDue(T.localClock(t, 'Asia/Kolkata')), true);
  assert.strictEqual(briefDue(T.localClock(t, 'America/New_York')), false);
});
check('a Dubai user holding Indian stocks gets the morning report at 08:30 Dubai time', () => {
  const zone = T.zoneFor({ time_zone: 'Asia/Dubai', home_market: null }, [eq('TCS'), eq('RELIANCE')]).timeZone;
  const dubaiMorning = new Date('2026-10-08T04:45:00Z'); // 08:45 in Dubai, 10:15 in Kolkata
  assert.strictEqual(dueReport('plus', T.localClock(dubaiMorning, zone)), 'daily');
  const kolkataMorning = new Date('2026-10-08T03:15:00Z'); // 08:45 in Kolkata, 07:15 in Dubai
  assert.strictEqual(dueReport('plus', T.localClock(kolkataMorning, zone)), null);
});

section('daily limits:');
check('a limit counts from the user\'s own midnight', async () => {
  db.user = { time_zone: 'Asia/Kolkata', home_market: null }; T.forgetUserZone(1);
  assert.strictEqual((await T.userDayStart(1, NOW)).toISOString(), '2026-10-07T18:30:00.000Z');
  assert.strictEqual(await T.userLocalDate(1, new Date('2026-10-08T20:00:00Z')), '2026-10-09');
});
check('with no setting it is the market\'s zone, worked out from the holdings', async () => {
  db.user = { time_zone: null, home_market: null }; db.holdings = [eq('AAPL'), eq('MSFT')]; T.forgetUserZone(2);
  assert.strictEqual((await T.userDayStart(2, NOW)).toISOString(), '2026-10-08T04:00:00.000Z');
});
check('the zone is remembered briefly, and forgotten when the setting changes', async () => {
  db.user = { time_zone: 'Asia/Dubai', home_market: null }; T.forgetUserZone(3);
  await T.userZone(3);
  const reads = db.reads;
  await T.userZone(3); await T.userDayStart(3, NOW);
  assert.strictEqual(db.reads, reads); // served from memory
  db.user = { time_zone: 'Asia/Kolkata', home_market: null };
  assert.strictEqual((await T.userZone(3)).timeZone, 'Asia/Dubai');
  T.forgetUserZone(3);
  assert.strictEqual((await T.userZone(3)).timeZone, 'Asia/Kolkata');
});
check('if the zone cannot be read, the limit counts from midnight UTC as before', async () => {
  db.fail = true; T.forgetUserZone(4);
  assert.strictEqual((await T.userDayStart(4, NOW)).toISOString(), '2026-10-08T00:00:00.000Z');
  assert.strictEqual(await T.userLocalDate(4, NOW), '2026-10-08');
  db.fail = false;
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} user-clock checks passed`);
})();
