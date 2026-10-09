/**
 * Offline tests for the listed tier of the company reference: reading the published
 * constituent lists (scripts/build_listed_universe.js), the strict matching of a held
 * company that has no hand-written entry (entityResolver.namesHolding), and the everyday
 * words among the commodities.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const { parseWiki, parseNifty, coreName } = require('../scripts/build_listed_universe');
const { buildResolver, universeRows, namesHolding } = require('../server/services/entityResolver');
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
  assert.ok(names('XYZ', "Block's quarter disappoints") && !names('XYZ', 'Block party planned'));
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
