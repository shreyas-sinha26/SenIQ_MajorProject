/**
 * Offline tests for Ask's IPO Watch tools (services/ipoTools.js): the card an issue becomes,
 * the order issues come in, the one-figure orderings, fitting a result to its allowance,
 * finding an issue by the name a user wrote, and the refusals that come before any query.
 * No network, no database, no model.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const { QA } = require('../server/config');
const T = require('../server/services/ipoTools');
const W = require('../server/services/ipoWatch');
const { runTool } = require('../server/services/qaTools');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}

console.log('ipoTools:');

// Rows in the shape listCalendar returns them.
const closed = {
  id: 6, market: 'IN', name: 'R.K.Fashion Accessories', board: 'sme', stage: 'closed', exchange: 'NSE', symbol: null,
  open_date: '2026-10-05', close_date: '2026-10-07', allotment_date: '2026-10-08', listing_date: '2026-10-12',
  price_low: null, price_high: 82, issue_size_cr: 34.99, lot_size: 1600, is_spac: false, stories: 0,
  sub_total: 2.7, sub_qib: 14.11, sub_nii: 1.77, sub_retail: 3.11, sub_on: '2026-10-07',
  gmp: 1.5, gmp_pct: 1.8, gmp_prev: 7, gmp_at: '2026-10-09T07:36:55.670Z', gmp_source: 'investorgain',
};
const usListed = {
  id: 320, market: 'US', name: 'Chilwa Minerals Ltd', board: null, stage: 'listed', exchange: 'NASDAQ Capital', symbol: 'CHWM',
  listing_date: '2026-10-01', first_trade_date: '2026-10-01', source_status: 'priced', price_low: null, price_high: 5.6,
  issue_size_usd: 3500000, shares: 625000, is_spac: false, stories: 1, gmp: null, sub_total: null,
  listing_price: 6, listing_gain_pct: 7.14, listing_price_derived: false, ret_listing_day_pct: 17.86, ret_1w_pct: -8.21,
};
const row = (over) => ({ id: 1, market: 'IN', name: 'A', board: 'mainboard', stage: 'upcoming', stories: 0, ...over });

check('the lists a tool\'s schema offers are the calendar\'s own', () => {
  assert.deepStrictEqual(T.STAGES.slice().sort(), W.STAGES.slice().sort());
  assert.deepStrictEqual(T.MARKETS, W.MARKETS);
  assert.deepStrictEqual(T.BOARDS, W.BOARDS);
  const props = T.IPO_TOOLS[0].input_schema.properties;
  assert.deepStrictEqual([props.market.enum, props.stage.enum, props.board.enum], [T.MARKETS, T.STAGES, T.BOARDS]);
});

check('an IPO question is told by its words, not by the companies it names', () => {
  for (const q of ['Which IPO looks promising?', 'How is the Jio ipo doing', 'What is the GMP of Fusion CX?', 'grey market premium today', 'any public issues open?', 'upcoming IPOs']) assert.ok(T.isIpoQuestion(q), q);
  for (const q of ['Give me the latest news on Tesla', 'Why is my portfolio down?', 'What is a tipoff?', '']) assert.ok(!T.isIpoQuestion(q), q);
});

check('card: an Indian issue with its figures, each dated; nothing empty is sent', () => {
  const c = T.issueCard(closed);
  assert.deepStrictEqual(c, {
    id: 'i6', name: 'R.K.Fashion Accessories', market: 'IN', board: 'sme', stage: 'closed',
    dates: 'bidding closed 7 Oct 2026, lists 12 Oct 2026',
    price: '₹82', size: '₹34.99 crore',
    subscription: { total_x: 2.7, qib_x: 14.11, nii_x: 1.77, retail_x: 3.11, as_of: '2026-10-07' },
    gmp: { inr: 1.5, pct_of_price: 1.8, as_of: '2026-10-09', reading_before: 7 },
  });
});

check('card: the premium\'s date is the day in India, not in UTC', () => {
  assert.strictEqual(T.issueCard({ ...closed, gmp_at: '2026-10-09T20:00:00Z' }).gmp.as_of, '2026-10-10');   // 01:30 IST next day
});

check('card: no premium is sent once the page stops showing one, and none is made up', () => {
  const c = T.issueCard({ ...closed, gmp: null, gmp_pct: null, gmp_at: null });   // gmpView cleared it: stale, or listed
  assert.ok(!('gmp' in c));
  assert.ok(!('gmp' in T.issueCard(usListed)) && !('subscription' in T.issueCard(usListed)));
});

check('card: a US issue is in dollars, in millions, with the source\'s own status', () => {
  const c = T.issueCard(usListed);
  assert.deepStrictEqual([c.price, c.size, c.us_status, c.symbol, c.board], ['$5.6', '$3.5 million', 'priced', 'CHWM', undefined]);
  assert.deepStrictEqual(c.listing, { price: 6, gain_pct: 7.14 });                 // "worked back" only when it was
  assert.deepStrictEqual(c.returns_pct, { listing_day: 17.86, week_1: -8.21 });    // later horizons not yet reached
  assert.strictEqual(T.issueCard({ ...usListed, listing_price_derived: true }).listing.price_worked_back_from_gain, true);
  assert.strictEqual(T.issueCard({ ...usListed, issue_size_usd: null }).size, undefined);
});

check('card: money is written out once; the band is fine print, and only when there is one', () => {
  const banded = { ...closed, price_low: 78, issue_size_cr: 712.31 };
  const c = T.issueCard(banded, { full: true });
  assert.deepStrictEqual([c.price, c.price_band, c.size], ['₹82', '₹78 to ₹82', '₹712.31 crore']);
  assert.ok(!('price_band' in T.issueCard(banded)));
  assert.ok(!('price_band' in T.issueCard(closed, { full: true })) && !('price_band' in T.issueCard({ ...closed, price_low: 82 }, { full: true })));
});

check('card: its dates are one phrase for its stage, the year left off when it is this year\'s', () => {
  const on = (over) => T.issueCard(row({ open_date: '2026-10-13', close_date: '2026-10-15', listing_date: '2026-10-21', ...over }), { today: '2026-10-11' }).dates;
  assert.strictEqual(on({}), 'bidding 13 to 15 Oct');
  assert.strictEqual(on({ open_date: '2026-09-30', close_date: '2026-10-02' }), 'bidding 30 Sep to 2 Oct');
  assert.strictEqual(on({ stage: 'open' }), 'bidding open until 15 Oct');
  assert.strictEqual(on({ stage: 'closed' }), 'bidding closed 15 Oct, lists 21 Oct');
  assert.strictEqual(on({ stage: 'listed' }), 'listed 21 Oct');
  assert.strictEqual(on({ stage: 'announced', open_date: null }), undefined);
  assert.strictEqual(on({ market: 'US', listing_date: '2026-10-15' }), 'expected 15 Oct');
  assert.strictEqual(on({ market: 'US', listing_date: '2026-10-09' }), 'was expected 9 Oct');
  assert.strictEqual(on({ market: 'US', stage: 'announced', status_date: '2025-12-30' }), 'filed 30 Dec 2025');
  // The one-issue view keeps each date on its own as well.
  assert.strictEqual(T.issueCard(closed, { full: true }).listing_date, '2026-10-12');
  assert.ok(!('listing_date' in T.issueCard(closed)));
});

check('a stale calendar is one ready line, with the day it was last refreshed', () => {
  assert.strictEqual(T.staleLine(['IN'], { IN: '2026-10-09' }, '2026-10-11'), 'India calendar last refreshed 9 Oct.');
  assert.strictEqual(T.staleLine(['IN', 'US'], { IN: '2026-10-09', US: null }, '2026-10-11'), 'India calendar last refreshed 9 Oct. US calendar last refreshed at a time not on record.');
  assert.strictEqual(T.staleLine([], {}, '2026-10-11'), null);
});

check('card: a US issue still called expected after its date says so', () => {
  const late = { ...usListed, stage: 'upcoming', source_status: 'expected', first_trade_date: null, listing_date: '2026-10-09' };
  assert.strictEqual(T.issueCard(late, { today: '2026-10-11' }).listing_date_passed, true);
  assert.ok(!('listing_date_passed' in T.issueCard(late, { today: '2026-10-09' })));
  assert.ok(!('listing_date_passed' in T.issueCard(late)));
});

check('card: news is a count, with the tone when stories have been read', () => {
  assert.deepStrictEqual(T.issueCard({ ...closed, stories: 3 }).news, { stories: 3 });
  assert.deepStrictEqual(T.issueCard({ ...closed, stories: 3 }, { tone: { label: 'positive', score: 0.7, stories: 2 } }).news,
    { stories: 3, tone: 'positive', tone_score: 0.7, stories_read: 2 });
  assert.ok(!('news' in T.issueCard(closed)));
});

check('card: the one-issue view adds the fine print and leaves news to its own block', () => {
  const c = T.issueCard({ ...closed, stories: 3 }, { full: true });
  assert.deepStrictEqual([c.exchange, c.allotment_date, c.lot_size], ['NSE', '2026-10-08', 1600]);
  assert.ok(!('news' in c));
});

check('order: by stage, open first; mainboard and US before SME within a stage', () => {
  const rows = [
    row({ id: 1, stage: 'announced' }), row({ id: 2, stage: 'closed' }), row({ id: 3, stage: 'upcoming', board: 'sme', open_date: '2026-10-11' }),
    row({ id: 4, stage: 'open', board: 'sme' }), row({ id: 5, stage: 'upcoming', open_date: '2026-10-14' }),
    row({ id: 6, stage: 'upcoming', market: 'US', board: null, listing_date: '2026-10-13' }), row({ id: 7, stage: 'listed' }),
  ];
  assert.deepStrictEqual(T.orderIssues(rows).map((r) => r.id), [4, 6, 5, 3, 2, 1, 7]);
});

check('order: what is coming by soonest date; the rest by most stories, then latest', () => {
  const coming = [row({ id: 1, open_date: '2026-10-20' }), row({ id: 2, open_date: null }), row({ id: 3, open_date: '2026-10-12' })];
  assert.deepStrictEqual(T.orderIssues(coming).map((r) => r.id), [3, 1, 2]);       // undated last
  const filed = [
    row({ id: 1, stage: 'announced', stories: 0, status_date: '2026-10-08' }), row({ id: 2, stage: 'announced', stories: 13 }),
    row({ id: 3, stage: 'announced', stories: 0, status_date: '2026-10-09' }),
  ];
  assert.deepStrictEqual(T.orderIssues(filed).map((r) => r.id), [2, 3, 1]);
});

check('orderings: each by one recorded figure, dated, with SME marked', () => {
  const o = T.orderings([
    { name: 'A', board: 'mainboard', sub_total: 3, sub_on: '2026-10-07', gmp_pct: 5, gmp_at: '2026-10-09T07:00:00Z' },
    { name: 'B', board: 'sme', sub_total: 40, sub_on: '2026-10-06', gmp_pct: 20, gmp_at: '2026-10-09T07:00:00Z' },
    { name: 'C', board: 'mainboard' },
  ]);
  assert.strictEqual(o.by_subscription, '1. B (SME) 40x, as of 6 Oct 2026; 2. A 3x, as of 7 Oct 2026');
  assert.strictEqual(o.by_gmp_pct, '1. B (SME) 20% of the issue price, unofficial, as of 9 Oct 2026; 2. A 5% of the issue price, unofficial, as of 9 Oct 2026');
  assert.deepStrictEqual(Object.keys(o), ['by_subscription', 'by_gmp_pct']);       // nothing listed → no gains
  assert.deepStrictEqual(T.orderings([{ name: 'C' }]), {});
  assert.ok(!Object.keys(o).some((k) => /overall|score|rating|best/.test(k)));
});

check('orderings: size within a market, and what comes soonest', () => {
  const o = T.orderings([
    row({ name: 'Big', issue_size_cr: 712.31, open_date: '2026-10-14' }),
    row({ name: 'Small', board: 'sme', issue_size_cr: 42.1, open_date: '2026-10-13' }),
    row({ name: 'Yank', market: 'US', board: null, issue_size_usd: 183300000, listing_date: '2026-10-15' }),
    row({ name: 'Late', market: 'US', board: null, issue_size_usd: 49300000, listing_date: '2026-10-09' }),
    row({ name: 'Done', stage: 'closed', issue_size_cr: 9000 }),
  ], { today: '2026-10-11' });
  assert.strictEqual(o.by_size_india, '1. Big ₹712.31 crore; 2. Small (SME) ₹42.1 crore');   // an issue no longer ahead is not ranked by size
  assert.strictEqual(o.by_size_us, '1. Yank $183.3 million; 2. Late $49.3 million');
  // A date already past is not "soonest".
  assert.strictEqual(o.soonest, '1. Small (SME) bidding opens 13 Oct; 2. Big bidding opens 14 Oct; 3. Yank expected to list 15 Oct');
});

check('orderings: demand can be read across more issues than are shown, each marked', () => {
  const shown = [row({ name: 'Next' })];
  const o = T.orderings(shown, { demand: [...shown, { name: 'Shut', board: 'sme', stage: 'closed', sub_total: 2.7, sub_on: '2026-10-07' }] });
  assert.strictEqual(o.by_subscription, '1. Shut (SME, bidding closed) 2.7x, as of 7 Oct 2026');
  assert.ok(!('by_subscription' in T.orderings(shown)));
});

check('orderings: listing gains come with both ends and the count that gained', () => {
  const gains = [90, 40, 12, 2, 0, -5, -14, -20].map((g, i) => ({ name: `N${i}`, board: 'mainboard', listing_gain_pct: g, listing_date: '2026-10-05' }));
  const o = T.orderings(gains);
  assert.strictEqual(o.listing_gains, '8 with a listing result: 4 above the issue price, 3 below, 1 at it; median 1%');
  assert.strictEqual(o.highest_listing_gain, '1. N0 90%, listed 5 Oct 2026; 2. N1 40%, listed 5 Oct 2026; 3. N2 12%, listed 5 Oct 2026');
  assert.strictEqual(o.lowest_listing_gain, '1. N7 -20%, listed 5 Oct 2026; 2. N6 -14%, listed 5 Oct 2026; 3. N5 -5%, listed 5 Oct 2026');
  const few = T.orderings(gains.slice(0, 3));
  assert.ok(few.highest_listing_gain && !('lowest_listing_gain' in few));          // the top list already holds them all
  assert.strictEqual(few.listing_gains, '3 with a listing result: 3 above the issue price, 0 below, 0 at it; median 40%');
});

check('counts: issues by market and stage', () => {
  assert.deepStrictEqual(T.stageCounts([row({}), row({}), row({ stage: 'listed' }), row({ market: 'US', stage: 'announced' })]),
    { IN: { upcoming: 2, listed: 1 }, US: { announced: 1 } });
});

check('fit: cards are dropped from the end until the result fits, and the rest are counted', () => {
  const issues = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, name: 'x'.repeat(300) }));
  const out = T.fitIssues({ as_of: '2026-10-10', issues }, 25, 2000);
  assert.ok(JSON.stringify(out).length <= 2000);
  assert.ok(out.issues.length < 10 && out.issues[0].id === 'i0');
  assert.strictEqual(out.not_shown, `${25 - out.issues.length} more issues match; narrow with market, stage or board to see them.`);
  assert.strictEqual(T.fitIssues({ issues: issues.slice(0, 2) }, 2).not_shown, undefined);       // everything shown
  assert.strictEqual(T.fitIssues({ issues: issues.slice(0, 2) }, 3).not_shown, '1 more issue matches; narrow with market, stage or board to see them.');
  assert.strictEqual(T.fitIssues({ issues }, 10, 50).issues.length, 1);            // never down to nothing
  assert.strictEqual(issues.length, 10);                                           // the caller's list is left alone
});

check('the default allowance is the one runTool cuts at', async () => {
  const issues = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, name: 'x'.repeat(200) }));
  const out = T.fitIssues({ issues }, 40);
  const r = await runTool({ id: 't', name: 'x', input: {} }, {}, { x: async () => out });
  assert.ok(r.content.length <= QA.MAX_TOOL_RESULT_CHARS && !/truncated\]$/.test(r.content));
});

const calendar = [
  { id: 2, market: 'IN', name: 'Jio Platforms' }, { id: 6, market: 'IN', name: 'R.K.Fashion Accessories' },
  { id: 7, market: 'IN', name: 'Acme India Industries' }, { id: 24, market: 'IN', name: 'SRIT India' },
  { id: 30, market: 'IN', name: 'German Green Steel' }, { id: 320, market: 'US', name: 'Chilwa Minerals Ltd', symbol: 'CHWM' },
];
check('find: the same name, however it is written', () => {
  const ids = (name) => T.matchIssues(calendar, name).map((r) => r.id);
  assert.deepStrictEqual(ids('Jio Platforms Limited IPO'), [2]);
  assert.deepStrictEqual(ids('german green steel'), [30]);
  assert.deepStrictEqual(ids('RK Fashion Accessories'), [6]);                      // initials the user wrote together
});
check('find: part of a name as whole words, or the ticker; several hits are all returned', () => {
  const ids = (name) => T.matchIssues(calendar, name).map((r) => r.id);
  assert.deepStrictEqual(ids('Jio'), [2]);
  assert.deepStrictEqual(ids('the Jio Platforms mega issue'), [2]);                // the user's words hold the name
  assert.deepStrictEqual(ids('CHWM'), [320]);
  assert.deepStrictEqual(ids('$chwm'), [320]);
  assert.deepStrictEqual(ids('India'), [7, 24]);                                   // for the caller to put back to the user
  assert.deepStrictEqual(ids('Tesla'), []);
  assert.deepStrictEqual(ids('Ji'), []);                                           // too short to mean anything
  assert.deepStrictEqual(ids('Ltd'), []);                                          // nothing left once the suffix is gone
  assert.deepStrictEqual(ids('Green'), [30]);
  assert.deepStrictEqual(ids('reen'), []);                                         // not part of a word
});

check('news: latest stories with outlet, date and tone; unread ones say why', () => {
  const stories = Array.from({ length: 7 }, (_, i) => ({ title: `Story ${i} ${'y'.repeat(200)}`, source: 'livemint.com', day: `2026-10-0${9 - i}`, sentiment: { label: 'positive', score: 0.8 } }));
  stories[1] = { ...stories[1], sentiment: null, shared: true };
  stories[2] = { ...stories[2], sentiment: null, passing: true };
  const n = T.newsBlock({ stories, tone: { label: 'positive', score: 0.7, stories: 5 }, arc: Array.from({ length: 9 }, (_, i) => ({ day: `2026-10-0${i + 1}`, stories: 1, score: 0.6 })) });
  assert.strictEqual(n.stories_linked, 7);
  assert.deepStrictEqual(n.tone, { label: 'positive', score: 0.7, stories_read: 5 });
  assert.strictEqual(n.tone_by_day.length, QA.IPO_DETAIL_DAYS);
  assert.strictEqual(n.latest.length, QA.IPO_DETAIL_STORIES);
  assert.strictEqual(n.older_not_shown, 2);
  assert.ok(n.latest[0].title.length <= 110 && n.latest[0].tone === 'positive' && n.latest[0].date === '2026-10-09');
  assert.deepStrictEqual([n.latest[1].tone, n.latest[1].not_read], [undefined, 'covers several issues']);
  assert.strictEqual(n.latest[2].not_read, 'names the issue only below the headline');
});
check('news: an issue nothing was written about, and one whose stories are unread', () => {
  assert.deepStrictEqual(T.newsBlock({ stories: [], arc: [], tone: null }), { stories_linked: 0 });
  assert.deepStrictEqual(T.newsBlock(null), { stories_linked: 0 });
  const n = T.newsBlock({ stories: [{ title: 'T', source: 'S', day: '2026-10-03', sentiment: null, passing: true }], arc: [], tone: null });
  assert.deepStrictEqual(Object.keys(n), ['stories_linked', 'latest']);            // no tone is claimed
});

check('digest: the no-model answer lists what is ahead, one issue to a line, then the orderings', () => {
  const text = T.ipoDigest({
    as_of: '2026-10-11',
    markets: ['IN', 'US'],
    counts: { IN: { upcoming: 2, closed: 1, listed: 44 }, US: { upcoming: 1, announced: 21 } },
    refreshed: { IN: '2026-10-09', US: null },
    orderings: { by_subscription: '1. A (SME, bidding closed) 3x, as of 7 Oct', by_gmp_pct: '1. B 20% of the issue price, unofficial, as of 9 Oct', by_size_india: '1. HD Fire Protect ₹712.31 crore; 2. Ravita (SME) ₹116.05 crore' },
    not_shown: '3 more issues match; narrow with market, stage or board to see them.',
    issues: [
      { name: 'HD Fire Protect', market: 'IN', board: 'mainboard', stage: 'upcoming', dates: 'bidding 13 to 15 Oct', price: '₹271', size: '₹712.31 crore' },
      { name: 'Ravita', market: 'IN', board: 'sme', stage: 'upcoming' },
      { name: 'TRex Bio', market: 'US', stage: 'upcoming', dates: 'was expected 9 Oct', listing_date_passed: true, price: '$16', size: '$153.3 million' },
    ],
  });
  assert.deepStrictEqual(text.split('\n'), [
    'India: 2 upcoming (calendar refreshed 9 Oct).',
    'HD Fire Protect · mainboard · bidding 13 to 15 Oct · ₹271 · ₹712.31 crore',
    'Ravita · sme',
    'US: 1 upcoming (calendar refreshed never).',
    'TRex Bio · was expected 9 Oct · $16 · $153.3 million',
    '3 more issues match.',
    '',
    'Most subscribed: 1. A (SME, bidding closed) 3x, as of 7 Oct.',
    'Grey market premium: 1. B 20% of the issue price, unofficial, as of 9 Oct.',
    'Largest in India: HD Fire Protect ₹712.31 crore.',
    '',
    '(Auto-generated from IPO Watch — turn on the AI writer for a fuller answer.) Educational only, not investment advice.',
  ]);
  assert.ok(!/promising|recommend|should|best/i.test(text));
  const open = T.ipoDigest({ markets: ['IN'], counts: {}, refreshed: {}, orderings: {}, issues: [{ name: 'X', market: 'IN', board: 'mainboard', stage: 'open', dates: 'bidding open until 15 Oct' }] });
  assert.deepStrictEqual(open.split('\n').slice(0, 2), ['India: nothing open or coming up (calendar refreshed never).', 'X · mainboard · bidding open until 15 Oct']);
});

check('a wrong market, stage or board is refused before any query', async () => {
  for (const [input, what] of [[{ market: 'UK' }, 'market'], [{ stage: 'hot' }, 'stage'], [{ board: 'main' }, 'board']]) {
    const r = await runTool({ id: 'c', name: 'get_ipo_calendar', input }, {}, T.IPO_EXECUTORS);
    assert.ok(r.is_error && r.content.startsWith(`${what} must be one of`), r.content);
  }
});
check('get_ipo_detail needs an id or a name (no query runs)', async () => {
  for (const input of [{}, { id: '  ', name: '' }]) {
    const r = await runTool({ id: 'd', name: 'get_ipo_detail', input }, {}, T.IPO_EXECUTORS);
    assert.ok(r.is_error && /id or name is required/.test(r.content));
  }
});

check('the tools only read, and neither takes a ticker', () => {
  assert.deepStrictEqual(T.IPO_TOOLS.map((x) => x.name), ['get_ipo_calendar', 'get_ipo_detail']);
  assert.ok(T.IPO_TOOLS.every((x) => /^get_/.test(x.name) && !('ticker' in x.input_schema.properties)));
  assert.deepStrictEqual(Object.keys(T.IPO_EXECUTORS), T.IPO_TOOLS.map((x) => x.name));
});

check('the rules: compare and never pick, premium unofficial and dated, one closing line', () => {
  const p = T.IPO_PROMPT;
  assert.ok(/Compare, never pick\./.test(p) && /does not rate or predict issues/.test(p));
  assert.ok(/call it unofficial and give its date/.test(p) && /never work out an expected listing price/.test(p));
  assert.ok(p.trimEnd().endsWith('"Educational only, not investment advice."'));
  // The prompt is evidence to the grounding check: a figure in it would vouch for the same figure in an answer.
  assert.ok(!/\d/.test(p));
  // So is a tool result, and the answer shape goes out in one.
  assert.ok(!/\d/.test(T.CALENDAR_SHAPE) && !/\d/.test(T.DETAIL_SHAPE));
  assert.ok(/one issue to a line/.test(T.CALENDAR_SHAPE) && /follow it/.test(require('../server/services/qa').SYSTEM_PROMPT));
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed`);
})();
