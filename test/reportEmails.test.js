/**
 * Offline tests for report emails (no DB, no network): which market a portfolio is in,
 * local clocks, who is due which report and when, the one-line email, and the PDF it carries.
 * Run: node test/reportEmails.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('assert');
const { REPORT_EMAIL } = require('../server/config');
const { guessMarket, localClock, dueReport, buildReportEmail } = require('../server/services/reportEmails');
const { buildReportPdf, reportStats, vsNormal } = require('../server/services/reportPdf');
const { unsubscribeUrl, verifyUnsubscribeToken } = require('../server/services/emailService');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
const eq = (h) => ({ asset_class: 'equity', exchange: null, ...h });

console.log('reportEmails.test.js');

console.log('market:');
check('mostly NSE/BSE holdings → India; mostly US → US', () => {
  assert.strictEqual(guessMarket([eq({ ticker: 'X1', exchange: 'NSE' }), eq({ ticker: 'X2', exchange: 'BSE' }), eq({ ticker: 'AAPL', exchange: 'US' })]), 'IN');
  assert.strictEqual(guessMarket([eq({ ticker: 'AAPL' }), eq({ ticker: 'MSFT', exchange: 'NASDAQ' }), eq({ ticker: 'X1', exchange: 'NSE' })]), 'US');
});
check('a holding with no exchange is placed by the curated universe', () => {
  assert.strictEqual(guessMarket([eq({ ticker: 'RELIANCE' }), eq({ ticker: 'TCS' })]), 'IN');
});
check('crypto and commodities do not vote; a tie or an empty portfolio uses the default', () => {
  assert.strictEqual(guessMarket([{ ticker: 'BTC', asset_class: 'crypto' }, eq({ ticker: 'X1', exchange: 'NSE' })]), 'IN');
  assert.strictEqual(guessMarket([eq({ ticker: 'X1', exchange: 'NSE' }), eq({ ticker: 'AAPL', exchange: 'US' })]), REPORT_EMAIL.DEFAULT_MARKET);
  assert.strictEqual(guessMarket([]), REPORT_EMAIL.DEFAULT_MARKET);
});
check("the user's own choice wins over the guess; an unknown stored value is ignored", () => {
  const indian = [eq({ ticker: 'X1', exchange: 'NSE' })];
  assert.strictEqual(guessMarket(indian, 'US'), 'US');
  assert.strictEqual(guessMarket(indian, 'MARS'), 'IN');
});

console.log('clock and schedule:');
const at = (iso) => new Date(iso);
check('local clock: same instant, different local day and weekday', () => {
  const t = at('2026-10-11T19:00:00Z'); // Sunday 19:00 UTC
  assert.deepStrictEqual(localClock(t, 'Asia/Kolkata'), { date: '2026-10-12', weekday: 1, minutes: 30 });
  assert.deepStrictEqual(localClock(t, 'America/New_York'), { date: '2026-10-11', weekday: 0, minutes: 15 * 60 });
});
check('Plus/Pro: daily at 08:30 local on weekdays, for the length of the send window', () => {
  const clock = (weekday, h, m) => ({ date: 'x', weekday, minutes: h * 60 + m });
  assert.strictEqual(dueReport('plus', clock(1, 8, 29)), null);
  assert.strictEqual(dueReport('plus', clock(1, 8, 30)), 'daily');
  assert.strictEqual(dueReport('pro', clock(5, 11, 29)), 'daily');
  assert.strictEqual(dueReport('pro', clock(5, 11, 30)), null);
  assert.strictEqual(dueReport('plus', clock(6, 9, 0)), null); // Saturday
  assert.strictEqual(dueReport('plus', clock(0, 9, 0)), null); // Sunday
  assert.strictEqual(dueReport('plus', clock(0, 18, 30)), null); // paid plans get no weekly
});
check('Free: weekly on Sunday evening only', () => {
  const clock = (weekday, h, m) => ({ date: 'x', weekday, minutes: h * 60 + m });
  assert.strictEqual(dueReport('free', clock(0, 18, 0)), 'weekly');
  assert.strictEqual(dueReport('free', clock(0, 17, 59)), null);
  assert.strictEqual(dueReport('free', clock(1, 8, 30)), null);
  assert.strictEqual(dueReport(undefined, clock(0, 19, 0)), 'weekly');
});
check('08:30 in India and 08:30 in New York are different runs of the job', () => {
  const india = at('2026-10-12T03:00:00Z');   // Mon 08:30 IST
  const newYork = at('2026-10-12T12:30:00Z'); // Mon 08:30 EDT
  assert.strictEqual(dueReport('plus', localClock(india, 'Asia/Kolkata')), 'daily');
  assert.strictEqual(dueReport('plus', localClock(india, 'America/New_York')), null);
  assert.strictEqual(dueReport('plus', localClock(newYork, 'America/New_York')), 'daily');
  assert.strictEqual(dueReport('plus', localClock(newYork, 'Asia/Kolkata')), null);
});

console.log('email + PDF:');
const events = [
  { title: 'Chipmaker beats on revenue, shares jump ₹120', source: 'example.com', last_seen: '2026-10-11T08:00:00Z', exposure_pct: 21.44, direction: 'positive', impact_score: 0.31 },
  { title: 'Regulator opens probe', source: 'example.com', last_seen: '2026-10-10T08:00:00Z', exposure_pct: 9, direction: 'negative', impact_score: 0.2 },
];
const holdings = [
  { ticker: 'NVDA', name: 'Nvidia', exposure_pct: 60, sentiment_label: 'positive', sentiment_acute: 0.8, z: 1.24 },
  { ticker: 'TCS', name: 'Tata Consultancy Services', exposure_pct: 40, sentiment_label: 'neutral', sentiment_acute: 0.5, z: null },
];
check('the email is one generic line naming the report and its date, plus the stop link', () => {
  const unsub = unsubscribeUrl(7, 'reports');
  const m = buildReportEmail('daily', { name: 'Asha Rao', date: '2026-10-12' }, { unsubscribeUrl: unsub });
  assert.strictEqual(m.subject, '[SenIQ] Your daily brief — 12 October 2026');
  assert.strictEqual(m.filename, 'SenIQ-Daily-Brief-2026-10-12.pdf');
  assert.deepStrictEqual(m.text.split('\n').slice(0, 3), ['Hi Asha,', '', 'Here is your SenIQ daily brief for Monday, 12 October 2026. It is attached to this email as a PDF.']);
  assert.ok(m.text.includes(unsub) && m.html.includes('Stop report emails'));
  const w = buildReportEmail('weekly', { name: '', date: '2026-10-11' });
  assert.strictEqual(w.subject, '[SenIQ] Your weekly summary — 11 October 2026');
  assert.strictEqual(w.filename, 'SenIQ-Weekly-Summary-2026-10-11.pdf');
  assert.ok(w.text.startsWith('Hi,\n\nHere is your SenIQ weekly summary for Sunday, 11 October 2026.'));
});
check('nothing about the portfolio is in the email body — it all lives in the PDF', () => {
  const m = buildReportEmail('daily', { name: 'Asha', date: '2026-10-12', headline: 'SECRET HEADLINE', events }, {});
  assert.ok(!m.text.includes('SECRET') && !m.html.includes('SECRET') && !m.text.includes('Chipmaker'));
});
check('figures strip: daily counts changes, weekly counts the week; the largest position is named', () => {
  const daily = reportStats({ kind: 'daily', events, holdings, changed: { has_prior: true, new_events: [1, 2], sentiment_swings: [1] } });
  assert.deepStrictEqual(daily.map((s) => s.value), ['2', '2', '2', '1', 'NVDA 60%']);
  const first = reportStats({ kind: 'daily', events, holdings, changed: { has_prior: false } });
  assert.deepStrictEqual(first.slice(2, 4).map((s) => s.value), ['—', '—']);
  const weekly = reportStats({ kind: 'weekly', events: events.slice(0, 1), moreEvents: 4, holdings, alertCount: 3 });
  assert.deepStrictEqual(weekly.map((s) => s.value), ['2', '5', '3', 'NVDA 60%']);
});
check('"vs usual" reads in plain words', () => {
  assert.strictEqual(vsNormal(null), 'Not enough history');
  assert.strictEqual(vsNormal(0.3), 'In its usual range');
  assert.strictEqual(vsNormal(1.24), '+1.2σ above usual');
  assert.strictEqual(vsNormal(-2), '−2.0σ below usual');
});

(async () => {
  await checkAsync('a full daily report and a sparse weekly one both render to a real PDF', async () => {
    const daily = await buildReportPdf({
      kind: 'daily', name: 'Asha Rao', dateLabel: 'Monday, 12 October 2026', marketLabel: 'India', writer: 'deterministic',
      headline: 'x', narrative: 'y', events, holdings,
      changed: { has_prior: true, new_events: events, sentiment_swings: [{ ticker: 'NVDA', from_label: 'neutral', to_label: 'positive' }] },
      smartMoney: { congress: [{ date: '2026-06-15', action: 'sell', ticker: 'NVDA', politician: 'A Member' }], institutions: [{ name: 'A Fund', change: 'reduced', ticker: 'NVDA' }] },
    });
    const weekly = await buildReportPdf({ kind: 'weekly', dateLabel: 'Week ending Sunday, 11 October 2026', events: [], holdings: [], note: 'A quiet week.' });
    for (const pdf of [daily, weekly]) {
      assert.ok(Buffer.isBuffer(pdf) && pdf.length > 5000);
      assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
      assert.ok(pdf.subarray(-32).toString().includes('%%EOF'));
    }
  });
  await checkAsync('a long report runs onto more pages instead of off the bottom', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...holdings[0], ticker: `T${i}` }));
    const long = Array.from({ length: 8 }, (_, i) => ({ ...events[0], title: `${i} ${'A very long headline that wraps. '.repeat(6)}` }));
    const pdf = await buildReportPdf({ kind: 'daily', dateLabel: 'd', events: long, holdings: many, changed: { has_prior: true, new_events: long, sentiment_swings: [] } });
    assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 2);
  });

check('the reports unsubscribe link carries list=reports and a token valid for that user only', () => {
  const url = new URL(unsubscribeUrl(42, 'reports'));
  assert.strictEqual(url.searchParams.get('list'), 'reports');
  assert.strictEqual(verifyUnsubscribeToken(url.searchParams.get('token')), '42');
  assert.strictEqual(new URL(unsubscribeUrl(42)).searchParams.get('list'), null);
});

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
