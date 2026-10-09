#!/usr/bin/env node
/**
 * Build the listed tier of the company reference: server/data/listed.json.
 *
 *   node scripts/build_listed_universe.js            read the source files, write listed.json
 *   node scripts/build_listed_universe.js --check    print what would be written, write nothing
 *
 * The curated universe (server/data/universe.js) is written by hand: aliases, brands,
 * executives. The listed tier is everything else a user may hold — the S&P 1500 and the
 * Nifty 500 — taken from published constituent lists with only what those lists give:
 * symbol, name, sector. A listed company is matched in news strictly, and only while
 * someone holds it (entityResolver.js, "listed tier").
 *
 * Source files, in server/data/sources/ (downloaded by hand, not committed):
 *   sp500.wikitext, sp400.wikitext, sp600.wikitext
 *       Wikipedia's "List of S&P 500 / 400 / 600 companies", raw wikitext
 *       (…/w/index.php?title=List_of_S%26P_500_companies&action=raw). CC BY-SA 4.0.
 *   nifty500.csv
 *       niftyindices.com → Nifty 500 → constituents download (ind_nifty500list.csv):
 *       Company Name, Industry, Symbol, Series, ISIN Code. Optional: without it the India
 *       part is left as it was in the existing listed.json.
 *
 * A company already in the curated universe is left out (the curated entry wins). A name
 * that is a single ordinary English word ("Target", "Gap") is flagged `plain`, so the
 * resolver asks for a company cue beside it; the word list is this machine's
 * /usr/share/dict/words, read at build time only.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'server', 'data', 'sources');
const OUT = path.join(__dirname, '..', 'server', 'data', 'listed.json');
const { UNIVERSE } = require('../server/data/universe');

// GICS sector (Wikipedia) and NSE industry (Nifty list) → the sector words the curated
// universe already uses, so sector-wide news touches listed holdings the same way.
const GICS = {
  'Information Technology': 'Technology', 'Communication Services': 'Communication Services',
  'Consumer Discretionary': 'Consumer Discretionary', 'Consumer Staples': 'Consumer Staples',
  Energy: 'Energy', Financials: 'Financials', 'Health Care': 'Health Care', Industrials: 'Industrials',
  Materials: 'Materials', 'Real Estate': 'Real Estate', Utilities: 'Utilities',
};
const NSE_INDUSTRY = [
  [/information technology/i, 'Information Technology'], [/financial|bank|insurance/i, 'Financials'],
  [/health|pharma/i, 'Pharmaceuticals'], [/automobile|auto components/i, 'Automobile'],
  [/fast moving consumer goods|fmcg/i, 'FMCG'], [/oil|gas|consumable fuels/i, 'Energy'],
  [/metals|mining|chemicals|construction materials|forest/i, 'Materials'], [/power|utilities/i, 'Power'],
  [/telecom/i, 'Telecom'], [/capital goods|construction|services|diversified/i, 'Industrials'],
  [/consumer durables|consumer services|textiles|media|realty/i, 'Consumer Discretionary'],
];

// Wiki cell → plain text: drop a leading style attribute, templates, links and refs.
function cell(raw) {
  return String(raw)
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/g, '')
    .replace(/^\s*(?:style|class|rowspan|colspan|data-sort-value)="[^"]*"\s*\|/i, '')
    .replace(/\{\{Anchor\|[^}]*\}\}/gi, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/''+/g, '')
    .trim();
}

// The constituents table of one page → [{ ticker, name, sector, exchange: 'US' }].
function parseWiki(text, file) {
  const start = text.indexOf('id="constituents"');
  if (start < 0) throw new Error(`${file}: no constituents table`);
  const table = text.slice(start, text.indexOf('\n|}', start));
  const out = [];
  for (const row of table.split(/\n\|-[^\n]*/).slice(1)) {
    // A cell starts on a new line with "|" or "||", or follows "||" on the same line.
    const cells = row.replace(/\n\|\|/g, '\n|').split(/\n\||\|\|/).map((c) => c.trim()).filter((c, i) => i > 0 || c);
    const sym = (row.match(/\{\{(?:Nyse|Nasdaq|BATS|Cboe|NYSE American)[A-Za-z ]*Symbol\|([^}|]+)/i) || [])[1];
    if (!sym) continue;
    const texts = cells.map(cell).filter((c) => c && !/^\{\{.*Symbol\|/i.test(c));
    const name = texts[0];
    const sector = GICS[(texts[1] || '').trim()];
    if (!name || !sector) throw new Error(`${file}: could not read the row for ${sym} (${JSON.stringify(texts.slice(0, 3))})`);
    out.push({ ticker: sym.trim().toUpperCase(), name, sector, exchange: 'US', country: 'US' });
  }
  return out;
}

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseNifty(text) {
  const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = parseCsvLine(head).map((c) => c.toLowerCase());
  const at = (name) => { const i = cols.findIndex((c) => c.startsWith(name)); if (i < 0) throw new Error(`nifty500.csv: no "${name}" column`); return i; };
  const [iName, iInd, iSym] = [at('company name'), at('industry'), at('symbol')];
  return lines.map((l) => {
    const c = parseCsvLine(l);
    const sector = (NSE_INDUSTRY.find(([re]) => re.test(c[iInd])) || [null, 'Industrials'])[1];
    return { ticker: c[iSym].toUpperCase(), name: c[iName], sector, exchange: 'NSE', country: 'IN' };
  }).filter((r) => r.ticker && r.name);
}

// The name with its corporate tail removed: what a headline actually writes.
const TAIL = /[\s,]+(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|n\.?v|s\.?a|holdings?|group|trust|the)\.?$/i;
function coreName(name) {
  let n = String(name).replace(/\s*\((?:class [a-z]|the)\)\s*/gi, ' ').replace(/^the\s+/i, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3 && TAIL.test(n); i++) n = n.replace(TAIL, '').replace(/[\s,&]+$/, '').trim();
  return n || String(name).trim();
}

function main() {
  const check = process.argv.includes('--check');
  const read = (f) => (fs.existsSync(path.join(SRC, f)) ? fs.readFileSync(path.join(SRC, f), 'utf8') : null);
  const curated = new Set(UNIVERSE.map((c) => c.ticker));
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { sources: {}, companies: [] };

  const us = [];
  for (const f of ['sp500', 'sp400', 'sp600']) {
    const text = read(`${f}.wikitext`);
    if (!text) throw new Error(`server/data/sources/${f}.wikitext is missing — see the header of this script`);
    us.push(...parseWiki(text, f));
  }
  const niftyText = read('nifty500.csv');
  const india = niftyText ? parseNifty(niftyText) : prev.companies.filter((c) => c.country === 'IN');

  let words = new Set();
  try { words = new Set(fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').map((w) => w.toLowerCase())); } catch { /* no word list: nothing is flagged */ }

  const seen = new Set();
  const companies = [];
  for (const c of [...us, ...india]) {
    if (curated.has(c.ticker) || seen.has(c.ticker)) continue;
    seen.add(c.ticker);
    const core = coreName(c.name);
    const row = { ticker: c.ticker, name: c.name, core, sector: c.sector, exchange: c.exchange, country: c.country };
    if (!/\s/.test(core) && words.has(core.toLowerCase())) row.plain = true;
    companies.push(row);
  }
  companies.sort((a, b) => (a.country + a.ticker < b.country + b.ticker ? -1 : 1));

  const today = new Date().toISOString().slice(0, 10);
  const out = {
    note: 'Built by scripts/build_listed_universe.js — do not edit by hand. US: Wikipedia lists of S&P 500/400/600 companies (CC BY-SA 4.0). India: NSE Indices Nifty 500 constituents.',
    sources: { us: today, india: niftyText ? today : (prev.sources.india || null) },
    companies,
  };
  const n = (country) => companies.filter((c) => c.country === country).length;
  console.log(`US: ${us.length} rows read, ${n('US')} listed after leaving out ${us.filter((c) => curated.has(c.ticker)).length} curated`
    + `; India: ${niftyText ? `${india.length} rows read` : 'no nifty500.csv — kept as it was'}, ${n('IN')} listed`
    + `; ${companies.filter((c) => c.plain).length} names are single ordinary words (matched only beside a company cue).`);
  if (check) { console.log(companies.slice(0, 5), '…'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{') + '\n');
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

if (require.main === module) main();
module.exports = { parseWiki, parseNifty, coreName };
