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
check('"US visa limits" does NOT match Visa', () => assert.ok(!tk('Indian IT sector hit by US visa limits').includes('V')));
check('"Visa Inc" → V', () => assert.ok(tk('Visa Inc reports record earnings').includes('V')));

// Executive resolution (no ticker in headline)
check('Tim Cook → AAPL', () => assert.ok(tk('Tim Cook unexpectedly resigns').includes('AAPL')));
check('Mukesh Ambani → RELIANCE', () => assert.ok(tk('Mukesh Ambani announces new venture').includes('RELIANCE')));

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

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
