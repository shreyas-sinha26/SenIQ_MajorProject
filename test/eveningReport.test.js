/**
 * Offline tests for the end-of-day report: reading a market's last completed session from
 * the price feed's daily bars, deciding between the full report, the "markets closed" report
 * and no report, the wording, when it is due, and the send job's skip rule. No network, no
 * database (the send job gets a small stand-in).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');

// ── Stand-in for server/db.js, for the send job only ──
const db = { users: [], holdings: {}, sends: [], indian: [] };
async function run(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q.startsWith('SELECT u.id, u.email')) return db.users;
  if (q.startsWith('SELECT ticker, exchange, asset_class FROM portfolio')) return db.holdings[params[0]] || [];
  if (q.startsWith('INSERT INTO report_sends')) {
    if (db.sends.some((s) => s.user === params[0] && s.kind === params[1] && s.date === params[2])) return [];
    db.sends.push({ user: params[0], kind: params[1], date: params[2], outcome: 'sent' });
    return [{ user_id: params[0] }];
  }
  if (q.startsWith("UPDATE report_sends SET outcome = 'skipped'")) { db.sends.find((s) => s.user === params[0] && s.kind === params[1] && s.date === params[2]).outcome = 'skipped'; return []; }
  if (q.startsWith('DELETE FROM report_sends')) { db.sends = db.sends.filter((s) => !(s.user === params[0] && s.kind === params[1] && s.date === params[2])); return []; }
  throw new Error(`stand-in db: unexpected statement: ${q.slice(0, 90)}`);
}
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: { query: run, queryOne: async (s, p) => (await run(s, p))[0] || null, execute: async (s, p) => ({ rowCount: (await run(s, p)).length }) },
};

const { sessionFromChart, marketOf } = require('../server/services/marketSessions');
const E = require('../server/services/eveningReport');
const { dueReport, buildReportEmail, runReportEmails } = require('../server/services/reportEmails');
const { localClock } = require('../server/services/userTime');
const { buildReportPdf } = require('../server/services/reportPdf');
const { REPORT_EMAIL } = require('../server/config');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

// Yahoo's daily bars for RELIANCE.NS and AAPL, as served on 2026-10-08 (bars are stamped at
// the session's open; currentTradingPeriod is today's session).
const RELIANCE = {
  meta: { exchangeTimezoneName: 'Asia/Kolkata', currentTradingPeriod: { regular: { start: 1791431100, end: 1791453600 } } },
  timestamp: [1791171900, 1791258300, 1791344700, 1791431100],
  indicators: { quote: [{ close: [1186.4, 1218.0, 1207.7, 1178.0] }] },
};
const AAPL = {
  meta: { exchangeTimezoneName: 'America/New_York', currentTradingPeriod: { regular: { start: 1791466200, end: 1791489600 } } },
  timestamp: [1790947800, 1791207000, 1791293400, 1791379800],
  indicators: { quote: [{ close: [333.69, 332.89, 333.63, 336.67] }] },
};
const EVENING_IST = Date.parse('2026-10-08T14:30:00Z');   // 20:00 in Kolkata; NSE shut, New York not yet open
const HOUR = 3600 * 1000;

section('a market\'s last completed session:');
check('after the close: today\'s session, its move against the day before, and when it ended', () => {
  assert.deepStrictEqual(sessionFromChart(RELIANCE, EVENING_IST),
    { date: '2026-10-08', changePct: -2.46, close: 1178, endedAt: 1791453600000, inProgress: false, timeZone: 'Asia/Kolkata' });
});
check('before the open: the session that closed overnight, dated in the exchange\'s own zone', () => {
  const s = sessionFromChart(AAPL, EVENING_IST);
  assert.strictEqual(s.date, '2026-10-07');
  assert.strictEqual(s.changePct, 0.91);
  assert.strictEqual(s.inProgress, false);
  assert.strictEqual(new Date(s.endedAt).toISOString(), '2026-10-07T20:00:00.000Z');
});
check('while a session is trading, its bar is not a completed session', () => {
  const midSession = 1791440000 * 1000;
  const s = sessionFromChart(RELIANCE, midSession);
  assert.deepStrictEqual([s.date, s.changePct, s.inProgress], ['2026-10-07', -0.85, true]);
});
check('a holiday needs no calendar: with no bar for the day, the last session is an earlier one', () => {
  // Saturday 10 Oct, 20:00 IST. The feed's "current period" is Monday's; the last bar is Friday's.
  const friday = { ...RELIANCE, meta: { ...RELIANCE.meta, currentTradingPeriod: { regular: { start: 1791431100 + 4 * 86400, end: 1791453600 + 4 * 86400 } } },
    timestamp: [...RELIANCE.timestamp, 1791431100 + 86400], indicators: { quote: [{ close: [1186.4, 1218.0, 1207.7, 1178.0, 1190.0] }] } };
  const saturdayEvening = EVENING_IST + 2 * 86400 * 1000;
  const s = sessionFromChart(friday, saturdayEvening);
  assert.strictEqual(s.date, '2026-10-09');
  assert.ok(saturdayEvening - s.endedAt > 24 * HOUR);
});
check('unreadable replies and too few bars give null', () => {
  assert.strictEqual(sessionFromChart(null), null);
  assert.strictEqual(sessionFromChart({ meta: {}, timestamp: [] }), null);
  assert.strictEqual(sessionFromChart({ meta: RELIANCE.meta, timestamp: [1791431100], indicators: { quote: [{ close: [1178] }] } }, EVENING_IST), null);
  assert.strictEqual(sessionFromChart({ meta: RELIANCE.meta, timestamp: [1, 2], indicators: { quote: [{ close: [null, null] }] } }, EVENING_IST), null);
});
check('which market a holding trades in, and the symbols to ask for', () => {
  assert.deepStrictEqual(marketOf({ ticker: 'TCS' }, { TCS: 'NSE' }), { market: 'IN', symbols: ['TCS.NS', 'TCS.BO'] });
  assert.deepStrictEqual(marketOf({ ticker: 'XYZ', exchange: 'BSE' }, {}), { market: 'IN', symbols: ['XYZ.BO', 'XYZ.NS'] });
  assert.deepStrictEqual(marketOf({ ticker: 'BRK.B' }, {}), { market: 'US', symbols: ['BRK-B'] });
  assert.deepStrictEqual(marketOf({ ticker: 'XAU', asset_class: 'commodity' }, {}), { market: 'COMMODITY', symbols: ['GC=F'] });
  assert.deepStrictEqual(marketOf({ ticker: 'BTC', asset_class: 'crypto' }, {}), { market: 'CRYPTO', symbols: [] });
});

const relSession = sessionFromChart(RELIANCE, EVENING_IST);
const aaplSession = sessionFromChart(AAPL, EVENING_IST);
const SESSIONS = { RELIANCE: { market: 'IN', session: relSession }, AAPL: { market: 'US', session: aaplSession } };
const HOLD = [{ ticker: 'RELIANCE' }, { ticker: 'AAPL' }];

section('what tonight adds up to:');
check('an Indian evening with Indian and US stocks: today\'s NSE session and last night\'s New York one', () => {
  const plan = E.planEvening(HOLD, SESSIONS, EVENING_IST);
  assert.strictEqual(plan.traded, true);
  assert.deepStrictEqual(plan.changeByTicker, { RELIANCE: -2.46, AAPL: 0.91 });
  assert.deepStrictEqual(plan.markets.map((m) => [m.market, m.date, m.fresh]), [['IN', '2026-10-08', true], ['US', '2026-10-07', true]]);
});
check('a weekend: the last sessions are too old to be tonight\'s move', () => {
  const sunday = EVENING_IST + 3 * 86400 * 1000;
  const plan = E.planEvening(HOLD, SESSIONS, sunday);
  assert.strictEqual(plan.traded, false);
  assert.deepStrictEqual(plan.changeByTicker, { RELIANCE: null, AAPL: null });
  assert.ok(plan.markets.every((m) => !m.fresh));
});
check('crypto trades every day; a holding the feed could not read is left to its quote', () => {
  const sunday = EVENING_IST + 3 * 86400 * 1000;
  const plan = E.planEvening([...HOLD, { ticker: 'BTC' }, { ticker: 'NEWCO' }],
    { ...SESSIONS, BTC: { market: 'CRYPTO', session: null }, NEWCO: { market: 'US', session: null } }, sunday);
  assert.strictEqual(plan.traded, true);
  assert.ok(!('BTC' in plan.changeByTicker) && !('NEWCO' in plan.changeByTicker));
  assert.deepStrictEqual(plan.markets.map((m) => m.market), ['IN', 'US', 'CRYPTO']);
});
check('the three outcomes', () => {
  assert.strictEqual(E.decideOutcome(true, 0), 'full');
  assert.strictEqual(E.decideOutcome(true, 3), 'full');
  assert.strictEqual(E.decideOutcome(false, 2), 'closed');
  assert.strictEqual(E.decideOutcome(false, 0), 'skip');
});

const INSIGHTS = {
  verdict: { level: 'calm', count: 0, text: 'Nothing specific to your holdings needs your attention tonight.', detail: 'x' },
  cards: [{ event_id: 1, title: 'Reliance results beat estimates' }],
  movers: { portfolio_change_pct: -1.02, rows: [{ ticker: 'RELIANCE', change_pct: -2.46, weight_pct: 60, contribution_pct: -1.48 }, { ticker: 'AAPL', change_pct: 0.91, weight_pct: 40, contribution_pct: 0.36 }] },
  divergences: [{ ticker: 'AAPL' }], concentration: null, trackRecord: null, coverage: null, portfolio_value: '$10,000',
};

section('the wording:');
check('a trading day says which session each market\'s move is from', () => {
  const w = E.writeEvening(E.planEvening(HOLD, SESSIONS, EVENING_IST), INSIGHTS, 'full');
  assert.strictEqual(w.headline, 'Your portfolio fell 1.02% in the latest session');
  assert.strictEqual(w.narrative, 'This covers India: the session of 8 October; United States: the session of 7 October. The biggest pulls were RELIANCE −2.46% (−1.48% of the portfolio) and AAPL +0.91% (+0.36% of the portfolio). 1 new story about your holdings is set out below.');
});
check('a session still open is named and not counted', () => {
  const usOpen = { ...SESSIONS, AAPL: { market: 'US', session: { ...aaplSession, inProgress: true } } };
  assert.ok(/United States: the session of 7 October \(today's session is still open and is not counted\)/.test(E.writeEvening(E.planEvening(HOLD, usOpen, EVENING_IST), INSIGHTS, 'full').narrative));
});
check('a closed day reports no move and says when each market last traded', () => {
  const sunday = EVENING_IST + 3 * 86400 * 1000;
  const w = E.writeEvening(E.planEvening(HOLD, SESSIONS, sunday), INSIGHTS, 'closed');
  assert.strictEqual(w.headline, 'Markets were closed today');
  assert.strictEqual(w.narrative, 'None of the markets you hold traded today, so there is no move to report (India last traded on 8 October; United States last traded on 7 October). News kept coming: 1 new story about your holdings is set out below.');
});
check('flat and unpriced portfolios', () => {
  const plan = E.planEvening(HOLD, SESSIONS, EVENING_IST);
  assert.strictEqual(E.writeEvening(plan, { ...INSIGHTS, movers: { portfolio_change_pct: 0.01, rows: [] } }, 'full').headline, 'Your portfolio was flat in the latest session');
  assert.strictEqual(E.writeEvening(plan, { cards: [], movers: { portfolio_change_pct: null, rows: [] } }, 'full').headline, 'End of day for your portfolio');
  assert.ok(/No new story about your holdings cleared the bar today\.$/.test(E.writeEvening(plan, { cards: [] }, 'full').narrative));
});

section('building the report:');
const depsFor = (now, insights = INSIGHTS, sessions = SESSIONS) => ({
  now, holdingsFn: async () => HOLD, sessionsFn: async () => sessions,
  insightsFn: async (id, opts) => { depsFor.lastOpts = opts; return insights; },
  packetFn: async () => ({ top_events: [{ title: 'e' }], portfolio: { top_holdings: [{ ticker: 'RELIANCE', exposure_pct: 60 }] }, smart_money: null }),
});
const USER = { id: 7, name: 'Asha Rao' };
const LABELS = { dateLabel: 'Thursday, 8 October 2026', market: 'IN', marketLabel: 'India' };
check('a trading day: the full report, with session moves and only the last day\'s stories', async () => {
  const r = await E.buildEveningReport(USER, LABELS, depsFor(EVENING_IST));
  assert.deepStrictEqual([r.kind, r.outcome, r.writer], ['evening', 'full', 'deterministic']);
  assert.ok(r.note.startsWith('Your portfolio fell 1.02% in the latest session. This covers India'));
  assert.deepStrictEqual(depsFor.lastOpts.changeByTicker, { RELIANCE: -2.46, AAPL: 0.91 });
  assert.strictEqual(depsFor.lastOpts.since, EVENING_IST - 24 * HOUR);
  assert.strictEqual(depsFor.lastOpts.kind, 'evening');
  assert.strictEqual(r.insights.movers.rows.length, 2);
});
check('a closed day with news: the short report, with the old moves left out', async () => {
  const r = await E.buildEveningReport(USER, LABELS, depsFor(EVENING_IST + 3 * 86400 * 1000));
  assert.strictEqual(r.outcome, 'closed');
  assert.deepStrictEqual(r.insights.movers, { portfolio_change_pct: null, rows: [] });
  assert.deepStrictEqual(r.insights.divergences, []);
  assert.strictEqual(r.insights.cards.length, 1);
});
check('a closed day with nothing new: no report', async () => {
  const r = await E.buildEveningReport(USER, LABELS, depsFor(EVENING_IST + 3 * 86400 * 1000, { ...INSIGHTS, cards: [] }));
  assert.deepStrictEqual(r, { outcome: 'skip' });
});
check('both kinds of report draw as a PDF', async () => {
  for (const now of [EVENING_IST, EVENING_IST + 3 * 86400 * 1000]) {
    const pdf = await buildReportPdf(await E.buildEveningReport(USER, LABELS, depsFor(now)));
    assert.ok(Buffer.isBuffer(pdf) && pdf.length > 3000 && pdf.slice(0, 5).toString() === '%PDF-');
  }
});

section('Indian deals and insider trades in a report:');
const { indiaSmartMoneyRows } = require('../server/services/reportPdf');
const { deterministicBrief } = require('../server/services/briefWriter');
const INDIA_SM = {
  congress: [], institutions: [],
  india_deals: [
    { client: 'GOLDMAN SACHS BANK EUROPE SE', investor: 'Goldman Sachs', deal: 'bulk', action: 'sell', ticker: 'RELIANCE', shares: 3217800, value_inr: 96147864, date: '2026-10-07' },
    { client: 'SOME FUND LLP', investor: null, deal: 'block', action: 'buy', ticker: 'RELIANCE', shares: 7000000, value_inr: 9803500000, date: '2026-10-07' },
  ],
  india_insiders: [
    { person: 'Bajaj Holdings & Investment Limited', category: 'Promoters', action: 'buy', ticker: 'BAJAJFINSV', shares: 2090050, value_inr: 3700224520, traded: '2026-10-05', disclosed: '2026-10-07' },
  ],
};
check('the table\'s rows: deals first, a followed-list investor by its short name, rupees in crore', () => {
  assert.deepStrictEqual(indiaSmartMoneyRows(INDIA_SM), [
    { who: 'Goldman Sachs', kind: 'Bulk deal', what: 'sell', ticker: 'RELIANCE', size: '₹9.6 Cr', when: '7 Oct 2026' },
    { who: 'SOME FUND LLP', kind: 'Block deal', what: 'buy', ticker: 'RELIANCE', size: '₹980 Cr', when: '7 Oct 2026' },
    { who: 'Bajaj Holdings & Investment Limited', kind: 'Insider · Promoters', what: 'buy', ticker: 'BAJAJFINSV', size: '₹370 Cr', when: '7 Oct 2026' },
  ]);
  assert.deepStrictEqual(indiaSmartMoneyRows({ congress: [{ politician: 'x' }] }), []);
  assert.deepStrictEqual(indiaSmartMoneyRows(null), []);
});
check('a report with only Indian rows, only US rows, or both still draws', async () => {
  const base = await E.buildEveningReport(USER, LABELS, depsFor(EVENING_IST));
  const us = { congress: [{ date: '2026-06-15', action: 'sell', ticker: 'NVDA', politician: 'A Member' }], institutions: [] };
  const sizes = [];
  for (const smartMoney of [null, INDIA_SM, us, { ...us, ...INDIA_SM, congress: us.congress }]) {
    const pdf = await buildReportPdf({ ...base, smartMoney });
    assert.ok(pdf.slice(0, 5).toString() === '%PDF-');
    sizes.push(pdf.length);
  }
  assert.ok(sizes[1] > sizes[0] && sizes[3] > sizes[2], 'the Indian table adds to the page');
});
check('the brief\'s fallback text mentions them', () => {
  const packet = { most_important: null, top_events: [], changed: { has_prior: false }, portfolio: { top_holdings: [] }, smart_money: INDIA_SM };
  assert.ok(/Smart money: 2 bulk or block deal\(s\) on RELIANCE; insider trade\(s\) disclosed on BAJAJFINSV\./.test(deterministicBrief(packet).narrative));
});

section('when it is due:');
const at = (iso, tz) => localClock(new Date(iso), tz);
check('Pro gets it from 20:00 on their own clock, every day of the week', () => {
  assert.strictEqual(dueReport('pro', at('2026-10-08T14:30:00Z', 'Asia/Kolkata')), 'evening');   // Thu 20:00
  assert.strictEqual(dueReport('pro', at('2026-10-10T16:00:00Z', 'Asia/Kolkata')), 'evening');   // Sat 21:30
  assert.strictEqual(dueReport('pro', at('2026-10-08T14:29:00Z', 'Asia/Kolkata')), null);        // 19:59
  assert.strictEqual(dueReport('pro', at('2026-10-08T14:30:00Z', 'America/New_York')), 'daily'); // 10:30 there: the morning brief's window, not the evening's
  assert.strictEqual(dueReport('pro', at('2026-10-08T18:00:00Z', 'America/New_York')), null);    // 14:00 there
  assert.strictEqual(dueReport('pro', at('2026-10-09T00:30:00Z', 'America/New_York')), 'evening'); // 20:30 there
});
check('Pro still gets the morning brief; Plus and Free get no evening report', () => {
  assert.strictEqual(dueReport('pro', at('2026-10-08T03:30:00Z', 'Asia/Kolkata')), 'daily');     // 09:00
  assert.strictEqual(dueReport('plus', at('2026-10-08T14:30:00Z', 'Asia/Kolkata')), null);
  assert.strictEqual(dueReport('free', at('2026-10-08T14:30:00Z', 'Asia/Kolkata')), null);
  assert.deepStrictEqual(REPORT_EMAIL.EVENING.TIERS, ['pro']);
});
check('the email names the report and its file', () => {
  const e = buildReportEmail('evening', { name: 'Asha Rao', date: '2026-10-08', verdict: INSIGHTS.verdict });
  assert.strictEqual(e.filename, 'SenIQ-End-of-Day-2026-10-08.pdf');
  assert.ok(/Nothing needs your attention tonight — 8 October 2026$/.test(e.subject));
  assert.ok(/Here is your SenIQ end-of-day report for Thursday, 8 October 2026/.test(e.text));
  const c = buildReportEmail('evening', { name: 'A', date: '2026-10-08', verdict: { level: 'check', count: 2, text: '2 things to check tonight', detail: 'Reliance results' } });
  assert.ok(/2 things to check: Reliance results/.test(c.subject));
});

section('the send job:');
const evening = require('../server/services/eveningReport');
const realBuild = evening.buildEveningReport;
const jobDeps = (sent) => ({
  now: new Date(EVENING_IST), emailEnabledFn: () => true, buildPdfFn: async () => Buffer.from('%PDF-test'),
  sendEmailFn: async (m) => { sent.push(m); return { delivered: true }; },
});
check('a Pro user on Dubai time is not due at 20:00 Kolkata time; one on Kolkata time is', async () => {
  db.users = [
    { id: 1, email: 'k@example.test', name: 'K', subscription_tier: 'pro', home_market: null, time_zone: 'Asia/Kolkata' },
    { id: 2, email: 'd@example.test', name: 'D', subscription_tier: 'pro', home_market: null, time_zone: 'Asia/Dubai' },
    { id: 3, email: 'p@example.test', name: 'P', subscription_tier: 'plus', home_market: null, time_zone: 'Asia/Kolkata' },
  ];
  db.holdings = { 1: [{ ticker: 'RELIANCE', asset_class: 'equity' }], 2: [{ ticker: 'RELIANCE', asset_class: 'equity' }], 3: [{ ticker: 'RELIANCE', asset_class: 'equity' }] };
  db.sends = [];
  evening.buildEveningReport = async (user) => ({ kind: 'evening', outcome: 'full', name: user.name, insights: INSIGHTS });
  const sent = [];
  const r = await runReportEmails(jobDeps(sent));
  assert.deepStrictEqual(r, { sent: 1, failed: 0, due: 1, skipped: 0 });
  assert.deepStrictEqual(sent.map((m) => [m.to, m.kind, m.attachments[0].filename]), [['k@example.test', 'report_evening', 'SenIQ-End-of-Day-2026-10-08.pdf']]);
  assert.deepStrictEqual(db.sends, [{ user: 1, kind: 'evening', date: '2026-10-08', outcome: 'sent' }]);
  // The same window again: already sent, nothing goes out twice.
  assert.strictEqual((await runReportEmails(jobDeps(sent))).sent, 0);
  assert.strictEqual(sent.length, 1);
});
check('a night with nothing to say sends nothing and is decided once', async () => {
  db.sends = [];
  let builds = 0;
  evening.buildEveningReport = async () => { builds++; return { outcome: 'skip' }; };
  const sent = [];
  const r = await runReportEmails(jobDeps(sent));
  assert.deepStrictEqual(r, { sent: 0, failed: 0, due: 0, skipped: 1 });
  assert.deepStrictEqual(db.sends, [{ user: 1, kind: 'evening', date: '2026-10-08', outcome: 'skipped' }]);
  await runReportEmails(jobDeps(sent));
  assert.strictEqual(builds, 1);
  assert.strictEqual(sent.length, 0);
  evening.buildEveningReport = realBuild;
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} end-of-day report checks passed`);
})();
