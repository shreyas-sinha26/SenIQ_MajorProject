/**
 * Offline tests for report emails (no DB, no network): which market a portfolio is in,
 * local clocks, who is due which report and when, the one-line email, the PDF it carries,
 * and the explaining sections (headline cards, verdict, movers, concentration, track record).
 * Run: node test/reportEmails.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('assert');
const { REPORT_EMAIL } = require('../server/config');
const { guessMarket, localClock, dueReport, buildReportEmail } = require('../server/services/reportEmails');
const { buildReportPdf, reportStats, insightStats, vsNormal } = require('../server/services/reportPdf');
const { pickCards, explainCard, verdictFor, buildMovers, findDivergences, findConcentration, gradeCalls, coverageNote, money } = require('../server/services/reportInsights');
const { writeCards, writeCardsForUser, checkCard, parseReply } = require('../server/services/cardWriter');
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

console.log('insights:');
const NOW = Date.parse('2026-10-12T09:00:00Z');
const book = [
  { ticker: 'TCS', asset_class: 'equity', sector: 'Information Technology', country: 'IN', exposure_pct: 30, weight_pct: 30, market_value: 3000, change_pct: -2, z: -1.4, sentiment_label: 'negative' },
  { ticker: 'INFY', asset_class: 'equity', sector: 'Information Technology', country: 'IN', exposure_pct: 20, weight_pct: 20, market_value: 2000, change_pct: 1.5, z: 0.1, sentiment_label: 'negative' },
  { ticker: 'AAPL', asset_class: 'equity', sector: 'Technology', country: 'US', exposure_pct: 50, weight_pct: 50, market_value: 5000, change_pct: 0.4, z: null, sentiment_label: 'neutral' },
];
const ev = (o) => ({ source: 'example.com', sectors: [], tickers: {}, isMacro: false, source_count: 1, last_seen: '2026-10-12T06:00:00Z', ...o });
const feed = [
  ev({ event_id: 1, title: 'TCS cuts revenue outlook after weak quarter', event_type: 'guidance', source_count: 4, tickers: { TCS: { score: 0.1, confidence: 0.9 } }, sectors: ['Information Technology'] }),
  ev({ event_id: 2, title: 'TCS revenue outlook cut rattles investors', event_type: 'guidance', tickers: { TCS: { score: 0.2, confidence: 0.9 } } }),
  ev({ event_id: 3, title: 'Chip shortage hits hardware makers', event_type: 'disruption', sectors: ['Technology'], tickers: { XYZ: { score: 0.1, confidence: 0.8 } } }),
  ev({ event_id: 4, title: 'RBI holds repo rate, Sensex steady', event_type: 'macro', isMacro: true, macroScore: 0.4 }),
  ev({ event_id: 5, title: 'Fed signals a pause on Wall Street', event_type: 'macro', isMacro: true, macroScore: 0.6 }),
];
const zs = { TCS: -1.4, INFY: 0.1, AAPL: null };
const picked = pickCards(feed, book, zs, { now: NOW });
const cards = picked.map((c) => explainCard(c, { fx: { currency: 'INR', rate: 100 }, zByTicker: zs, sectorByTicker: { AAPL: 'Technology' } }));
check('cards: stories about holdings first, one story once, at most one market-wide beside them', () => {
  assert.deepStrictEqual(picked.map((c) => c.channel), ['direct', 'sector', 'macro']);
  assert.deepStrictEqual(picked.map((c) => c.event.event_id).slice(0, 2), [1, 3]);
  assert.ok(!picked.some((c) => c.event.event_id === 2));
});
// One distinct key word per headline, so no two test headlines read as the same story.
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];
check('the bar: a busy day shows every strong story up to the cap; weak ones stay out', () => {
  const one = (t) => [{ ticker: t, asset_class: 'equity', sector: null, country: 'US', exposure_pct: 10, weight_pct: 10, market_value: 1000 }];
  const many = Array.from({ length: 9 }, (_, i) => one(`S${i}`)[0]);
  const strong = many.map((h, i) => ev({ event_id: 100 + i, title: `${WORDS[i]} takeover`, event_type: 'ma', tickers: { [h.ticker]: { score: 0.95, confidence: 0.9 } } }));
  const weak = many.map((h, i) => ev({ event_id: 200 + i, title: `${WORDS[i]} roundup`, event_type: 'other', tickers: { [h.ticker]: { score: 0.95, confidence: 0.9 } } }));
  const busy = pickCards([...strong, ...weak], many, {}, { now: NOW });
  assert.strictEqual(busy.length, 6);
  assert.ok(busy.every((c) => c.passed && c.strength >= 0.4 && c.event.event_id < 200));
  const normal = pickCards([...strong.slice(0, 3), ...weak], many, {}, { now: NOW });
  assert.deepStrictEqual(normal.map((c) => c.event.event_id).sort(), [100, 101, 102]);
});
check('the bar: a quiet day still shows its best two as background; a sliver of a position does not pass', () => {
  const hs = [{ ticker: 'AAA', asset_class: 'equity', sector: null, country: 'US', exposure_pct: 98, weight_pct: 98 }, { ticker: 'BBB', asset_class: 'equity', sector: null, country: 'US', exposure_pct: 2, weight_pct: 2 }];
  const quiet = [1, 2, 3].map((i) => ev({ event_id: 300 + i, title: `${WORDS[i]} note`, event_type: 'other', tickers: { AAA: { score: 0.9, confidence: 0.9 } } }));
  const picked = pickCards(quiet, hs, {}, { now: NOW });
  assert.ok(picked.length === 2 && picked.every((c) => !c.passed));
  const sliver = pickCards([ev({ event_id: 400, title: 'BBB takeover agreed', event_type: 'ma', tickers: { BBB: { score: 0.95, confidence: 0.9 } } })], hs, {}, { now: NOW });
  assert.strictEqual(sliver[0].passed, false);
});
check('a market-wide story about one country names only the holdings listed there', () => {
  const us = pickCards([feed[4]], book, zs, { now: NOW })[0];
  assert.deepStrictEqual(us.links.map((l) => l.ticker), ['AAPL']);
  assert.strictEqual(pickCards([feed[4]], book.slice(0, 2), zs, { now: NOW }).length, 0);
});
check('a direct card says what is held, in the report currency, and names the sector peer', () => {
  const c = cards[0];
  assert.strictEqual(c.why, 'You hold TCS directly: 30% of your portfolio (₹3,00,000). INFY (20%) is in the same sector and can move with it.');
  assert.ok(c.how.startsWith('Coverage of TCS in this story reads negative. News on TCS is running well below its own 90-day normal. TCS is down 2% in the latest session.'));
  assert.ok(c.how.includes('over days rather than hours'));
  assert.strictEqual(c.sure, '4 sources carry this story. The sentiment reading is clear-cut.');
  assert.strictEqual(c.needs_attention, true);
});
check('an indirect card says the link is indirect and is never a thing to check', () => {
  assert.ok(cards[1].why.startsWith('You do not hold the company in this story. AAPL, 50% of your portfolio (₹5,00,000), is in the same sector (Technology), so the link is indirect.'));
  assert.ok(cards[2].why.includes('market-wide story') && cards[2].why.endsWith('The link is indirect.'));
  assert.ok(cards[1].sure.startsWith('One source so far'));
  assert.ok(!cards[1].needs_attention && !cards[2].needs_attention);
});
check('no card predicts a price', () => {
  for (const c of cards) assert.ok(!/\b(will|expect|target|forecast)\b/i.test(`${c.why} ${c.how} ${c.sure}`));
});
check('verdict: counts only the cards that need attention; otherwise says nothing does', () => {
  const v = verdictFor(cards);
  assert.deepStrictEqual([v.level, v.count, v.text, v.detail], ['check', 1, '1 thing to check today', feed[0].title]);
  const calm = verdictFor(cards.slice(1), 'weekly');
  assert.deepStrictEqual([calm.level, calm.text], ['calm', 'Nothing specific to your holdings needs your attention this week.']);
  assert.strictEqual(verdictFor([]).detail, 'No story cleared the bar for your holdings.');
});
check('the subject leads with the verdict; the body still says nothing about the portfolio', () => {
  const m = buildReportEmail('daily', { name: 'Asha', date: '2026-10-12', verdict: verdictFor(cards) });
  assert.strictEqual(m.subject, '[SenIQ] 1 thing to check: TCS cuts revenue outlook after weak quarter — 12 October 2026');
  assert.ok(!m.text.includes('TCS') && !m.html.includes('TCS'));
  assert.strictEqual(buildReportEmail('weekly', { date: '2026-10-11', verdict: verdictFor([], 'weekly') }).subject, '[SenIQ] Nothing needs your attention this week — 11 October 2026');
});
check('movers: each holding\'s share of the move adds up to the portfolio\'s move, biggest first', () => {
  const m = buildMovers(book, { TCS: 'TCS cuts outlook' });
  assert.deepStrictEqual(m.rows.map((r) => [r.ticker, r.contribution_pct]), [['TCS', -0.6], ['INFY', 0.3], ['AAPL', 0.2]]);
  assert.strictEqual(m.portfolio_change_pct, -0.1);
  assert.deepStrictEqual(m.rows.map((r) => r.news), ['TCS cuts outlook', null, null]);
});
check('divergence: a 1%+ move against the news; agreement and small moves are not flagged', () => {
  assert.deepStrictEqual(findDivergences(book).map((d) => d.ticker), ['INFY']);
});
check('concentration: a holding at 30%+ and a sector at 40%+ are named; the market split adds up', () => {
  const c = findConcentration(book);
  assert.ok(c.lines[0].startsWith('AAPL alone is 50%'));
  assert.ok(c.lines[1].startsWith('TCS and INFY are all Information Technology: 50%'));
  assert.deepStrictEqual(c.split, [{ label: 'India-listed', pct: 50 }, { label: 'US-listed', pct: 50 }]);
  assert.deepStrictEqual(findConcentration([{ ...book[0], exposure_pct: 25 }, { ...book[2], exposure_pct: 25 }]).lines, []);
});
check('track record: one call per ticker per day, neutral readings skipped, misses counted', () => {
  const g = gradeCalls([
    { ticker: 'NVDA', sentiment_score: 0.9, move_1d: -0.01, first_seen: '2026-10-07T03:00:00Z' },
    { ticker: 'NVDA', sentiment_score: 0.8, move_1d: -0.01, first_seen: '2026-10-07T09:00:00Z' },
    { ticker: 'AAPL', sentiment_score: 0.2, move_1d: -0.02, first_seen: '2026-10-07T03:00:00Z' },
    { ticker: 'MSFT', sentiment_score: 0.5, move_1d: 0.03, first_seen: '2026-10-07T03:00:00Z' },
    { ticker: 'BTC', sentiment_score: 0.9, move_1d: 0.001, first_seen: '2026-10-06T03:00:00Z' },
  ], ['NVDA']);
  assert.deepStrictEqual([g.calls, g.matched, g.missed, g.flat], [3, 1, 1, 1]);
  assert.deepStrictEqual(g.mine.map((r) => [r.ticker, r.stories, r.call, r.result]), [['NVDA', 2, 'positive', 'missed']]);
});
check('coverage note names thin holdings; money rounds in the report currency', () => {
  assert.strictEqual(coverageNote({ TCS: 40, AAPL: 1 }, ['TCS', 'AAPL', 'XAU']).text,
    'SenIQ read 41 articles on your holdings in the last 3 days. Coverage was thin (2 or fewer) on AAPL and XAU, so readings there are less reliable.');
  assert.strictEqual(money(2608.4, { currency: 'INR', rate: 96.78 }), '₹2,52,400');
  assert.strictEqual(money(2137.2), '$2,100');
  assert.strictEqual(money(null), null);
});
const insights = {
  verdict: verdictFor(cards), cards, movers: buildMovers(book, { TCS: feed[0].title }), divergences: findDivergences(book),
  concentration: findConcentration(book), coverage: coverageNote({ TCS: 40 }, ['TCS', 'AAPL']), portfolio_value: '₹10,00,000',
  trackRecord: gradeCalls(Array.from({ length: 24 }, (_, i) => ({ ticker: i % 2 ? 'TCS' : `T${i}`, sentiment_score: 0.9, move_1d: i % 3 ? 0.01 : -0.01, first_seen: new Date(NOW - i * 86_400_000).toISOString() })), ['TCS']),
};
check('figures strip with insights: value, latest move, things to check, holdings, largest position', () => {
  assert.deepStrictEqual(insightStats({ holdings, insights }).map((s) => s.value), ['₹10,00,000', '−0.10%', '1', '2', 'NVDA 60%']);
});

console.log('written cards (Plus/Pro):');
const tcsCard = cards[0];
const good = {
  id: tcsCard.event_id,
  why: 'TCS is one of your own holdings, at 30% of your portfolio (₹3,00,000). INFY, another 20%, sits in the same sector and can move with it.',
  how: 'This story reads negative for TCS, and news on it is well below its 90-day normal. TCS is down 2% in the latest session. A change in outlook tends to work through a price over days.',
  sure: '4 sources carry this story and the reading is clear-cut.',
};
check('a faithful rewrite passes; the template itself passes its own check', () => {
  assert.deepStrictEqual(checkCard(tcsCard, good), { ok: true, reason: 'ok', what: null });
  for (const c of cards) assert.ok(checkCard(c, c).ok, c.why);
});
check('a rewrite is rejected for a new figure, a new name, advice, a forecast or markup', () => {
  const bad = (patch) => checkCard(tcsCard, { ...good, ...patch });
  assert.strictEqual(bad({ why: `${good.why} That is 35% with INFY.` }).reason, 'why: figure 35');
  assert.strictEqual(bad({ how: `${good.how} WIPRO fell too.` }).reason, 'how: name WIPRO');
  assert.strictEqual(bad({ how: 'You should sell TCS.' }).reason, 'how: "You should"');
  assert.strictEqual(bad({ how: 'TCS will fall further.' }).reason, 'how: "will fall"');
  assert.strictEqual(bad({ why: `${good.why} The results will be a primary driver of the price.` }).reason, 'why: "will"');
  assert.ok(!bad({ how: 'This looks like a chance to buy TCS.' }).ok && !bad({ how: 'TCS is likely to rebound.' }).ok && !bad({ sure: 'Analysts raised the price target.' }).ok);
  assert.ok(bad({ how: 'TCS plans to buy a rival and reports results on the day.' }).ok && bad({ sure: 'More sources will confirm or correct this.' }).ok);
  assert.ok(!bad({ sure: '**4 sources** carry this story.' }).ok);
  assert.ok(!bad({ sure: '' }).ok && !checkCard(tcsCard, null).ok);
});
check('a rewrite may not drop the "indirect" or single-source caveats', () => {
  const sectorCard = cards[1];
  const w = { why: 'AAPL, 50% of your portfolio (₹5,00,000), shares a sector with this story.', how: sectorCard.how, sure: 'This comes from a single outlet.' };
  assert.strictEqual(checkCard(sectorCard, w).reason, 'why: dropped "indirect"');
  assert.strictEqual(checkCard(sectorCard, { ...w, why: `${w.why} The link is indirect.`, sure: 'Fairly solid.' }).reason, 'sure: dropped the single-source caveat');
  assert.ok(checkCard(sectorCard, { ...w, why: `${w.why} The link is indirect.`, sure: 'One source so far.' }).ok);
});
check('"what happened" may draw on the article summary, and only on it', () => {
  const withSummary = { ...tcsCard, summary: 'TCS trimmed its revenue outlook to 1-3% after two large clients in Europe paused projects.' };
  const what = 'Two big European clients paused work, so TCS lowered its revenue outlook to 1-3%.';
  assert.strictEqual(checkCard(withSummary, { ...good, what }).what, what);
  // A faulty "what happened" costs only that line; the rest of the card still stands.
  const dropsWhat = (card, w) => { const c = checkCard(card, { ...good, what: w }); assert.ok(c.ok && c.what === null); return c.whatFault; };
  assert.strictEqual(dropsWhat(withSummary, `${what} That is its lowest since 2020.`), 'what: figure 2020');
  assert.strictEqual(dropsWhat(withSummary, withSummary.summary), 'what: copied from the summary');
  assert.strictEqual(dropsWhat(withSummary, 'A chance to buy TCS.'), 'what: "chance to buy"');
  assert.strictEqual(dropsWhat(tcsCard, what), 'what: no summary to draw on');
  assert.strictEqual(checkCard(withSummary, { ...good, what: '' }).whatFault, undefined);
  // A fault in why/how/sure still sends the whole card back, whatever "what" says.
  assert.ok(!checkCard(withSummary, { ...good, what, how: 'You should sell TCS.' }).ok);
});
check('the reply parser takes fenced JSON and ignores anything else', () => {
  assert.deepStrictEqual(Object.keys(parseReply('```json\n{"cards":[{"id":1,"why":"a"}]}\n```')), ['1']);
  assert.deepStrictEqual(parseReply('Sorry, I cannot.'), {});
  assert.deepStrictEqual(parseReply('{"cards": "nope"}'), {});
});

(async () => {
  const reply = (list) => async () => ({ text: JSON.stringify({ cards: list }), model: 'm', usage: { input: 10, output: 5 } });
  await checkAsync('writeCards: a good card is rewritten, a bad one keeps its template, per card', async () => {
    const r = await writeCards(cards, { allowClaude: true, claudeFn: reply([good, { id: cards[1].event_id, why: 'Buy AAPL.', how: 'x', sure: 'y' }]) });
    assert.deepStrictEqual(r.cards.map((c) => c.writer), ['claude', 'template', 'template']);
    assert.strictEqual(r.cards[0].why, good.why);
    assert.strictEqual(r.cards[0].what, null);
    const withSummary = cards.map((c) => ({ ...c, summary: 'TCS trimmed its revenue outlook to 1-3% after two large clients in Europe paused projects.' }));
    const lifted = await writeCards(withSummary, { allowClaude: true, claudeFn: reply([{ ...good, what: withSummary[0].summary }]) });
    assert.ok(lifted.cards[0].writer === 'claude' && lifted.cards[0].what === null && lifted.cards[0].why === good.why);
    assert.deepStrictEqual(lifted.dropped, [{ id: cards[0].event_id, reason: 'what: copied from the summary' }]);
    assert.strictEqual(r.cards[1].why, cards[1].why);
    assert.deepStrictEqual(r.rejected.map((x) => x.id), [cards[1].event_id, cards[2].event_id]);
    assert.ok(r.called && r.cards[0].needs_attention === true);
  });
  await checkAsync('writeCards: not allowed, a failed call or a junk reply all return the template cards', async () => {
    let calls = 0;
    const off = await writeCards(cards, { allowClaude: false, claudeFn: async () => { calls++; } });
    assert.ok(calls === 0 && !off.called && off.cards.every((c) => c.writer === 'template'));
    const down = await writeCards(cards, { allowClaude: true, claudeFn: async () => { throw new Error('down'); } });
    assert.ok(!down.called && down.cards[0].why === cards[0].why);
    const junk = await writeCards(cards, { allowClaude: true, claudeFn: async () => ({ text: 'no json', model: 'm', usage: { input: 1, output: 1 } }) });
    assert.ok(junk.called && junk.cards.every((c) => c.writer === 'template'));
  });
  await checkAsync('a Free account never reaches the model or the database', async () => {
    const r = await writeCardsForUser(1, 'free', cards);
    assert.ok(r.guard === 'tier' && r.cards.every((c) => c.writer === 'template'));
  });
  await checkAsync('a report with insights renders, and takes more room than one without', async () => {
    const base = { kind: 'daily', dateLabel: 'Monday, 12 October 2026', events, holdings };
    const plain = await buildReportPdf(base);
    const full = await buildReportPdf({ ...base, insights });
    const thin = await buildReportPdf({ ...base, insights: { ...insights, cards: [], verdict: verdictFor([]), trackRecord: gradeCalls([]) } });
    for (const pdf of [full, thin]) assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
    const pages = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    assert.ok(pages(full) > pages(plain));
  });
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
