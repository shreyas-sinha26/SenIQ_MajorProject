/**
 * Entity resolution (Engine Phase E1).
 *
 * Replaces the brittle static substring matcher in tickerMatcher.js. Given an
 * article's headline + summary, resolve which tracked entities it's about:
 *   - tickers     : companies named (by name, alias, or uppercase symbol) + any
 *                   executive named (→ their company) + caller-supplied extra holdings
 *   - executives  : executive names mentioned (key-person signal)
 *   - sectors     : sector THEMES explicitly mentioned ("banks", "IT sector", "pharma")
 *                   — used so sector-wide news can touch holdings in that sector (E2)
 *
 * Matching rules (chosen to avoid the old false positives like "Bitcoin" → COIN):
 *   - names / multi-word or long (≥4) aliases : case-insensitive substring
 *   - short aliases (≤3, e.g. "amd","itc","sbi"): whole-word, case-insensitive
 *   - ticker SYMBOLS (BTC, AAPL, SOL, V)       : whole-word, UPPERCASE in the original
 *     text only — so "SOL surges" matches but "the sol of the matter" does not
 *   - executive full names                      : case-insensitive substring
 *
 * `buildResolver(companies, executives)` is a pure function (no DB) so resolution is
 * unit-testable offline. The DB-backed `resolve()` lazy-loads + caches an index built
 * from the `companies`/`executives` tables (seeded from data/universe.js on boot).
 */

const { UNIVERSE } = require('../data/universe');

// Sector THEME synonyms → canonical sector. Only fires on explicit sector talk, NOT
// on a single company (so an Apple story doesn't tag the whole Technology sector).
const SECTOR_THEMES = {
  Financials: ['banks', 'banking sector', 'lenders', 'nbfc', 'financial stocks', 'private banks', 'psu banks'],
  'Information Technology': ['it sector', 'it stocks', 'it companies', 'software sector', 'it services'],
  Technology: ['tech stocks', 'tech sector', 'semiconductor', 'chipmakers', 'chip stocks', 'big tech'],
  Pharmaceuticals: ['pharma', 'pharmaceutical sector', 'drugmakers', 'pharma stocks'],
  'Health Care': ['healthcare sector', 'health stocks', 'hospital stocks'],
  Energy: ['oil sector', 'crude', 'energy stocks', 'refiners', 'oil and gas', 'opec'],
  Automobile: ['auto sector', 'automakers', 'carmakers', 'auto stocks', 'ev makers'],
  FMCG: ['fmcg', 'consumer goods', 'staples'],
  Materials: ['metal stocks', 'steel sector', 'cement sector', 'miners', 'commodities'],
  Crypto: ['crypto', 'cryptocurrency', 'altcoin', 'altcoins', 'digital assets', 'crypto market'],
  Power: ['power sector', 'utilities', 'power stocks'],
  Telecom: ['telecom sector', 'telcos', 'telecom stocks'],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Company names that are also ordinary English words — only count them when they
// appear Capitalized/UPPER in the original text (so "US visa limits" ≠ Visa Inc).
const AMBIGUOUS = new Set(['visa']);
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Flatten the curated universe into the row shapes the resolver/seeder use.
function universeRows() {
  const companies = UNIVERSE.map((c) => ({
    ticker: c.ticker,
    name: c.name,
    aliases: c.aliases || [],
    sector: c.sector || null,
    asset_class: c.assetClass || 'equity',
    exchange: c.exchange || null,
    country: c.country || null,
  }));
  const executives = [];
  for (const c of UNIVERSE) {
    for (const e of c.execs || []) executives.push({ full_name: e.name, ticker: c.ticker, role: e.role || null });
  }
  return { companies, executives };
}

/**
 * Pure resolver factory. companies: [{ticker,name,aliases,sector,...}],
 * executives: [{full_name, ticker}].
 */
function buildResolver(companies, executives) {
  // alias (lowercase) → Set(tickers); whether it needs whole-word matching.
  const longAliases = new Map(); // substring match
  const shortAliases = new Map(); // whole-word match
  const capitalAliases = new Map(); // ambiguous: whole-word, Capitalized/UPPER only
  const symbolByTicker = new Map(); // ticker → uppercase symbol
  const sectorByTicker = new Map();

  const addAlias = (alias, ticker) => {
    const a = alias.toLowerCase().trim();
    if (!a) return;
    // Ambiguous common-word names match only when capitalized; multi-word phrases match
    // as substrings; ANY single-token name matches whole-word — so "TRON" doesn't fire
    // on "sTRONg"/"elecTRONics" and "reliance" still matches "Reliance".
    const map = AMBIGUOUS.has(a) ? capitalAliases : a.includes(' ') ? longAliases : shortAliases;
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(ticker);
  };

  for (const c of companies) {
    sectorByTicker.set(c.ticker, c.sector || null);
    symbolByTicker.set(c.ticker, c.ticker.toUpperCase());
    addAlias(c.name, c.ticker);
    for (const al of c.aliases || []) addAlias(al, c.ticker);
  }

  const execMap = new Map(); // lowercase exec name → ticker
  for (const e of executives) execMap.set(e.full_name.toLowerCase(), e.ticker);

  // Precompile whole-word regexes for short aliases + symbols.
  const shortAliasRe = [...shortAliases.keys()].map((a) => ({
    re: new RegExp(`\\b${escapeRegex(a)}\\b`, 'i'),
    tickers: shortAliases.get(a),
  }));
  const symbolRe = [...symbolByTicker.entries()].map(([ticker, sym]) => ({
    re: new RegExp(`\\b${escapeRegex(sym)}\\b`), // case-SENSITIVE: uppercase symbol only
    ticker,
  }));
  const capitalRe = [...capitalAliases.keys()].map((a) => ({
    re: new RegExp(`\\b(${escapeRegex(titleCase(a))}|${escapeRegex(a.toUpperCase())})\\b`), // case-sensitive
    tickers: capitalAliases.get(a),
  }));
  const sectorThemeRe = [];
  for (const [sector, syns] of Object.entries(SECTOR_THEMES)) {
    for (const s of syns) sectorThemeRe.push({ re: new RegExp(`\\b${escapeRegex(s)}\\b`, 'i'), sector });
  }

  function resolve(title = '', summary = '', extra = []) {
    const original = `${title} ${summary}`;
    const lower = original.toLowerCase();
    const tickers = new Set();
    const executivesHit = new Set();
    const sectors = new Set();

    // Company names / long aliases (case-insensitive substring).
    for (const [alias, tks] of longAliases) {
      if (lower.includes(alias)) tks.forEach((t) => tickers.add(t));
    }
    // Short aliases (whole-word, case-insensitive).
    for (const { re, tickers: tks } of shortAliasRe) {
      if (re.test(lower)) tks.forEach((t) => tickers.add(t));
    }
    // Ticker symbols (whole-word, UPPERCASE only — avoids "sol"/"ada" noise).
    for (const { re, ticker } of symbolRe) {
      if (re.test(original)) tickers.add(ticker);
    }
    // Ambiguous common-word names (e.g. "Visa") — only when capitalized in original.
    for (const { re, tickers: tks } of capitalRe) {
      if (re.test(original)) tks.forEach((t) => tickers.add(t));
    }
    // Executives → their company (key-person events with no ticker in the headline).
    for (const [name, ticker] of execMap) {
      if (lower.includes(name)) { tickers.add(ticker); executivesHit.add(name); }
    }
    // Extra holdings outside the curated universe (still get basic matching).
    for (const e of extra) {
      const t = typeof e === 'string' ? { ticker: e } : e;
      if (!t.ticker || tickers.has(t.ticker)) continue;
      const symRe = new RegExp(`\\b${escapeRegex(t.ticker.toUpperCase())}\\b`);
      if (symRe.test(original)) { tickers.add(t.ticker); continue; }
      if (t.name && t.name.length >= 4 && lower.includes(t.name.toLowerCase())) tickers.add(t.ticker);
    }
    // Explicit sector themes.
    for (const { re, sector } of sectorThemeRe) {
      if (re.test(lower)) sectors.add(sector);
    }

    return { tickers: [...tickers], executives: [...executivesHit], sectors: [...sectors] };
  }

  return { resolve, sectorByTicker };
}

// ─── DB-backed singleton (cached index, refreshed periodically) ──────
let _resolver = null;
let _loadedAt = 0;
const TTL_MS = 10 * 60 * 1000;

async function loadIndex(force = false) {
  if (_resolver && !force && Date.now() - _loadedAt < TTL_MS) return _resolver;
  const { query } = require('../db');
  const companies = await query('SELECT ticker, name, aliases, sector, asset_class FROM companies WHERE is_active = true');
  const executives = await query('SELECT full_name, ticker FROM executives');
  _resolver = buildResolver(companies, executives);
  _loadedAt = Date.now();
  return _resolver;
}

async function resolve(title, summary, extra = []) {
  const r = await loadIndex();
  return r.resolve(title, summary, extra);
}

// Idempotent seed of the curated universe (called on boot, after migrations).
async function seedUniverse() {
  const { query, execute } = require('../db');
  const { companies, executives } = universeRows();
  for (const c of companies) {
    await execute(
      `INSERT INTO companies (ticker, name, aliases, sector, asset_class, exchange, country, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (ticker) DO UPDATE SET
         name=EXCLUDED.name, aliases=EXCLUDED.aliases, sector=EXCLUDED.sector,
         asset_class=EXCLUDED.asset_class, exchange=EXCLUDED.exchange, country=EXCLUDED.country,
         updated_at=now()`,
      [c.ticker, c.name, c.aliases, c.sector, c.asset_class, c.exchange, c.country]
    );
  }
  for (const e of executives) {
    await execute(
      `INSERT INTO executives (full_name, ticker, role) VALUES ($1,$2,$3)
       ON CONFLICT (full_name, ticker) DO UPDATE SET role=EXCLUDED.role`,
      [e.full_name, e.ticker, e.role]
    );
  }
  const n = (await query('SELECT count(*) c FROM companies'))[0].c;
  console.log(`   🏷️  universe seeded: ${n} companies, ${executives.length} executives`);
}

module.exports = { buildResolver, resolve, loadIndex, seedUniverse, universeRows, SECTOR_THEMES };
