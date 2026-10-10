/**
 * Offline tests for the listed tier of the company reference: reading the published
 * constituent lists (scripts/build_listed_universe.js), the strict matching of a held
 * company that has no hand-written entry (entityResolver.namesHolding), and the everyday
 * words among the commodities.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const { parseWiki, parseNifty, coreName } = require('../scripts/build_listed_universe');
const { buildResolver, universeRows, namesHolding, indianListed, LISTED_NEEDS_CUE } = require('../server/services/entityResolver');
const LISTED = require('../server/data/listed.json');

const { companies, executives } = universeRows();
const { resolve } = buildResolver(companies, executives);
const names = (ticker, text, name) => namesHolding({ ticker, name }, text);
const tk = (title, held = []) => resolve(title, '', held).tickers.sort();

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('reading the published lists:');
check('a wiki table: one cell per line, several on a line, links, anchors and style attributes', () => {
  const page = `intro\n{| class="wikitable" id="constituents"\n! Symbol !! Security\n|-\n|| {{NyseSymbol|MMM}}\n|| [[3M]]\n|| Industrials \n|| Industrial Conglomerates\n`
    + `|-\n|| {{NyseSymbol|EME}}\n|| [[Emcor]]|| Industrials\n|| Construction\n`
    + `|-\n| style="border-color:inherit;" | {{NasdaqSymbol|AAL}}\n| style="border-color:inherit;" | [[American Airlines Group]]\n| Industrials\n| Airlines\n`
    + `|-\n|{{Anchor|A}}{{NyseSymbol|AAMI}}\n|[[Acadian Asset Management|Acadian Asset Management Inc.]]\n| Financials \n| Asset Management\n|}\n{| id="changes"\n|-\n| {{NyseSymbol|ZZZ}}\n| [[Gone]]\n| Energy\n|}`;
  assert.deepStrictEqual(parseWiki(page, 'test').map((c) => [c.ticker, c.name, c.sector]), [
    ['MMM', '3M', 'Industrials'], ['EME', 'Emcor', 'Industrials'], ['AAL', 'American Airlines Group', 'Industrials'],
    ['AAMI', 'Acadian Asset Management Inc.', 'Financials']]);
  assert.throws(() => parseWiki('no table here', 'test'), /no constituents table/);
});
check('GICS "Information Technology" becomes the curated universe\'s "Technology"', () => {
  const page = '{| id="constituents"\n|-\n| {{NasdaqSymbol|LRCX}}\n| [[Lam Research]]\n| Information Technology\n| Semis\n|}';
  assert.strictEqual(parseWiki(page, 'test')[0].sector, 'Technology');
});
check('the Nifty 500 file: quoted names, industry → sector', () => {
  const csv = 'Company Name,Industry,Symbol,Series,ISIN Code\n360 ONE WAM Ltd.,Financial Services,360ONE,EQ,INE466L01038\n"Aarti Industries Ltd.",Chemicals,AARTIIND,EQ,INE769A01020\nPolycab India Ltd.,Capital Goods,POLYCAB,EQ,INE455K01017\n';
  assert.deepStrictEqual(parseNifty(csv).map((c) => [c.ticker, c.name, c.sector, c.exchange, c.country]), [
    ['360ONE', '360 ONE WAM Ltd.', 'Financials', 'NSE', 'IN'], ['AARTIIND', 'Aarti Industries Ltd.', 'Materials', 'NSE', 'IN'],
    ['POLYCAB', 'Polycab India Ltd.', 'Industrials', 'NSE', 'IN']]);
});
check('the corporate tail comes off the name', () => {
  assert.deepStrictEqual(['Gap Inc.', 'Standex International Corporation', 'Travelers Companies (The)', 'Axos Financial, Inc.', 'Polycab India Ltd.', '3M', 'T. Rowe Price'].map(coreName),
    ['Gap', 'Standex International', 'Travelers Companies', 'Axos Financial', 'Polycab India', '3M', 'T. Rowe Price']);
});
check('the built file: no curated ticker repeated, every row complete', () => {
  const curated = new Set(companies.map((c) => c.ticker));
  assert.ok(LISTED.companies.length > 1000);
  assert.deepStrictEqual(LISTED.companies.filter((c) => curated.has(c.ticker)), []);
  assert.ok(LISTED.companies.every((c) => c.ticker && c.name && c.core && c.sector && c.exchange && c.country));
  assert.strictEqual(new Set(LISTED.companies.map((c) => c.ticker)).size, LISTED.companies.length);
});

console.log('a held listed company in the news:');
check('its name, as whole words with its capitals', () => {
  assert.ok(names('THO', 'Thor Industries cuts its outlook'));
  assert.ok(names('SEZL', 'Sezzle soars after results'));
  assert.ok(!names('SEZL', 'a sezzle of rain'));
  assert.ok(names('PFBC', 'Preferred Bank raises dividend'));
  assert.ok(!names('PFBC', 'HDFC is the preferred bank for exporters'));
});
check('a name that is an ordinary word needs a company cue beside it', () => {
  assert.ok(!names('GAP', 'Mind the gap in earnings'));
  assert.ok(!names('GAP', 'Why Gap Is Falling Today'));
  assert.ok(names('GAP', 'Gap shares jump 8% on strong sales'));
  assert.ok(names('GAP', 'Gap Inc beats estimates'));
  assert.ok(names('GAP', "Gap's quarter disappoints") && !names('XYZ', 'Block party planned'));
});
check('a name headlines use for something else needs a company word beside it, and a possessive is not one', () => {
  // The four found on the stored stories (2026-10-10): a quarter, two exchanges, a broker.
  assert.ok(!names('QTWO', 'Tesla misses Q2 delivery estimates, shares fall premarket'));
  assert.ok(!names('QTWO', 'Poonawalla Fincorp Q2 profit soars five-fold YoY to Rs 375 crore'));
  assert.ok(names('QTWO', 'Q2 Holdings raises full-year guidance') && names('QTWO', 'Why Q2 stock jumped today'));
  assert.ok(!names('BSE', 'BSE Sensex ends 300 points higher') && !names('BSE', "BSE's midcap index hits a record"));
  assert.ok(!names('BSE', 'Adani Power Ltd eases for fifth straight session on the BSE'));
  assert.ok(names('BSE', 'BSE shares jump 5% after Sebi relief') && names('BSE', 'BSE Ltd Q2 profit doubles'));
  assert.ok(!names('NDAQ', 'US stock market today: Nasdaq, S P 500 futures steady') && !names('NDAQ', "Nasdaq's record close lifts tech"));
  assert.ok(names('NDAQ', 'Nasdaq Inc beats estimates on data revenue') && names('NDAQ', 'Shares of Nasdaq rise after results'));
  assert.ok(!names('JEF', 'Jefferies initiates coverage on Poonawalla Fincorp with Buy rating'));
  assert.ok(!names('JEF', 'Maruti Suzuki shares jump 5% after Jefferies upgrades rating to Buy'));
  assert.ok(names('JEF', 'Jefferies shares slide on First Brands exposure'));
  assert.ok(names('NDAQ', 'Exchange operator (NASDAQ: NDAQ) reports volumes'));
  assert.ok(!names('NDAQ', 'Nasdaq stock futures slip before the open') && names('NDAQ', 'Why Nasdaq Stock Jumped Today'));
  const listed = new Set(LISTED.companies.map((c) => c.ticker));
  for (const t of LISTED_NEEDS_CUE) assert.ok(listed.has(t), t);
});
check('the same for a word, a place, a person and a fund\'s name', () => {
  assert.ok(!names('CME', 'CME feeder cattle hit 3-month peak after corn price plunge') && names('CME', 'CME Group to Launch Bitcoin Cash and Uniswap Futures'));
  assert.ok(!names('MSCI', "In Asia, MSCI's broadest index of Asia-Pacific shares fell") && names('MSCI', 'MSCI Inc lifts dividend'));
  assert.ok(!names('STT', 'the State Street Technology Select Sector SPDR ETF fell 1%') && names('STT', 'State Street shares rise on fee income'));
  assert.ok(!names('ROG', 'John Rogers Says Look to Smucker\'s') && names('ROG', 'Rogers Corp cuts outlook'));
  assert.ok(!names('ATUL', 'promoter Atul Garg increased his stake') && !names('ATUL', 'Atul Auto shares jump 5%') && names('ATUL', 'Atul Ltd Q2 profit rises') && names('ATUL', 'ATUL shares gain 3%'));
  assert.ok(!names('CHCO', "GIFT City's insurance premiums quadruple") && names('CHCO', 'City Holding raises dividend'));
  assert.ok(!names('PPLI', "The People's Bank of China maintained the rate"));
  assert.ok(!names('XYZ', "The Block's country profile: inside Korea's crypto market") && names('XYZ', 'Block Inc beats estimates') && names('XYZ', 'Block shares jump 8%'));
});
check('a broker or a rating agency giving its view of another company is not the subject', () => {
  assert.ok(!names('JMFINANCIL', 'Suzlon advances 2% as JM Financial backs FY31 growth plans') && !names('JMFINANCIL', "BlueStone gains 6% as JM Financial reiterates 'Buy'"));
  assert.ok(names('JMFINANCIL', 'JM Financial shares slip 4% after Q2 results') && names('JMFINANCIL', 'JM Financial Ltd approves fund raising'));
  assert.ok(!names('CRISIL', "Epigral rises after Crisil Ratings affirms ratings at 'AA/A1+'") && names('CRISIL', 'Crisil shares gain on dividend') && names('CRISIL', 'CRISIL Ltd Q2 profit up 12%'));
  assert.ok(!names('NUVAMA', 'Metal stocks to buy ahead of Q2 results: Nuvama picks Coal India, Tata Steel') && !names('NUVAMA', 'weak rupee: Nuvama’s Prateek Parekh'));
  assert.ok(names('NUVAMA', 'Nuvama shares hit record high') && names('NUVAMA', 'Nuvama Wealth Management Ltd declares interim dividend'));
  assert.ok(!names('ANGELONE', 'Osho Krishan of Angel One suggests buying CDSL') && names('ANGELONE', 'Angel One shares rally 6% on client additions'));
  assert.ok(!names('MCO', "Moody's assigned Sky a B3 issuer rating") && names('MCO', "Moody's Corp tops estimates"));
  assert.ok(!names('EVR', 'Evercore ISI’s Bullish iPhone Survey Faces a Reality Check') && names('EVR', 'Evercore shares climb after record advisory quarter'));
  // The cost of the rule: named bare as the subject, it is not tagged.
  assert.ok(!names('JMFINANCIL', 'Top losers: TCS, Coforge, JM Financial, Tata Elxsi'));
});
check('the Indian listed names, held or not, as the list the pipeline passes when INDIA_LISTED_NEWS is on', () => {
  const india = indianListed();
  assert.ok(india.length > 400 && india.every((c) => c.ticker && c.name));
  assert.ok(india.every((c) => LISTED.companies.find((x) => x.ticker === c.ticker).country === 'IN'));
  assert.deepStrictEqual(tk('Suzlon Energy shares rise 2% after firm announces foray into solar', india), ['SUZLON']);
  assert.deepStrictEqual(tk('NHPC OFS sails through as non-retail portion subscribed 1.74 times', india), ['NHPC']);
  assert.deepStrictEqual(tk('Sensex, Nifty end flat; BSE midcap index slips', india), []);
  // A curated name keeps its own rules, and a listed name inside the headline does not take them.
  assert.deepStrictEqual(tk('TCS Q2 results: profit rises 6%', india), ['TCS']);
  assert.deepStrictEqual(tk('Suzlon Energy shares rise 2%'), []);   // nobody holds it and the switch is off
});
check('a short US symbol only in exchange notation', () => {
  assert.ok(!names('THO', 'THO rallies'));
  assert.ok(names('THO', 'Thor (NYSE: THO) rallies') && names('SEZL', 'Traders pile into $SEZL'));
});
check('a holding we know nothing about keeps the old symbol rule, without the substring trap', () => {
  assert.ok(names('ABCD', 'ABCD rallies', 'Some Co'));
  assert.ok(names('ZZZZ', 'Zed Corp wins an order', 'Zed Corp'));
  assert.ok(!names('TRENTX', 'The current trend', 'Trent'));
});
check('the resolver uses it for held names, and only for held names', () => {
  assert.deepStrictEqual(tk('Thor Industries cuts its outlook'), []);
  assert.deepStrictEqual(tk('Thor Industries cuts its outlook', [{ ticker: 'THO', name: 'Thor Industries' }]), ['THO']);
  assert.deepStrictEqual(tk('Apple and Thor Industries sign a deal', [{ ticker: 'THO' }]), ['AAPL', 'THO']);
});

console.log('India:');
check('a symbol that is the brand matches in any capitals; one that is a word only in capitals', () => {
  assert.ok(names('PAYTM', 'Paytm shares jump 5%') && names('NYKAA', 'Nykaa Q2 profit doubles') && names('PAYTM', 'One 97 Communications gets RBI nod'));
  assert.ok(!names('CLEAN', 'Clean energy push gathers pace') && names('CLEAN', 'Clean Science and Technology rises'));
  assert.ok(names('IRFC', 'IRFC shares rally') && !names('IDEA', 'A new idea for telecom') && names('IDEA', 'Vodafone Idea gets AGR relief'));
});
check('a name inside a longer name belongs to the longer one', () => {
  assert.ok(names('BANKINDIA', 'Bank of India cuts lending rates'));
  for (const h of ['Reserve Bank of India holds rates', 'Union Bank of India Q2 profit rises', 'State Bank of India raises funds']) assert.ok(!names('BANKINDIA', h), h);
});
check('a listed company\'s name is not read as the curated company inside it', () => {
  assert.deepStrictEqual(tk('ITC Hotels Q2 profit rises'), []);
  assert.deepStrictEqual(tk('ITC Hotels Q2 profit rises', [{ ticker: 'ITCHOTELS' }]), ['ITCHOTELS']);
  assert.deepStrictEqual(tk('ITC and ITC Hotels announce dividends'), ['ITC']);
  assert.deepStrictEqual(tk('Adani Power share price jumps after NCLT nod'), []);
  assert.deepStrictEqual(tk('Reliance Power shares surge 10%'), []);
  assert.deepStrictEqual(tk('SBI Cards and Payment Services posts profit'), []);
  assert.deepStrictEqual(tk('Apple Hospitality REIT raises its dividend'), []);
  assert.deepStrictEqual(tk('Adani Enterprises wins a bid'), ['ADANIENT']);
});
check('the India rows: no placeholder, sectors in the curated vocabulary', () => {
  const india = LISTED.companies.filter((c) => c.country === 'IN');
  assert.ok(india.length > 400 && !india.some((c) => /^DUMMY/.test(c.ticker)));
  assert.ok(india.every((c) => c.exchange === 'NSE'));
  assert.deepStrictEqual(parseNifty('Company Name,Industry,Symbol,Series,ISIN Code\nDummy HEG Ltd.,Capital Goods,DUMMYHEG,EQ,DUM1\nDLF Ltd.,Realty,DLF,EQ,X\nEIH Ltd.,Consumer Services,EIHOTEL,EQ,Y\nACC Ltd.,Construction Materials,ACC,EQ,Z\n').map((c) => [c.ticker, c.sector]),
    [['DLF', 'Real Estate'], ['EIHOTEL', 'Consumer Discretionary'], ['ACC', 'Materials']]);
});

console.log('commodities that are everyday words:');
check('counted in a headline about the commodity as one', () => {
  assert.deepStrictEqual(tk('Sugar prices jump as Brazil output falls'), ['SUGAR']);
  assert.deepStrictEqual(tk('Coffee futures hit record on frost fears'), ['COFFEE']);
  assert.deepStrictEqual(tk('Copper rallies to record on LME'), ['COPPER']);
  assert.deepStrictEqual(tk('Aluminum prices climb on supply cuts'), ['ALUMINIUM']);
});
check('not in everyday use, and not inside a company name', () => {
  assert.deepStrictEqual(tk('Govt mulls sugar tax on soft drinks'), []);
  assert.deepStrictEqual(tk('Copper wire theft disrupts trains'), []);
  assert.deepStrictEqual(tk('Platinum jubilee celebrations'), []);
  assert.deepStrictEqual(tk('Starbucks coffee chain expands in India'), ['SBUX']);
  assert.deepStrictEqual(tk('Hindustan Copper shares jump 5%'), []);
});
check('the first four are unchanged', () => {
  assert.deepStrictEqual(tk('Gold rises as dollar eases'), ['XAU']);
  assert.strictEqual(companies.filter((c) => c.asset_class === 'commodity').length, 15);
});

console.log(`\n${passed} listed-universe checks passed`);
