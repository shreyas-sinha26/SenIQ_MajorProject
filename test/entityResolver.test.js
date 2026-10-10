/**
 * Offline logic tests for entity resolution (Engine E1). No DB, no market data —
 * just the pure resolver over the curated universe. Each case is a real correctness
 * requirement; the TRON/visa cases are regressions we hit during the build and lock
 * here so they can't come back. Run: `npm test`.
 */

const assert = require('node:assert');
const { buildResolver, universeRows } = require('../server/services/entityResolver');

const { companies, executives } = universeRows();
const { resolve } = buildResolver(companies, executives);
const tk = (title, extra = []) => resolve(title, '', extra).tickers.sort();
const sec = (title) => resolve(title, '').sectors.sort();

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('entityResolver:');

// Bug fixes locked as regressions
check('Bitcoin → BTC, not COIN', () => assert.deepStrictEqual(tk('Bitcoin hits new all-time high'), ['BTC']));
check('Coinbase → COIN', () => assert.deepStrictEqual(tk('Coinbase lists a new token'), ['COIN']));
check('"strong"/"electronics" do NOT match TRON', () => assert.deepStrictEqual(tk('Syrma SGS Technology shares look strong'), []));
check('real TRON mention → TRX', () => assert.ok(tk('TRON network sees record TRX volume').includes('TRX')));
check('a company named only in the summary is a passing mention when the headline names another', () => {
  const r = resolve('SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips',
    "Elon Musk's SpaceX is in talks to raise $40 billion to buy chips from Nvidia Corp. joins to discuss this and the latest from Apple.");
  assert.deepStrictEqual(r.tickers, ['NVDA']);
});
check('a headline naming several companies keeps them all', () => {
  assert.deepStrictEqual(resolve('Microsoft takes on Apple with Nvidia-powered Surface', 'The Surface line gets on-device models. Tesla was also mentioned.').tickers.sort(), ['AAPL', 'MSFT', 'NVDA']);
});
check('a company named in the summary\'s opening sentence still counts', () => {
  assert.deepStrictEqual(resolve('Bitcoin buying slows', 'Coinbase added 334 bitcoin last week. Analysts at Goldman Sachs were unmoved.').tickers.sort(), ['BTC', 'COIN']);
});
check('a headline that names no company falls back to the summary', () => {
  assert.deepStrictEqual(resolve('Only four trillion-dollar stocks are beating the index', 'Including Nvidia and Apple.').tickers.sort(), ['AAPL', 'NVDA']);
});
check('"US visa limits" does NOT match Visa', () => assert.ok(!tk('Indian IT sector hit by US visa limits').includes('V')));
check('"Visa Inc" → V', () => assert.ok(tk('Visa Inc reports record earnings').includes('V')));

// Executive resolution (no ticker in headline)
check('Tim Cook → AAPL', () => assert.ok(tk('Tim Cook unexpectedly resigns').includes('AAPL')));
check('Mukesh Ambani → RELIANCE', () => assert.ok(tk('Mukesh Ambani announces new venture').includes('RELIANCE')));

check('new CEO resolves: John Ternus → AAPL', () => assert.ok(tk('John Ternus lays out Apple roadmap').includes('AAPL')));
check('chair still resolves: Warren Buffett → BRK.B', () => assert.ok(tk('Warren Buffett trims a stake').includes('BRK.B')));
check('surname alias: "Musk" → TSLA', () => assert.deepStrictEqual(tk('Musk pay package faces a new vote'), ['TSLA']));
check('surname alias is case-sensitive: "musk" → nothing', () => assert.deepStrictEqual(tk('a musk fragrance launch'), []));
check('"Sachin Gupta" does NOT match Achin Gupta (CIPLA)', () => assert.deepStrictEqual(tk('Sachin Gupta joins a fintech startup'), []));
check('accented name: Carol Tomé → UPS', () => assert.ok(tk('Carol Tomé says volumes are recovering').includes('UPS')));

// Symbols that are also everyday uppercase text never match bare
check('"PM Modi" does NOT match Philip Morris', () => assert.deepStrictEqual(tk('PM Modi to address investors'), []));
check('"F&O ban" does NOT match Ford', () => assert.deepStrictEqual(tk('Stocks under F&O ban today'), []));
check('"Series C" does NOT match Citigroup', () => assert.deepStrictEqual(tk('Startup closes Series C round'), []));
check('"RTX 5090" → NVDA only, not RTX Corp', () => assert.deepStrictEqual(tk('Nvidia RTX 5090 supply improves'), ['NVDA']));
check('those companies still resolve by name', () => assert.deepStrictEqual(
  tk('Ford, Citigroup and Philip Morris report earnings'), ['C', 'F', 'PM']));

// Ordinary words that are also names/aliases
check('"investors chase the rally" does NOT match JPM', () => assert.deepStrictEqual(tk('Investors chase the rally'), []));
check('"reliance on imports" does NOT match RELIANCE', () => assert.deepStrictEqual(tk('India cuts reliance on imports'), []));
check('"Kotak Mahindra Bank" does NOT match M&M', () => assert.deepStrictEqual(tk('Kotak Mahindra Bank posts profit'), ['KOTAKBANK']));
check('"Tech Mahindra" → TECHM only', () => assert.deepStrictEqual(tk('Tech Mahindra wins a large deal'), ['TECHM']));
check('bare "Mahindra" → M&M', () => assert.deepStrictEqual(tk('Mahindra launches a new electric SUV'), ['M&M']));
check('"HDFC Life" → HDFCLIFE only, "HDFC Bank" → HDFCBANK', () => {
  assert.deepStrictEqual(tk('HDFC Life premiums grow 12%'), ['HDFCLIFE']);
  assert.deepStrictEqual(tk('HDFC Bank cuts deposit rates'), ['HDFCBANK']);
});
check('"Tata Motors PV" → TMPV only, "Tata Motors CV" → TMCV only', () => {
  assert.deepStrictEqual(tk('Tata Motors PV sales jump 46%'), ['TMPV']);
  assert.deepStrictEqual(tk('Tata Motors CV gains on volume growth'), ['TMCV']);
});
check('brokerage arms are not the bank: HDFC Securities, Kotak Institutional, ICICI Securities', () => {
  assert.deepStrictEqual(tk('Vinay Rajani of HDFC Securities bullish on Shipping Corp'), []);
  assert.deepStrictEqual(tk('Kotak Institutional Equities says valuations are stretched'), []);
  assert.deepStrictEqual(tk('ICICI Securities initiates coverage on a cement maker'), []);
  assert.deepStrictEqual(tk('HDFC cuts lending rates'), ['HDFCBANK']);
  assert.deepStrictEqual(tk('Kotak posts record quarterly profit'), ['KOTAKBANK']);
});
check('"Meta" → META', () => assert.deepStrictEqual(tk('Meta shares jump after earnings'), ['META']));
check('Zomato brand → ETERNAL', () => assert.deepStrictEqual(tk('Zomato raises platform fee'), ['ETERNAL']));

// Commodities
check('gold price news → XAU', () => assert.deepStrictEqual(tk('Gold hits a record as the dollar slips'), ['XAU']));
check('a held "Gold" position does NOT match Goldman', () => assert.deepStrictEqual(
  tk('Goldman Sachs raises its S&P target', [{ ticker: 'XAU', name: 'Gold' }]), ['GS']));

// Symbols: uppercase only
check('uppercase SOL → SOL', () => assert.ok(tk('SOL surges 10% on upgrade').includes('SOL')));
check('lowercase "sole" → nothing', () => assert.deepStrictEqual(tk('the sole reason for delay'), []));

// Multiple companies in one headline
check('IT names all resolve', () => assert.deepStrictEqual(
  tk('Nifty IT slips: TCS, Infosys, Wipro fall'), ['INFY', 'TCS', 'WIPRO']));

// Possessive / brand alias
check("Apple's → AAPL", () => assert.deepStrictEqual(tk("Apple's revenue beats estimates"), ['AAPL']));
check('Jio brand → RELIANCE', () => assert.ok(tk('Jio Platforms eyes IPO').includes('RELIANCE')));

// Sector themes (no single company named)
check('"IT sector" → Information Technology', () => assert.ok(sec('Indian IT sector under pressure').includes('Information Technology')));
check('"private banks" → Financials', () => assert.ok(sec('private banks look strong this quarter').includes('Financials')));

// Holdings outside the curated universe still resolve
check('extra holding ZOMATO', () => assert.ok(tk('ZOMATO posts maiden profit', [{ ticker: 'ZOMATO', name: 'Zomato' }]).includes('ZOMATO')));

// Data integrity of the curated files
check('no duplicate tickers', () => assert.strictEqual(new Set(companies.map((c) => c.ticker)).size, companies.length));
check('every equity has a current executive', () => {
  const withExec = new Set(executives.filter((e) => !e.ended_on).map((e) => e.ticker));
  const missing = companies.filter((c) => c.asset_class === 'equity' && !withExec.has(c.ticker)).map((c) => c.ticker);
  assert.deepStrictEqual(missing, []);
});
check('every executive belongs to a listed company', () => {
  const known = new Set(companies.map((c) => c.ticker));
  assert.deepStrictEqual(executives.filter((e) => !known.has(e.ticker)).map((e) => e.ticker), []);
});
check('a checked date always comes with its source', () => assert.deepStrictEqual(
  executives.filter((e) => !!e.as_of !== !!e.source).map((e) => e.full_name), []));


console.log('commodities are matched on the headline:');
const full = (title, summary) => resolve(title, summary).tickers.sort();
check('a passing mention in the summary does not tag the commodity (the RBI story)', () => {
  assert.ok(!full('RBI hike reinforces stock selection, not broad equity caution: Ajit Mishra',
    'Going ahead, crude oil prices, food inflation, the rupee and global monetary conditions will be the key variables to watch.').includes('WTI'));
  assert.ok(!full('Sensex slides 304 points, Nifty ends below 23,450', 'Gold and crude oil were steady.').some((x) => ['WTI', 'XAU'].includes(x)));
});
check('an alias in the headline still tags it', () => {
  assert.ok(full('Crude oil jumps 3% on supply fears', '').includes('WTI'));
  assert.ok(full('Gold hits a record high', '').includes('XAU'));
  assert.ok(full('Oil prices rise as storm nears Gulf', 'Brent futures rose 93 cents.').includes('WTI'));
});
check('a bare headline word confirms an alias found in the summary', () => {
  assert.ok(full('Oil rises and stocks fall as Hormuz worries flare', 'Oil prices rose Wednesday amid fresh concerns.').includes('WTI'));
  assert.ok(!full('Oil rises and stocks fall as Hormuz worries flare', 'Shares slid in early trade.').includes('WTI')); // no alias anywhere → no tag
});
check('the rule is for commodities only: a company named only in the summary still resolves', () => {
  assert.ok(full('Chipmakers rally', 'Nvidia led the gains.').includes('NVDA'));
  assert.ok(full('Markets wrap', 'Bitcoin slipped below $60,000.').includes('BTC'));
});

console.log('a commodity word inside a company name is not the commodity:');
check('Senco Gold (a jeweller) is not gold — the three stored headlines', () => {
  assert.deepStrictEqual(tk('Senco Gold jumps 8% on Q2 biz update; achieves highest-ever topline'), []);
  assert.deepStrictEqual(tk('Senco Gold shares gain 6% on strong Q2 business update; revenue up'), []);
  assert.deepStrictEqual(tk('PC Jeweller vs Senco Gold vs Kalyan Jewellers - Best jewellery stock to buy'), []);
  assert.deepStrictEqual(full('Senco Gold jumps 8% on Q2 biz update', 'Senco Gold shares rose after the jeweller reported record revenue.'), []);
});
check('known company names: gold, silver, oil', () => {
  assert.deepStrictEqual(tk('Barrick Gold Raises Dividend After Strong Quarter'), []);
  assert.deepStrictEqual(tk('Gold Fields to buy a Canadian miner'), []);
  assert.deepStrictEqual(tk('SILVER LAKE LEADS $2 BILLION BUYOUT'), []);
  assert.deepStrictEqual(tk('Pan American Silver posts a quarterly loss'), []);
  assert.deepStrictEqual(full('Oil India shares rise 4%', 'Crude oil output grew at the explorer.'), []);
  assert.deepStrictEqual(full('Indian Oil prices its bond issue', 'The refiner raised Rs 2,500 crore.'), []);
  assert.deepStrictEqual(full('Oil and Natural Gas Corporation posts record profit', 'Higher crude oil prices and natural gas output lifted earnings.'), ['ONGC']);
  assert.deepStrictEqual(full('Petronet LNG expands its Dahej terminal', 'Natural gas demand is rising.'), []);
});
check('a name not on the list: Capitalised word in front, or "Ltd" behind', () => {
  assert.deepStrictEqual(tk('Thangam Gold shares hit upper circuit after results'), []);
  assert.deepStrictEqual(tk('Laxmi Silver Ltd files for an IPO'), []);
  assert.deepStrictEqual(tk("Thangam Gold's promoters pledge shares"), []);
});
check('real commodity headlines still resolve', () => {
  assert.deepStrictEqual(tk('Gold slides to two-month low as robust dollar weighs'), ['XAU']);
  assert.deepStrictEqual(tk('Gold prices rise on safe-haven demand'), ['XAU']);
  assert.deepStrictEqual(tk('Spot Gold Falls To Two-Month Low As Dollar Firms'), ['XAU']);
  assert.deepStrictEqual(tk('Why Gold is rising again'), ['XAU']);
  assert.deepStrictEqual(tk('MCX Gold slips below Rs 1 lakh'), ['XAU']);
  assert.deepStrictEqual(tk('RBI Gold reserves rise for a sixth week'), ['XAU']);
  assert.deepStrictEqual(tk('India Gold demand falls as prices bite'), ['XAU']);
  assert.deepStrictEqual(tk('Dollar firms. Gold slips for a third day'), ['XAU']);
  assert.deepStrictEqual(tk('Gold, Silver rates today'), ['XAG', 'XAU']);
  assert.deepStrictEqual(tk('Silver outshines gold this year'), ['XAG', 'XAU']);
  assert.deepStrictEqual(full('Brent Oil climbs past $90', 'Oil prices rose on supply fears.'), ['WTI']);
});
check('a company and the commodity in one headline: the commodity still counts', () => {
  assert.deepStrictEqual(tk('Senco Gold falls as gold prices hit a record'), ['XAU']);
  assert.deepStrictEqual(full('Oil India gains as oil tops $90', 'Crude oil rallied overnight.'), ['WTI']);
});

check('a commodity word describing something else is not the commodity', () => {
  // The stored headline that reached a gold holder's feed as high-impact gold news.
  assert.deepStrictEqual(tk('SIM-Swap Fraudster Who Spent Stolen Crypto on Gold Grills and Dubai Trips Jailed'), []);
  assert.deepStrictEqual(tk('India wins Olympic gold medal in javelin'), []);
  assert.deepStrictEqual(tk('Markets find a silver lining in weak jobs data'), []);
  assert.deepStrictEqual(tk('Why this fund is the gold standard for index investors'), []);
  assert.deepStrictEqual(tk('Palm oil prices jump on Indonesia export curbs'), []);
  assert.deepStrictEqual(tk('Olive oil shortage pushes up grocery bills'), []);
  // The commodity itself is untouched, including beside one of the phrases.
  assert.deepStrictEqual(tk('Gold rush: prices hit a record as investors pile in'), ['XAU']);
  assert.deepStrictEqual(tk('Gold Prices Hit Record High As Dollar Slides'), ['XAU']);
  assert.deepStrictEqual(tk('Gold medal for bullion: gold tops $4,000'), ['XAU']);
  assert.deepStrictEqual(full('Oil prices rise as palm oil also gains', 'Crude oil climbed.'), ['WTI']);
});

console.log('crypto and India coverage:');
check('every universe coin is filed as crypto and has a price key', () => {
  const { resolveAsset, coingeckoIdFor, NON_EQUITY_ALIASES } = require('../server/services/assetRegistry');
  const coins = companies.filter((c) => c.asset_class === 'crypto').map((c) => c.ticker);
  assert.strictEqual(coins.length, 46);
  assert.deepStrictEqual(coins.filter((t) => resolveAsset(t).assetClass !== 'crypto' || !coingeckoIdFor(t)), []);
  assert.strictEqual(coingeckoIdFor('AAPL'), null);
  // The legacy matcher must not learn "etc" / "near" / "ton" as aliases.
  assert.deepStrictEqual(['ETC', 'NEAR', 'TON', 'UNI'].filter((t) => t in NON_EQUITY_ALIASES), []);
});
check('a coin with a distinctive name needs no cue', () => {
  assert.deepStrictEqual(tk('Zcash and Monero lead privacy rally'), ['XMR', 'ZEC']);
  assert.deepStrictEqual(tk('Hyperliquid volumes hit a record'), ['HYPE']);
  assert.deepStrictEqual(tk('Aave votes on a new fee switch'), ['AAVE']);
  assert.deepStrictEqual(tk('Filecoin and Bittensor slide'), ['FIL', 'TAO']);
});
check('a coin named by an everyday word counts only in a crypto story', () => {
  assert.deepStrictEqual(tk('Jupiter token jumps 12% after buyback vote'), ['JUP']);
  assert.deepStrictEqual(tk('NASA probe sends new images of Jupiter'), []);
  assert.deepStrictEqual(tk('Jupiter Wagons wins a Rs 500 crore order'), []);
  assert.deepStrictEqual(tk('Render leads AI tokens higher'), ['RENDER']);
  assert.deepStrictEqual(tk('Studios render films faster with new chips'), []);
  assert.deepStrictEqual(tk('Quant Mutual Fund raises stake in Reliance'), ['RELIANCE']);
  assert.deepStrictEqual(tk('Quant climbs as banks test its blockchain'), ['QNT']);
  assert.deepStrictEqual(tk('Pepe Jeans to open 50 stores in India'), []);
  assert.deepStrictEqual(tk('Pepe memecoin slides 20% in a day'), ['PEPE']);
  assert.deepStrictEqual(tk('Ondo State governor signs budget'), []);
  assert.deepStrictEqual(tk('Aerodrome licence granted for Noida airport'), []);
  assert.deepStrictEqual(tk('Sui Southern Gas posts a quarterly loss'), []);
  assert.deepStrictEqual(tk('A sui generis ruling from the court'), []);
  assert.deepStrictEqual(tk('Sui blockchain halts for two hours'), ['SUI']);
  assert.deepStrictEqual(tk('SUI token unlock worth $100M due Friday'), ['SUI']);
});
check('a coin symbol that is also a word counts only in a crypto story', () => {
  assert.deepStrictEqual(tk('AI HYPE fades as chip stocks slip'), []);
  assert.deepStrictEqual(tk('HYPE token rallies on Hyperliquid buyback'), ['HYPE']);
  assert.deepStrictEqual(tk('RAY and INJ lead altcoin gains'), ['INJ', 'RAY']);
  assert.deepStrictEqual(tk('ICP norms tightened for exporters'), []);
  assert.deepStrictEqual(tk('CAKE SALE: bakery chains cut prices'), []);
  assert.deepStrictEqual(tk('PancakeSwap burns 9M CAKE in a week'), ['CAKE']);
});
check('the crypto talk may sit in the summary while the headline names the coin', () => {
  assert.deepStrictEqual(resolve('Robinhood adds Jupiter for US users', 'The Solana DEX aggregator said trading goes live next week.').tickers.sort(), ['HOOD', 'JUP', 'SOL']);
  assert.deepStrictEqual(resolve('Robinhood adds Jupiter for US users', 'The planet-themed savings product goes live next week.').tickers, ['HOOD']);
});
check('GDELT covers every Indian universe name, a capped slice per run, rotating', () => {
  const { INDIA_TICKERS, indiaTerm, indiaBatch } = require('../server/services/ingest/gdelt');
  const india = companies.filter((c) => c.country === 'IN').map((c) => c.ticker);
  assert.deepStrictEqual(india.filter((t) => !INDIA_TICKERS.has(t)), []);
  assert.deepStrictEqual(india.filter((t) => !indiaTerm(t) || /[&'’]/.test(indiaTerm(t))), []);
  assert.strictEqual(indiaTerm('RELIANCE'), 'reliance');
  assert.strictEqual(indiaTerm('ASIANPAINT'), '"Asian Paints"');
  assert.strictEqual(indiaTerm('LT'), 'Larsen Toubro');
  assert.deepStrictEqual(indiaBatch(['TCS', 'AAPL', 'INFY', 'TCS']), { tickers: ['INFY', 'TCS'], next: 0 });
  const seen = new Set();
  let cursor = 0;
  for (let i = 0; i < 5; i++) { const b = indiaBatch(india, cursor, 12); assert.strictEqual(b.tickers.length, 12); b.tickers.forEach((x) => seen.add(x)); cursor = b.next; }
  assert.strictEqual(seen.size, india.length);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
