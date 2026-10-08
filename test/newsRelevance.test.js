/**
 * Offline tests for which companies a story is ABOUT (newsRelevance.subjectTickers). The
 * sentiment reading is one tone for the whole text, so a roundup must not hand the market's
 * tone to every company it lists. Headlines here are ones the pipeline stored.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const { subjectTickers, isRoundup, classifyArticle } = require('../server/services/newsRelevance');
const { buildResolver, universeRows } = require('../server/services/entityResolver');

const { companies, executives } = universeRows();
const { resolve } = buildResolver(companies, executives);
// The pipeline's own steps: resolve, then keep the subjects.
const about = (title, summary = '') =>
  subjectTickers(title, resolve(title, summary).tickers, resolve(title, '').tickers).sort();

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('roundups are about the market, not the companies they list:');
check('a market wrap names no subject', () => {
  assert.deepStrictEqual(about('Market wrap: Kotak Bank, Bharti Airtel, Titan Company, Adani Ent top gainers and losers on Nifty and Sensex on Wednesday',
    'Indian equities ended lower on Wednesday after the RBI raised the repo rate.'), []);
});
check('stocks to watch, top gainers and losers', () => {
  assert.deepStrictEqual(about('Stocks to watch: TCS, Paytm, Tata Power, Ola, Tata Steel, Varun Bev'), []);
  assert.deepStrictEqual(about('Top Gainers Losers on 2 July: Zensar Tech, TCS, Coforge, Apollo Tyres among top movers'), []);
  assert.deepStrictEqual(about('Top stocks to watch today: TCS, Tata Steel, Reliance, Sun Pharma shares in focus on Thursday'), []);
});
check('"shares in focus" with one company is ordinary company news', () => {
  assert.deepStrictEqual(about('Kotak Bank shares in focus after Q2 business update'), ['KOTAKBANK']);
  assert.deepStrictEqual(about('TCS Q2 preview: Results today after stock market closing bell; expectations, dividend'), ['TCS']);
});
check('__MARKET__ is kept and the order is unchanged', () => {
  assert.deepStrictEqual(subjectTickers('Market wrap: Infosys, ITC top gainers and losers', ['INFY', '__MARKET__', 'ITC'], ['INFY', 'ITC']), ['__MARKET__']);
  assert.deepStrictEqual(subjectTickers('Infosys beats estimates, ITC flat', ['ITC', 'INFY'], ['ITC', 'INFY']), ['ITC', 'INFY']);
});

console.log('broad-market headlines keep only the companies the headline names:');
check('a company named only in the summary is a passing mention', () => {
  assert.deepStrictEqual(about('Wall Street slips as AI stocks drag despite gains in consumer names',
    'Tech heavyweights led by Micron, AMD and Nvidia weighed on markets, while General Mills, Nike and Kroger advanced.'), []);
  assert.deepStrictEqual(about('Nifty July futures trade at premium',
    'Infosys, HDFC Bank (India) and Reliance Industries were top traded contracts.'), []);
});
check('a company in the headline stays', () => {
  assert.deepStrictEqual(about('Sensex slumps 500 points as HDFC Bank drags', 'HDFC Bank and Infosys led the fall.'), ['HDFCBANK']);
});
check('a sector index story is about its companies', () => {
  assert.deepStrictEqual(about('Nifty IT hits fresh 52-week low on demand worries', 'Infosys, TCS and Wipro tumbled up to 3%.'), ['INFY', 'TCS', 'WIPRO']);
  assert.deepStrictEqual(about('Nifty IT sinks 2% to 3-year low; TCS, Infosys hit 52-wk lows'), ['INFY', 'TCS']);
});

console.log('everything else is untouched:');
check('several companies moving together on their own news', () => {
  assert.deepStrictEqual(about('Kotak, IndusInd, Axis Bank shares jump on strong Q2 business updates'), ['AXISBANK', 'INDUSINDBK', 'KOTAKBANK']);
});
check('analyst picks named in the summary still count', () => {
  assert.deepStrictEqual(about('Margin boost: Jefferies picks 3 bank stocks to gain the most from RBI rate hikes',
    'Jefferies expects the rate hike to support bank earnings, particularly ICICI Bank, SBI and Axis Bank.'), ['AXISBANK', 'ICICIBANK', 'SBIN']);
});

console.log('grading follows the subjects:');
check('a wrap that named holdings is graded as a market story, not a holding story', () => {
  const a = { title: 'Market wrap: Kotak Bank, Titan top gainers and losers on Nifty and Sensex', source: 'economictimes.indiatimes.com', platform: 'news' };
  assert.strictEqual(classifyArticle(a, ['KOTAKBANK', 'TITAN']).tier, 'holding'); // before
  assert.strictEqual(classifyArticle(a, about(a.title)).tier, 'market');
});

check('a watch-list with no market word stays in the feed as a market story', () => {
  const a = { title: 'Stocks to watch: TCS, Paytm, Tata Power, Ola, Tata Steel, Varun Bev', source: 'livemint.com', platform: 'news' };
  assert.deepStrictEqual(classifyArticle(a, about(a.title)), { tier: 'none', importance: 0, isRelevant: false, primaryRef: null }); // without the flag
  const rel = classifyArticle(a, about(a.title), { aboutMarket: true });
  assert.deepStrictEqual([rel.tier, rel.isRelevant], ['market', true]);
});
check('a company story is never turned into a market story by the flag', () => {
  const a = { title: 'Kotak Bank shares in focus after Q2 business update', source: 'livemint.com', platform: 'news' };
  assert.strictEqual(isRoundup(a.title, ['KOTAKBANK']), false);
  assert.strictEqual(classifyArticle(a, ['KOTAKBANK'], { aboutMarket: true }).tier, 'holding');
});

console.log(`\n${passed} news-relevance checks passed`);
