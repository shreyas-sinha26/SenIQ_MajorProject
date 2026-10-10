/**
 * Offline tests for the IPO Watch calendar: cleaning what a source returns, merging one
 * issue seen by two sources, the lifecycle stage, and the poller's handling of a source
 * that fails. No network and no database (the poller's save step is passed in).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const { IPO_WATCH } = require('../server/config');
const { calendarAge, nameKey, normalizeIssue, mergeIssues, stageOf, marketDate, pollCalendar, gmpReadings, gmpView, cleanSubscription, cleanHistory, outcomesOf, listingGain, priceFromGain } = require('../server/services/ipoWatch');
const { buildMatcher, joinInitials, pickSymbol, looseKey, priceConfirms, referenceExchange } = require('../server/services/ipoWatch/registry');
const { namesHolding, coreName, setIpoTier } = require('../server/services/entityResolver');
const { parseBars, barOnOrAfter, returnsFrom, firstTradeDay, usDate } = require('../server/services/ipoWatch/returns');
const { arcOf, toneOf, inHeadline, subscriptionFigure, isFinalFigure, subscriptionTone, ruleReading } = require('../server/services/ipoWatch/arc');
const { parseCalendar, priceRange, isSpac } = require('../server/services/ipoWatch/sources/finnhub');
const { parseIssues, parseSubscriptions, nearDate, amount, gmpValue, gmpOn, listingResult, times, dmyDate } = require('../server/services/ipoWatch/sources/investorgain');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}

console.log('ipoWatch:');

check('name key: suffixes, case and punctuation do not make a new company', () => {
  assert.strictEqual(nameKey('Swara Baby Products Ltd.'), 'swara baby products');
  assert.strictEqual(nameKey('SWARA BABY PRODUCTS LIMITED'), 'swara baby products');
  assert.strictEqual(nameKey('Swara Baby Products Limited IPO'), 'swara baby products');
  assert.strictEqual(nameKey('M&M Fabrics Pvt Ltd'), 'm and m fabrics');
  assert.notStrictEqual(nameKey('Laxmi Silver Ltd'), nameKey('Laxmi Gold Ltd'));
});

check('market date is the day in India, not in UTC', () => {
  assert.strictEqual(marketDate(new Date('2026-10-09T20:00:00Z')), '2026-10-10');   // 01:30 IST next day
  assert.strictEqual(marketDate(new Date('2026-10-09T10:00:00Z')), '2026-10-09');
});

const raw = {
  name: '  Swara Baby   Products Ltd ', board: 'Mainboard', exchange: 'BSE, NSE',
  open_date: '2026-10-12', close_date: '2026-10-14', listing_date: '2026-10-19',
  price_low: '210', price_high: 221, lot_size: '67', issue_size_cr: '1,200', fresh_issue_cr: 800,
};

check('a clean issue keeps its fields, with numbers as numbers', () => {
  const it = normalizeIssue(raw, 'test');
  assert.strictEqual(it.name, 'Swara Baby Products Ltd');
  assert.strictEqual(it.board, 'mainboard');
  assert.strictEqual(it.price_low, 210);
  assert.strictEqual(it.lot_size, 67);
  assert.strictEqual(it.fresh_issue_cr, 800);
  assert.strictEqual(it.issue_size_cr, null);          // "1,200" is not a number; the source must parse it
  assert.strictEqual(it.source, 'test');
  assert.strictEqual(it.withdrawn, false);
});

check('no name or an unknown board → not stored', () => {
  assert.strictEqual(normalizeIssue({ ...raw, name: ' Ltd. ' }, 'test'), null);
  assert.strictEqual(normalizeIssue({ ...raw, board: 'reit' }, 'test'), null);
  assert.strictEqual(normalizeIssue(null, 'test'), null);
});

check('bad dates and numbers become null, never an error', () => {
  const it = normalizeIssue({ ...raw, open_date: '12-Oct-2026', listing_date: '2026-13-40', price_low: 'TBA', lot_size: -5 }, 'test');
  assert.strictEqual(it.open_date, null);
  assert.strictEqual(it.listing_date, null);
  assert.strictEqual(it.price_low, null);
  assert.strictEqual(it.lot_size, null);
  assert.strictEqual(it.close_date, '2026-10-14');
});

check('a close before the open drops both; a reversed price band is put right', () => {
  const it = normalizeIssue({ ...raw, open_date: '2026-10-14', close_date: '2026-10-12', price_low: 221, price_high: 210 }, 'test');
  assert.strictEqual(it.open_date, null);
  assert.strictEqual(it.close_date, null);
  assert.deepStrictEqual([it.price_low, it.price_high], [210, 221]);
});

check('one issue from two sources: the first wins, the second fills the gaps', () => {
  const a = normalizeIssue({ name: 'Swara Baby Products Ltd', board: 'mainboard', open_date: '2026-10-12', price_high: 221 }, 'first');
  const b = normalizeIssue({ name: 'SWARA BABY PRODUCTS LIMITED', board: 'mainboard', open_date: '2026-10-13', lot_size: 67 }, 'second');
  const other = normalizeIssue({ name: 'Laxmi Silver Ltd', board: 'sme' }, 'second');
  const merged = mergeIssues([a, b, other]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].open_date, '2026-10-12');
  assert.strictEqual(merged[0].lot_size, 67);
  assert.strictEqual(merged[0].source, 'first');
});

check('stage follows the dates', () => {
  const ipo = { open_date: '2026-10-12', close_date: '2026-10-14', listing_date: '2026-10-19' };
  assert.strictEqual(stageOf({}, '2026-10-09'), 'announced');
  assert.strictEqual(stageOf(ipo, '2026-10-09'), 'upcoming');
  assert.strictEqual(stageOf(ipo, '2026-10-12'), 'open');
  assert.strictEqual(stageOf(ipo, '2026-10-14'), 'open');         // the closing day is still open
  assert.strictEqual(stageOf(ipo, '2026-10-15'), 'closed');
  assert.strictEqual(stageOf(ipo, '2026-10-19'), 'listed');       // listing day itself
  assert.strictEqual(stageOf({ ...ipo, listing_date: null }, '2026-12-01'), 'closed');
  assert.strictEqual(stageOf({ open_date: '2026-10-12' }, '2026-10-20'), 'open');   // no close date known
  assert.strictEqual(stageOf({ close_date: '2026-09-24' }, '2026-10-09'), 'closed');   // closed, though the open date is unknown
  assert.strictEqual(stageOf({ close_date: '2026-10-20' }, '2026-10-09'), 'announced');
  assert.strictEqual(stageOf({ ...ipo, withdrawn: true }, '2026-10-12'), 'withdrawn');
});

check('poller: a failing source is skipped, the others are stored once each', async () => {
  let saved = null;
  const r = await pollCalendar({
    sources: [
      { name: 'down', fetchIssues: async () => { throw new Error('refused 403'); } },
      { name: 'up', fetchIssues: async () => [raw, { name: '', board: 'sme' }, { ...raw, name: 'Swara Baby Products Limited' }] },
    ],
    save: async (issues) => { saved = issues; return issues.length; },
    saveGmp: async () => { throw new Error('no reading was given, so nothing to save'); },
    today: '2026-10-09', delayMs: 0,
  });
  assert.deepStrictEqual(r, { sources: 2, stored: 1, gmp: 0, gmpHistory: 0, subscriptions: 0, outcomes: 0, failed: [{ source: 'down', error: 'refused 403' }] });
  assert.strictEqual(saved[0].source, 'up');
});

check('poller: nothing found → nothing saved', async () => {
  let calls = 0;
  const r = await pollCalendar({ sources: [], save: async () => { calls++; return 0; } });
  assert.deepStrictEqual(r, { sources: 0, stored: 0, gmp: 0, gmpHistory: 0, subscriptions: 0, outcomes: 0, failed: [] });
  assert.strictEqual(calls, 0);
});

// Two rows as InvestorGain's live IPO table serves them (2026-10-09), cut to the cells read.
const cell = (label, body) => `<td style="text-align:left" data-label="${label}" class="bg-2"><div class="report-td "><div class="mono-num">${body}</div></div></td>`;
const igRow = (c) => `<tr>${Object.entries(c).map(([k, v]) => cell(k, v)).join('')}</tr>`;
const IG_PAGE = `<table class="report-data-table" id="reportTable"><thead><tr><th>Name</th></tr></thead><tbody>
${igRow({
  Name: '<a href="/gmp/rkfashion-accessories-ipo/2292/" title="R.K.Fashion Accessories" target="_parent">R.K.Fashion Accessories</a> <span class="badge rounded-pill bg-secondary d-inline ms-2">NSE SME</span><span class="badge rounded-pill bg-primary d-inline ms-2">C</span>',
  GMP: '&#8377;<b>1.5</b> (1.83%)', Sub: '2.7x', 'Price (₹)': '82', 'IPO Size': '&#8377;34.99 Cr', Lot: '1,600',
  Open: '5-Oct<br><small><b>GMP: 7</b></small>', Close: '7-Oct<br><small><b>GMP: 1.5</b></small>', 'BoA Dt': '8-Oct', Listing: '12-Oct',
})}
${igRow({
  Name: '<a href="/gmp/jio-platforms-ipo/2306/" title="Jio Platforms" target="_parent">Jio Platforms</a> <span class="badge rounded-pill bg-secondary d-inline ms-2">IPO</span><span class="badge rounded-pill bg-warning d-inline ms-2">U</span>',
  GMP: '&#8377;<b>167</b> (-%)', Sub: '-', 'Price (₹)': '0', 'IPO Size': '-', Lot: '', Open: '', Close: '', 'BoA Dt': '', Listing: '',
})}
${igRow({ Name: '<a href="/gmp/some-reit/1/">Some Trust</a> <span class="badge rounded-pill bg-secondary">REIT</span>', Open: '1-Oct' })}
</tbody></table>`;

check('investorgain: a date with no year takes the year nearest to today', () => {
  assert.strictEqual(nearDate('14-Oct', '2026-10-09'), '2026-10-14');
  assert.strictEqual(nearDate('2-Jan', '2026-12-28'), '2027-01-02');
  assert.strictEqual(nearDate('29-Dec', '2027-01-04'), '2026-12-29');
  assert.strictEqual(nearDate('31-Feb', '2026-02-20'), null);
  assert.strictEqual(nearDate('', '2026-10-09'), null);
  assert.strictEqual(nearDate('7th Oct 17:56', '2026-10-09'), '2026-10-07');
  assert.strictEqual(nearDate('1st Jan 10:00', '2026-12-31'), '2027-01-01');
});

check('investorgain: amounts read through ₹, commas and "Cr"; 0 and "-" are unknown', () => {
  assert.strictEqual(amount('₹34.99 Cr'), 34.99);
  assert.strictEqual(amount('1,600'), 1600);
  assert.strictEqual(amount('0'), null);
  assert.strictEqual(amount('-'), null);
});

check('investorgain: rows become issues; a kind we do not track is left out', () => {
  const issues = parseIssues(IG_PAGE, '2026-10-09');
  assert.strictEqual(issues.length, 2);
  assert.deepStrictEqual(issues[0], {
    name: 'R.K.Fashion Accessories', board: 'sme', exchange: 'NSE',
    open_date: '2026-10-05', close_date: '2026-10-07', allotment_date: '2026-10-08', listing_date: '2026-10-12',
    price_high: 82, lot_size: 1600, issue_size_cr: 34.99, gmp: 1.5,
    gmp_history: [{ on: '2026-10-05', gmp: 7 }, { on: '2026-10-07', gmp: 1.5 }], listing_price: null, listing_gain_pct: null,
    source_ref: '/gmp/rkfashion-accessories-ipo/2292/',
  });
  const jio = normalizeIssue(issues[1], 'investorgain');
  assert.strictEqual(jio.board, 'mainboard');
  assert.strictEqual(jio.open_date, null);
  assert.strictEqual(jio.price_high, null);
  assert.strictEqual(stageOf(jio, '2026-10-09'), 'announced');
  assert.strictEqual(jio.gmp, 167);
});

check('investorgain: a page without the table is an error, not an empty calendar', () => {
  assert.throws(() => parseIssues('<html><body>Access Denied</body></html>', '2026-10-09'), /table was not found/);
});

check('GMP: the number is read; "--" is unknown; zero and negative are real readings', () => {
  assert.strictEqual(gmpValue(' 167 (-%)'), 167);
  assert.strictEqual(gmpValue('₹1.5 (1.83%)'), 1.5);
  assert.strictEqual(gmpValue('₹ -- (0.00%)'), null);
  assert.strictEqual(gmpValue('₹0 (0.00%)'), 0);
  assert.strictEqual(gmpValue('₹-5 (-2.1%)'), -5);
  assert.strictEqual(normalizeIssue({ ...raw, gmp: '63' }, 'test').gmp, null);       // the source must give a number
  assert.strictEqual(normalizeIssue({ ...raw, gmp: 0 }, 'test').gmp, 0);
});

check('GMP: a reading is kept only before listing, and only when there is one', () => {
  const mk = (o) => normalizeIssue({ ...raw, ...o }, 'test');
  const issues = [
    mk({ name: 'Open Co', gmp: 63 }),
    mk({ name: 'Unknown Co' }),
    mk({ name: 'Listed Co', gmp: 12, listing_date: '2026-10-08' }),
    mk({ name: 'Gone Co', gmp: 4, withdrawn: true }),
  ];
  assert.deepStrictEqual(gmpReadings(issues, '2026-10-13').map((i) => i.name), ['Open Co']);
});

check('GMP: poller hands the pre-listing readings to be saved with the market day', async () => {
  let got = null;
  const r = await pollCalendar({
    sources: [{ name: 'up', fetchIssues: async () => [{ ...raw, gmp: 63 }, { ...raw, name: 'Other Ltd', gmp: 5, listing_date: '2026-10-01' }] }],
    save: async (issues) => issues.length,
    saveGmp: async (readings, today) => { got = { names: readings.map((x) => x.name), today }; return readings.length; },
    today: '2026-10-13',
  });
  assert.strictEqual(r.gmp, 1);
  assert.deepStrictEqual(got, { names: ['Swara Baby Products Ltd'], today: '2026-10-13' });
});

check('GMP shown: fresh and pre-listing only, with its share of the top price', () => {
  const now = new Date('2026-10-13T06:00:00Z');
  const row = { gmp: 63, gmp_prev: 60, gmp_at: '2026-10-13T03:45:00Z', gmp_source: 'investorgain', price_high: 271 };
  assert.deepStrictEqual(gmpView(row, 'open', now), { gmp: 63, gmp_pct: 23.2, gmp_prev: 60, gmp_at: row.gmp_at, gmp_source: 'investorgain' });
  assert.strictEqual(gmpView({ ...row, price_high: null }, 'announced', now).gmp_pct, null);
  assert.strictEqual(gmpView(row, 'listed', now).gmp, null);                               // grey market is over
  assert.strictEqual(gmpView({ ...row, gmp_at: '2026-10-11T03:45:00Z' }, 'open', now).gmp, null);   // two days old
  assert.strictEqual(gmpView({ ...row, gmp: null }, 'open', now).gmp, null);
  assert.strictEqual(gmpView({ ...row, gmp: 0, gmp_prev: undefined }, 'open', now).gmp, 0);
});

// One row as InvestorGain's live subscription table serves it (2026-10-09), and one with no bids yet.
const IG_SUB_PAGE = `<table class="report-data-table" id="reportTable"><tbody>
${igRow({
  Name: '<a href="/subscription/rkfashion-accessories-ipo/2292/" title="R.K.Fashion Accessories" target="_parent">R.K.Fashion Accessories</a><br><span class="badge rounded-pill bg-secondary d-inline ms-2">NSE SME</span><small><b>GMP:&#8377;<b>1.5</b> (1.83%)</b></small><span class="badge rounded-pill bg-primary d-inline ms-2">C</span>',
  Total: '<b>2.7</b><br><small style="font-size: 12px;"><b>7th Oct 17:56</b></small>',
  QIB: '14.11', SHNI: '1.79', BHNI: '1.77', NII: '1.77', RII: '3.11', 'IPO Size': '&#8377;34.99 Cr', 'IPO Price': '82', 'Closing Date': '7-10-2026',
})}
${igRow({ Name: '<a href="/subscription/fusion-cx-ipo/2300/">Fusion CX</a><br><span class="badge rounded-pill bg-secondary">IPO</span>', Total: '<b>-</b>', QIB: '-', 'Closing Date': '16-10-2026' })}
</tbody></table>`;

check('subscription: figures read as times; "-" is unknown, 0 is nobody bidding', () => {
  assert.strictEqual(times('14.11'), 14.11);
  assert.strictEqual(times('2.7x'), 2.7);
  assert.strictEqual(times('1,204.5'), 1204.5);
  assert.strictEqual(times('0.00'), 0);
  assert.strictEqual(times('-'), null);
  assert.strictEqual(times(''), null);
  assert.strictEqual(dmyDate('7-10-2026'), '2026-10-07');
  assert.strictEqual(dmyDate('7-Oct'), null);
});

check('subscription: a row becomes an issue with its reading, dated by the figures; no bids yet → left out', () => {
  const rows = parseSubscriptions(IG_SUB_PAGE, '2026-10-09');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    name: 'R.K.Fashion Accessories', board: 'sme', exchange: 'NSE', close_date: '2026-10-07',
    price_high: 82, issue_size_cr: 34.99, source_ref: '/subscription/rkfashion-accessories-ipo/2292/',
    subscription: { observed_on: '2026-10-07', total: 2.7, qib: 14.11, nii: 1.77, nii_small: 1.79, nii_big: 1.77, retail: 3.11 },
  });
  assert.throws(() => parseSubscriptions('<html>Access Denied</html>', '2026-10-09'), /subscription table was not found/);
});

check('subscription: no total → no reading; bad parts become null; it keeps its own source', () => {
  assert.strictEqual(cleanSubscription({ qib: 3 }, 'x'), null);
  assert.strictEqual(cleanSubscription({ total: '2.7' }, 'x'), null);
  assert.strictEqual(cleanSubscription(null, 'x'), null);
  assert.deepStrictEqual(cleanSubscription({ total: 0, qib: -1, retail: 3.1, observed_on: '7th Oct' }, 'x'),
    { observed_on: null, total: 0, source: 'x', qib: null, nii: null, nii_small: null, nii_big: null, retail: 3.1 });
});

check('subscription: the calendar row and the subscription row of one issue merge, then are saved', async () => {
  let got = null;
  const r = await pollCalendar({
    sources: [
      { name: 'cal', fetchIssues: async () => parseIssues(IG_PAGE, '2026-10-09') },
      { name: 'sub', fetchIssues: async () => parseSubscriptions(IG_SUB_PAGE, '2026-10-09') },
    ],
    save: async (issues) => issues.length,
    saveGmp: async (readings) => readings.length,
    saveSubscriptions: async (issues, today) => { got = { issues, today }; return issues.length; },
    saveGmpHistory: async (issues) => issues.reduce((n, i) => n + i.gmp_history.length, 0),
    today: '2026-10-09', delayMs: 0,
  });
  assert.deepStrictEqual(r, { sources: 2, stored: 2, gmp: 2, gmpHistory: 2, subscriptions: 1, outcomes: 0, failed: [] });
  assert.strictEqual(got.issues[0].name, 'R.K.Fashion Accessories');
  assert.strictEqual(got.issues[0].source, 'cal');                    // the issue is the calendar's
  assert.strictEqual(got.issues[0].subscription.source, 'sub');       // the reading is the other page's
  assert.strictEqual(got.issues[0].open_date, '2026-10-05');
});

check('outcome: the listing result and the premiums of earlier days are read off the row', () => {
  assert.deepStrictEqual(listingResult('<a href="/gmp/x/1/">Orient Cables</a> <span class="badge">IPO</span><span class="text-success"><small><b>L@450 (65.44%)</b></small></span>'), { listing_price: 450, listing_gain_pct: 65.44 });
  assert.deepStrictEqual(listingResult('<a>Big Co</a> <b>L@1,204.50 (-2%)</b>'), { listing_price: 1204.5, listing_gain_pct: -2 });
  // A price with decimals arrives rewritten as a protected e-mail address: only the gain is read.
  assert.deepStrictEqual(
    listingResult('<a href="/gmp/sjp-ultrasonic-ipo/1964/">SJP Ultrasonic</a> <span class="badge">BSE SME</span><span class="text-success"><small><b><a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="d49894e3e0fae6e4">[email&#160;protected]</a> (10.75%)</b></small></span>'),
    { listing_price: null, listing_gain_pct: 10.75 });
  assert.deepStrictEqual(listingResult('<a>Acme</a> <span class="badge">BSE SME</span><span class="badge">LT</span>'), { listing_price: null, listing_gain_pct: null });   // lists today
  assert.deepStrictEqual(listingResult('<a>Fund (5%) Co</a> <span class="badge">IPO</span>'), { listing_price: null, listing_gain_pct: null });
  assert.deepStrictEqual(gmpOn('5-Oct<br><small><b>GMP: 110</b></small>', '2026-10-09'), { on: '2026-10-05', gmp: 110 });
  assert.deepStrictEqual(gmpOn('5-Oct<br><small><b>GMP: -4.5</b></small>', '2026-10-09'), { on: '2026-10-05', gmp: -4.5 });
  assert.strictEqual(gmpOn('8-Oct', '2026-10-09'), null);
  assert.strictEqual(gmpOn('', '2026-10-09'), null);
});

check('outcome: history keeps only dated numbers; gain is over the issue price', () => {
  assert.deepStrictEqual(cleanHistory([{ on: '2026-10-05', gmp: 7 }, { on: '5-Oct', gmp: 1 }, { on: '2026-10-07', gmp: '2' }, null]), [{ on: '2026-10-05', gmp: 7 }]);
  assert.strictEqual(cleanHistory([]), null);
  assert.strictEqual(cleanHistory('x'), null);
  assert.strictEqual(listingGain(450, 272), 65.44);
  assert.strictEqual(listingGain(85, 103), -17.48);
  assert.strictEqual(listingGain(305, 305), 0);
  assert.strictEqual(listingGain(305, null), null);
  assert.strictEqual(priceFromGain(67, 10.75), 74.2);
  assert.strictEqual(priceFromGain(103, -17.48), 85);
  assert.strictEqual(priceFromGain(null, 10), null);
  assert.strictEqual(priceFromGain(67, null), null);
});

check('outcome: logged only for a listed issue with a listing price', async () => {
  const mk = (o) => ({ ...raw, open_date: '2026-09-28', close_date: '2026-09-30', ...o });
  const issues = [
    mk({ name: 'Listed Co', listing_date: '2026-10-05', listing_price: 450 }),
    mk({ name: 'Lists Today Co', listing_date: '2026-10-09' }),
    mk({ name: 'Early Price Co', listing_date: '2026-10-12', listing_price: 90 }),      // a price before its listing day is not an outcome
    mk({ name: 'Gain Only Co', listing_date: '2026-10-06', listing_gain_pct: 10.75 }),
  ];
  let logged = null;
  const r = await pollCalendar({
    sources: [{ name: 'up', fetchIssues: async () => issues }],
    save: async (list) => list.length, saveGmp: async () => 0, saveSubscriptions: async () => 0,
    saveOutcomes: async (list) => { logged = list.map((i) => [i.name, i.listing_price, i.listing_gain_pct]); return list.length; },
    today: '2026-10-09', delayMs: 0,
  });
  assert.strictEqual(r.outcomes, 2);
  assert.deepStrictEqual(logged, [['Listed Co', 450, null], ['Gain Only Co', null, 10.75]]);
  assert.strictEqual(outcomesOf([normalizeIssue(issues[1], 'x')], '2026-10-09').length, 0);
});

// The registry: real headlines from the dev database (2026-10) against issues on the calendar.
const REG = [
  { id: 1, name: 'Fusion CX' }, { id: 2, name: 'HD Fire Protect' }, { id: 3, name: 'Jio Platforms', aliases: ['Jio', 'Reliance Jio'] },
  { id: 4, name: 'Vishal Nirmiti' }, { id: 5, name: 'Nityas Gems & Jewellery', aliases: ['Nityas Gems'] },
  { id: 6, name: 'R.K.Fashion Accessories' }, { id: 7, name: 'Moneyview' }, { id: 8, name: 'Elevate Campuses' },
].map((i) => ({ ...i, name_key: nameKey(i.name) }));
const matchIpo = buildMatcher(REG);
const ids = (title, summary) => matchIpo(title, summary).map((m) => m.id);

check('registry: a full multi-word name links a story, whatever else it says', () => {
  assert.deepStrictEqual(ids('Fusion CX fixes IPO price band at ₹275-289 per share, issue size at ₹702 cr'), [1]);
  assert.deepStrictEqual(ids('HD Fire Protect wins a Rs 90 crore order from a refinery'), [2]);
  assert.deepStrictEqual(ids('Vishal Nirmiti shares list at 2% discount over IPO price on NSE, BSE'), [4]);
  assert.deepStrictEqual(matchIpo('Jio Platforms IPO: What does it mean for Reliance Industries share price?'), [{ id: 3, matched_on: 'name' }]);
});

check('registry: initials written together still match', () => {
  assert.strictEqual(joinInitials('r k fashion accessories'), 'rk fashion accessories');
  assert.strictEqual(joinInitials('a one steels'), 'a one steels');
  assert.deepStrictEqual(ids('RK Fashion Accessories IPO subscribed 2.7 times on final day'), [6]);
  assert.deepStrictEqual(ids('R.K. Fashion Accessories IPO allotment today'), [6]);
});

check('registry: an alias or a one-word name needs a story that is plainly about an IPO', () => {
  assert.deepStrictEqual(matchIpo('Jio IPO expected launch date and price, latest GMP price - What we know so far'), [{ id: 3, matched_on: 'alias' }]);
  assert.deepStrictEqual(ids("Not just RIL, Jio's ₹11 trn IPO could benefit Airtel investors; here's why"), [3]);
  assert.deepStrictEqual(ids('Jio adds 4 million subscribers in August, Airtel 1.5 million'), []);
  assert.deepStrictEqual(ids('Moneyview IPO subscribed 12 times on day 2'), [7]);
  assert.deepStrictEqual(ids('Jio lists new prepaid plans as tariffs rise'), []);
  assert.deepStrictEqual(ids('Moneyview launches a credit card with a small finance bank'), []);
});

check('registry: one story can be about two issues; part of a name is not the name', () => {
  assert.deepStrictEqual(ids('New IPO listings today: Discount or premium and gains? Vishal Nirmiti vs Nityas Gems - Check worst and best'), [4, 5]);
  assert.deepStrictEqual(ids('Elevate your portfolio: five campuses REITs to watch after the IPO rush'), []);
  assert.deepStrictEqual(ids('Fusion Finance shares jump 6% after block deal'), []);
  assert.deepStrictEqual(ids('Japan Deal Drought Cuts IPO Fundraising to Lowest in 14 Years'), []);
  assert.deepStrictEqual(ids('India IPO slowdown: market correction pauses record listing spree', 'Fusion CX and HD Fire Protect are next.'), [1, 2]);
});

check('registry: a ticker is taken only from an Indian share under the very same name', () => {
  const quotes = [
    { symbol: 'ORIENTCABL.NS', exchange: 'NSI', longname: 'Orient Cables (India) Limited', quoteType: 'EQUITY' },
    { symbol: 'ORIENTCABL.BO', exchange: 'BSE', longname: 'Orient Cables (India) Limited', quoteType: 'EQUITY' },
  ];
  assert.strictEqual(looseKey('Orient Cables (India) Limited'), 'orient cables');
  assert.deepStrictEqual(pickSymbol('Orient Cables', quotes), { symbol: 'ORIENTCABL', exchange: 'BSE, NSE' });
  assert.deepStrictEqual(pickSymbol('Orient Cables', [quotes[1]]), { symbol: 'ORIENTCABL', exchange: 'BSE' });
  assert.strictEqual(pickSymbol('Orient Cables', []), null);
  // A short calendar name may be the start of the listed one — when that points at one company only.
  const german = [{ symbol: 'GERMAN.NS', longname: 'German Green Steel and Power Limited', quoteType: 'EQUITY' }, { symbol: 'GERMAN.BO', longname: 'German Green Steel and Power Limited', quoteType: 'EQUITY' }];
  assert.deepStrictEqual(pickSymbol('German Green Steel', german), { symbol: 'GERMAN', exchange: 'BSE, NSE' });
  assert.strictEqual(pickSymbol('Orient', quotes), null);                                  // one word is too little to go on
  assert.strictEqual(pickSymbol('Tata Power', [{ symbol: 'TATAPOWER.NS', longname: 'Tata Power Company Limited', quoteType: 'EQUITY' }, { symbol: 'TPREL.NS', longname: 'Tata Power Renewable Energy Limited', quoteType: 'EQUITY' }]), null);
  assert.strictEqual(pickSymbol('Orient Cables', [{ symbol: 'ORIENTELEC.NS', longname: 'Orient Electric Limited', quoteType: 'EQUITY' }]), null);
  assert.strictEqual(pickSymbol('Orient Cables', [{ symbol: 'OC', longname: 'Orient Cables Limited', quoteType: 'EQUITY' }]), null);          // not an Indian listing
  assert.strictEqual(pickSymbol('Orient Cables', [{ symbol: 'ORIENTCABL.NS', longname: 'Orient Cables Limited', quoteType: 'FUTURE' }]), null);
});

// Yahoo's daily prices for one issue, as its chart route replied on 2026-10-09 (five days from listing).
const CHART = { chart: { result: [{
  meta: { symbol: 'ORIENTCABL.NS', currency: 'INR', gmtoffset: 19800 },
  timestamp: [1791171900, 1791258300, 1791344700, 1791431100, 1791517500],
  indicators: { quote: [{ open: [450.0, 380.0, 400.6000061035156, 417.0, 394.54998779296875], close: [405.0, 396.3999938964844, 418.3999938964844, null, 379.8500061035156] }] },
}] } };

check('returns: Yahoo bars become dated closes in the exchange\'s days; a day with no price is dropped', () => {
  const bars = parseBars(CHART);
  assert.deepStrictEqual(bars.map((b) => b.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09']);
  assert.deepStrictEqual(bars[0], { date: '2026-10-05', open: 450, close: 405 });
  assert.strictEqual(bars[2].close, 418.4);
  assert.deepStrictEqual(parseBars({ chart: { result: null } }), []);
  assert.deepStrictEqual(parseBars(null), []);
});

check('returns: a horizon is read only once its day is over, and only near its date', () => {
  const day = (date, close) => ({ date, open: close, close });
  const bars = [day('2026-10-05', 405), day('2026-10-06', 396), day('2026-10-12', 410), day('2026-10-13', 420), day('2026-11-04', 500)];
  assert.strictEqual(barOnOrAfter(bars, '2026-10-12', '2026-10-13').close, 410);
  assert.strictEqual(barOnOrAfter(bars, '2026-10-12', '2026-10-12'), null);            // today's bar is not final
  assert.strictEqual(barOnOrAfter(bars, '2026-10-10', '2026-10-20').close, 410);       // a weekend: the next trading day
  assert.strictEqual(barOnOrAfter(bars, '2026-10-20', '2026-11-30'), null);            // nothing for two weeks: not trading
  assert.strictEqual(barOnOrAfter(bars, '2026-10-04', '2026-10-20', 0), null);         // no slack: that very day or nothing
});

check('returns: each close is a return over the issue price; what is not due stays empty', () => {
  const bars = parseBars(CHART);
  assert.deepStrictEqual(returnsFrom(bars, '2026-10-05', 272, '2026-10-09'), {
    open_listing_day: 450, close_listing_day: 405, ret_listing_day_pct: 48.9,
    close_1w: null, ret_1w_pct: null, close_1m: null, ret_1m_pct: null, close_3m: null, ret_3m_pct: null,
  });
  const later = [...bars, { date: '2026-10-12', open: 380, close: 360 }, { date: '2026-11-04', open: 300, close: 250 }];
  const r = returnsFrom(later, '2026-10-05', 272, '2026-11-10');
  assert.deepStrictEqual([r.close_1w, r.ret_1w_pct, r.close_1m, r.ret_1m_pct], [360, 32.35, 250, -8.09]);
  assert.strictEqual(r.close_3m, null);                                                // three months have not passed
  const q = returnsFrom([...later, { date: '2027-01-04', open: 300, close: 340 }], '2026-10-05', 272, '2027-01-10');
  assert.deepStrictEqual([q.close_3m, q.ret_3m_pct], [340, 25]);                       // 3 Jan is a Sunday: the next trading day
  assert.strictEqual(returnsFrom(bars, '2026-10-05', null, '2026-10-09').ret_listing_day_pct, null);   // no issue price, no return
  assert.strictEqual(returnsFrom(bars, '2026-10-02', 272, '2026-10-09').close_listing_day, null);       // no price on the listing day itself
});

check('arc: read stories are grouped by day, weighted by how far the source is trusted', () => {
  const st = (day, source, score) => ({ day, source, sentiment: score == null ? null : { score, label: 'x' } });
  const stories = [
    st('2026-10-08', 'livemint.com', 0.8), st('2026-10-08', 'someblog.example', 0.2),
    st('2026-10-07', 'economictimes.indiatimes.com', 0.5), st('2026-10-08', 'business-standard.com', null),
  ];
  const arc = arcOf(stories);
  assert.deepStrictEqual(arc.map((p) => [p.day, p.stories]), [['2026-10-07', 1], ['2026-10-08', 2]]);
  assert.strictEqual(arc[0].score, 0.5);
  assert.strictEqual(arc[1].score, 0.52);              // (0.8 × 0.8 + 0.2 × 0.7) / 1.5: the named source counts for more
  assert.deepStrictEqual(arcOf([st('2026-10-08', 'x', null)]), []);
});

check('arc: overall tone needs at least one read story', () => {
  const st = (score) => ({ day: '2026-10-08', source: 'livemint.com', sentiment: score == null ? null : { score } });
  assert.deepStrictEqual(toneOf([st(0.9), st(0.7), st(null)]), { score: 0.8, label: 'positive', stories: 2 });
  assert.deepStrictEqual(toneOf([st(0.3)]), { score: 0.3, label: 'negative', stories: 1 });
  assert.strictEqual(toneOf([st(null)]), null);
  assert.strictEqual(toneOf([]), null);
});

check('tone: the subscription figure is read off the headline, in times', () => {
  const f = subscriptionFigure;
  assert.strictEqual(f('Runwal Enterprises IPO subscribed 42%'), 0.42);
  assert.strictEqual(f('ArMee Infotech IPO subscribed 2.62 times'), 2.62);
  assert.strictEqual(f('Swastika Infra IPO Day 3: Issue subscribed over 1.6x; GMP signals 5% premium — Check key details'), 1.6);
  assert.strictEqual(f('Advit Jewels IPO Day 1 LIVE: Issue booked 7.08x so far. GMP hints 46% listing pop. Should you buy or not?'), 7.08);
  assert.strictEqual(f('Waterways Leisure Tourism IPO Day 1: Issue booked 6% so far. Check GMP, review, key dates. Apply or not?'), 0.06);
  assert.strictEqual(f('Varmora Granito IPO ends with 1.58 times subscription'), 1.58);
  assert.strictEqual(f('ArMee Infotech IPO enters Day 3 with 1.17x subscription; GMP at 5%. Should you subscribe?'), 1.17);
  assert.strictEqual(f('Adroit Industries IPO Day 3: GMP at 28%, subscription reaches 18.07 times. Should you subscribe?'), 18.07);   // not the GMP's 28%
  assert.strictEqual(f('Turtlemint IPO trails on Day 3; subscription at 56% as issue nears close'), 0.56);
  assert.strictEqual(f('Knack Packaging IPO Day 2: Issue subscribed 3 times, GMP indicates 16% listing gain. Should you apply?'), 3);
});

check('tone: a headline with no subscription figure is left to the model', () => {
  const f = subscriptionFigure;
  assert.strictEqual(f('Elevate Campuses IPO Day 3: GMP, subscription status and key details. Should you subscribe?'), null);
  assert.strictEqual(f('German Green Steel IPO opens for subscription: GMP indicates 20% potential listing gain. Should you subscribe?'), null);
  assert.strictEqual(f('Fusion CX fixes IPO price band at ₹275-289 per share, issue size at ₹702 cr'), null);
  assert.strictEqual(f('Jio adds 4 million subscribers; subscriber base up 2%'), null);
  assert.strictEqual(ruleReading({ title: 'Vishal Nirmiti shares make weak debut, list at 2% discount to IPO price' }), null);
});

check('tone: under-subscribed is bad news only once the figure is final', () => {
  assert.strictEqual(isFinalFigure('Liqvd Digital India IPO subscribed 5.08 times on final day'), true);
  assert.strictEqual(isFinalFigure('Varmora Granito IPO ends with 1.58 times subscription'), true);
  assert.strictEqual(isFinalFigure('AceVector IPO subscribed 23%', '2026-09-25', '2026-09-29'), false);
  assert.strictEqual(isFinalFigure('Runwal Enterprises IPO subscribed 42%', '2026-09-29', '2026-09-29'), true);    // the closing day
  assert.strictEqual(isFinalFigure('Some IPO subscribed 42%'), false);                                             // dates unknown: not a verdict

  assert.deepStrictEqual(subscriptionTone(0.42, true), { label: 'negative', score: 0.31, confidence: 0.9, model: 'subscription-rule' });
  assert.strictEqual(subscriptionTone(0.23, true).score, 0.18);
  assert.deepStrictEqual([subscriptionTone(0.23, false).score, subscriptionTone(0.23, false).label], [0.5, 'neutral']);
  assert.strictEqual(subscriptionTone(0, true).score, 0.05);
});

check('tone: covered is neutral, heavily over-subscribed is positive, and it levels off', () => {
  const t = (x) => subscriptionTone(x, true);
  assert.deepStrictEqual([t(1).score, t(1).label], [0.5, 'neutral']);
  assert.deepStrictEqual([t(1.73).score, t(1.73).label], [0.55, 'neutral']);
  assert.deepStrictEqual([t(5.08).score, t(5.08).label], [0.64, 'positive']);
  assert.strictEqual(t(18.07).score, 0.75);
  assert.strictEqual(t(124).score, 0.92);
  assert.strictEqual(t(5000).score, 0.95);
  assert.strictEqual(subscriptionTone(7.08, false).score, 0.67);                       // over-subscribed early is already good news
  assert.strictEqual(ruleReading({ title: 'Runwal Enterprises IPO subscribed 42%', day: '2026-09-29', close_date: '2026-09-29' }).label, 'negative');
});

// Rows as Finnhub's IPO calendar returned them on 2026-10-09.
const FINNHUB = { ipoCalendar: [
  { date: '2026-10-09', exchange: 'NASDAQ Global Select', name: 'TRex Bio, Inc.', numberOfShares: 8333334, price: '14.00-16.00', status: 'expected', symbol: 'TRXB', totalSharesValue: 153333344 },
  { date: '2026-10-07', exchange: null, name: 'FireFly Robotics, Inc.', numberOfShares: null, price: null, status: 'filed', symbol: 'FFLY', totalSharesValue: 0 },
  { date: '2026-10-06', exchange: 'NASDAQ Global', name: 'Pine Tree Acquisition Corp.', numberOfShares: 10000000, price: '10.00', status: 'priced', symbol: 'PAXGU', totalSharesValue: 100000000 },
  { date: '2026-09-20', exchange: null, name: 'New Iceland Arctic Acquisition Corp.', numberOfShares: null, price: null, status: 'filed', symbol: 'NIAA', totalSharesValue: 50000000 },
  { date: '2026-10-05', exchange: null, name: 'New Iceland Arctic Acquisition Corp.', numberOfShares: null, price: null, status: 'withdrawn', symbol: null, totalSharesValue: null },
  { date: '2026-10-05', exchange: null, name: 'Odd Status Co', status: 'rumoured' },
] };

check('US: Finnhub rows become issues; a price is a range or the one price done', () => {
  assert.deepStrictEqual(priceRange('14.00-16.00'), { price_low: 14, price_high: 16 });
  assert.deepStrictEqual(priceRange('10.00'), { price_low: null, price_high: 10 });
  assert.deepStrictEqual(priceRange(null), { price_low: null, price_high: null });
  const rows = parseCalendar(FINNHUB);
  assert.strictEqual(rows.length, 4);                                   // one company twice, one unknown status
  assert.deepStrictEqual(rows[0], {
    market: 'US', name: 'TRex Bio, Inc.', exchange: 'NASDAQ Global Select', symbol: 'TRXB',
    listing_date: '2026-10-09', status_date: null, price_low: 14, price_high: 16,
    shares: 8333334, issue_size_usd: 153333344, source_status: 'expected', withdrawn: false, is_spac: false,
  });
  const filed = rows.find((r) => r.name.startsWith('FireFly'));
  assert.deepStrictEqual([filed.listing_date, filed.status_date, filed.issue_size_usd], [null, '2026-10-07', null]);   // the filing day is not a listing day
  assert.deepStrictEqual(parseCalendar({}), []);
});

check('US: a company seen twice keeps its latest event; blank-check companies are marked', () => {
  const rows = parseCalendar(FINNHUB);
  const iceland = rows.filter((r) => r.name.startsWith('New Iceland'));
  assert.strictEqual(iceland.length, 1);
  assert.deepStrictEqual([iceland[0].source_status, iceland[0].withdrawn, iceland[0].status_date], ['withdrawn', true, '2026-10-05']);
  assert.strictEqual(isSpac('Pine Tree Acquisition Corp.'), true);
  assert.strictEqual(isSpac('POP GLOBAL ACQUISITION Ltd'), true);
  assert.strictEqual(isSpac('TRex Bio, Inc.'), false);
  assert.deepStrictEqual(rows.map((r) => r.is_spac), [false, false, true, true]);
});

check('US: an issue needs no board, its stage is the source\'s status, and it never merges with an Indian namesake', () => {
  const [trex, firefly, pine, iceland] = parseCalendar(FINNHUB).map((r) => normalizeIssue(r, 'finnhub'));
  assert.deepStrictEqual([trex.market, trex.board, trex.name_key, trex.symbol], ['US', null, 'trex bio', 'TRXB']);
  assert.strictEqual(stageOf(trex, '2026-10-09'), 'upcoming');          // expected today is not yet priced
  assert.strictEqual(stageOf(firefly, '2026-10-09'), 'announced');
  assert.strictEqual(stageOf(pine, '2026-10-09'), 'closed');             // priced, but not known to be trading
  assert.strictEqual(stageOf({ ...pine, first_trade_date: '2026-10-07' }, '2026-10-09'), 'listed');
  assert.strictEqual(stageOf(iceland, '2026-10-09'), 'withdrawn');
  assert.strictEqual(normalizeIssue({ name: 'No Board Ltd' }, 'x'), null);                     // an Indian issue still needs one
  const indian = normalizeIssue({ name: 'TRex Bio Ltd', board: 'sme' }, 'investorgain');
  assert.strictEqual(indian.name_key, trex.name_key);
  assert.strictEqual(mergeIssues([trex, indian]).length, 2);
});

check('US outcome: the first trading day is the feed\'s first day, on or just after pricing', () => {
  const day = (date, open, close) => ({ date, open, close });
  const etra = [day('2026-09-18', 15, 13.25), day('2026-09-21', 13.94, 13.92), day('2026-09-25', 13.5, 13.1)];
  assert.strictEqual(firstTradeDay(etra, '2026-09-18', '2026-10-09'), '2026-09-18');
  assert.strictEqual(firstTradeDay(etra, '2026-09-17', '2026-10-09'), '2026-09-18');           // priced the evening before
  assert.strictEqual(firstTradeDay(etra, '2026-09-18', '2026-09-18'), null);                    // its first day is not over
  assert.strictEqual(firstTradeDay(etra, '2026-09-22', '2026-10-09'), null);                    // was trading before it was priced
  assert.strictEqual(firstTradeDay(etra.slice(2), '2026-09-10', '2026-10-09'), null);           // first price two weeks late
  assert.strictEqual(firstTradeDay([], '2026-09-18', '2026-10-09'), null);
  assert.deepStrictEqual(returnsFrom(etra, '2026-09-18', 15, '2026-10-09'), {
    open_listing_day: 15, close_listing_day: 13.25, ret_listing_day_pct: -11.67,
    close_1w: 13.1, ret_1w_pct: -12.67, close_1m: null, ret_1m_pct: null, close_3m: null, ret_3m_pct: null,
  });
  assert.strictEqual(usDate(new Date('2026-10-09T02:00:00Z')), '2026-10-08');                    // still the evening before in New York
});

check('tone: a story is read only when its headline names the issue', () => {
  const roze = { id: 9, name: 'ROZE AI INC.', name_key: nameKey('ROZE AI INC.'), aliases: [] };
  assert.strictEqual(roze.name_key, 'roze ai');                                          // "Inc." is not part of the name
  assert.strictEqual(inHeadline(roze, "Roze AI's Korean Subsidiary Inks New ~$12.2M Contract To Install AI-Powered Fire Safety"), true);
  assert.strictEqual(inHeadline(roze, 'Nike Posts Mixed Q1 Results, Joins Mangoceuticals And Other Big Stocks Moving Lower In Friday’s Pre-Market Session'), false);
  const jio = { id: 3, name: 'Jio Platforms', name_key: 'jio platforms', aliases: ['Jio'] };
  assert.strictEqual(inHeadline(jio, 'Jio IPO expected launch date and price, latest GMP price - What we know so far'), true);   // by its alias
  assert.strictEqual(inHeadline(jio, 'Reliance shares may be a cheaper way to own the telecom unit'), false);
});

check('graduation: a ticker is trusted when the price feed agrees with the listing price', () => {
  assert.strictEqual(priceConfirms({ close_listing_day: 322.95, open_listing_day: 355.1, listing_price: 355.09 }), true);
  assert.strictEqual(priceConfirms({ close_listing_day: 405, open_listing_day: 450, listing_price: 450 }), true);
  assert.strictEqual(priceConfirms({ close_listing_day: 90, open_listing_day: 92, listing_price: 450 }), false);     // another company's share
  assert.strictEqual(priceConfirms({ close_listing_day: 405, open_listing_day: null, listing_price: 450 }), true);   // a listing-day price is enough
  assert.strictEqual(priceConfirms({ close_listing_day: null, open_listing_day: 450, listing_price: 450 }), false);  // no price on the day at all
  assert.strictEqual(referenceExchange('IN', 'BSE, NSE'), 'NSE');
  assert.strictEqual(referenceExchange('IN', 'BSE'), 'BSE');
  assert.strictEqual(referenceExchange('US', 'NASDAQ Global Select'), 'US');
});

check('graduation: a graduated company is matched as strictly as a listed one', () => {
  assert.strictEqual(coreName('Orion180 Insurance Group Inc.'), 'Orion180 Insurance');
  assert.strictEqual(coreName('Vishal Nirmiti'), 'Vishal Nirmiti');
  setIpoTier([
    { ticker: 'VNL', name: 'Vishal Nirmiti', country: 'IN' },
    { ticker: 'MONEYVIEW', name: 'Moneyview', country: 'IN' },
    { ticker: 'ETRA', name: 'Electra Therapeutics, Inc.', country: 'US' },
  ]);
  const names = (ticker, text) => namesHolding({ ticker, name: 'x' }, text);
  assert.strictEqual(names('VNL', 'Vishal Nirmiti wins a Rs 240 crore road order'), true);
  assert.strictEqual(names('VNL', 'the vishal nirmiti of old Pune'), false);                 // as written, capitals included
  assert.strictEqual(names('VNL', 'VNL rallies 5% on order win'), false);                    // three letters is too short to go bare
  assert.strictEqual(names('VNL', 'Buy call on NSE: VNL at current levels'), true);
  assert.strictEqual(names('MONEYVIEW', 'Moneyview shares slip 4% after lock-in expiry'), true);
  assert.strictEqual(names('MONEYVIEW', 'A moneyview of the budget: what changes for savers'), false);
  assert.strictEqual(names('MONEYVIEW', 'Moneyview and Paytm top the app charts'), false);   // a one-word name needs a company cue
  assert.strictEqual(names('ETRA', 'Electra Therapeutics reports Phase 2 data'), true);
  assert.strictEqual(names('ETRA', 'Tetra Pak and others expand'), false);
  setIpoTier([]);
});

check('calendar age: the page is told when the last refresh was, and when that is too long ago', async () => {
  const now = new Date('2026-10-10T08:00:00Z');
  const at = (hoursAgo) => ({ run: async () => [{ at: new Date(now - hoursAgo * 3600e3) }], now });
  assert.deepStrictEqual(await calendarAge('IN', at(3)), { updatedAt: new Date(now - 3 * 3600e3), stale: false });
  assert.strictEqual((await calendarAge('IN', at(IPO_WATCH.STALE_AFTER_HOURS + 1))).stale, true);   // a missed daily poll
  assert.deepStrictEqual(await calendarAge('US', { run: async () => [{ at: null }], now }), { updatedAt: null, stale: true });   // never polled
});
check('a listed issue stays on the calendar until its last return can be shown', () => {
  // The 3-month close is first readable the day after listing + 90; at a 90-day window the
  // issue had already left the page.
  assert.ok(IPO_WATCH.RECENT_LISTED_DAYS > 90);
  assert.ok(IPO_WATCH.RECENT_LISTED_DAYS >= IPO_WATCH.RETURN_GIVE_UP_DAYS);
});

// The page's own drawing of an issue's news lives in public/js/app.js (browser code). The
// two functions are lifted out as text and run against a small stand-in for the page.
const appJs = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
const lift = (from, to) => { const a = appJs.indexOf(from), b = appJs.indexOf(to, a); assert.ok(a >= 0 && b > a, `not found: ${from}`); return appJs.slice(a, b); };
const page = new Function(`
  const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ipoDay = (d) => d || '—';
  const ipoArcChart = () => '';
  ${lift('const IPO_STORIES_SHOWN', '// Tone by day as a small chart')}
  ${lift('function renderIpoStories', '// Top-level page switcher')}
  return { renderIpoStories, ipoToggleAllStories, IPO_STORIES_SHOWN };
`)();
const storyRow = (n) => ({ id: n, title: `Story ${n}`, url: `https://example.test/${n}`, source: 'example.test', day: `2026-10-${String(n).padStart(2, '0')}`, sentiment: { label: 'positive', score: 0.7, model: 'finbert' } });
const drawn = (count) => page.renderIpoStories({ name: 'Jio Platforms' }, { stories: Array.from({ length: count }, (_, i) => storyRow(count - i)), arc: [], tone: { label: 'positive', score: 0.7, stories: count } });
const items = (html) => html.match(/<li[^>]*>/g) || [];

check('an issue\'s news opens on its latest 5 stories; the rest wait behind "Show all N stories"', () => {
  assert.strictEqual(page.IPO_STORIES_SHOWN, 5);
  const html = drawn(13);
  assert.strictEqual(items(html).length, 13); // every story is in the page …
  assert.strictEqual(items(html).filter((li) => /ipo-story-extra hidden/.test(li)).length, 8); // … eight of them hidden
  assert.deepStrictEqual(items(html).slice(0, 5), ['<li>', '<li>', '<li>', '<li>', '<li>']);
  assert.ok(html.indexOf('Story 13') < html.indexOf('Story 9') && html.indexOf('Story 9') < html.indexOf('ipo-story-extra')); // the newest five, in order, come first
  assert.match(html, /<button type="button" class="ipo-stories-more" aria-expanded="false" data-total="13">Show all 13 stories<\/button>/);
  assert.match(html, /from 13 stories read/); // the tone line still speaks for all of them
});
check('five stories or fewer: all shown, and no button', () => {
  for (const count of [1, 4, 5]) {
    const html = drawn(count);
    assert.strictEqual(items(html).length, count);
    assert.ok(!/ipo-story-extra|ipo-stories-more/.test(html), `${count} stories drew a button`);
  }
  assert.match(drawn(6), /Show all 6 stories/);
});
check('the button opens the rest and closes them again', () => {
  const extras = Array.from({ length: 8 }, () => { const cls = new Set(['ipo-story-extra', 'hidden']); return { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) } }; });
  const attrs = { 'aria-expanded': 'false' };
  const btn = { dataset: { total: '13' }, textContent: 'Show all 13 stories', getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; },
    closest: () => ({ querySelectorAll: () => extras }) };
  page.ipoToggleAllStories(btn);
  assert.deepStrictEqual([attrs['aria-expanded'], btn.textContent, extras.some((e) => e.classList.has('hidden'))], ['true', 'Show the latest 5', false]);
  page.ipoToggleAllStories(btn);
  assert.deepStrictEqual([attrs['aria-expanded'], btn.textContent, extras.every((e) => e.classList.has('hidden'))], ['false', 'Show all 13 stories', true]);
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} IPO Watch checks passed`);
})();
