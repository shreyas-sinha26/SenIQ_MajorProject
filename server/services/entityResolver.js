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
 *   - longest match wins: an alias sitting inside a longer alias of a DIFFERENT company
 *     is ignored — "Mahindra" in "Tech Mahindra", "HDFC" in "HDFC Life", "Tata Motors"
 *     in "Tata Motors PV" — so a group or parent name doesn't claim its sibling's news
 *   - a short name followed by "securities", "institutional", "AMC"… is that group's
 *     brokerage or fund arm giving an opinion, not the company itself
 *   - a commodity word inside a company's name ("Senco Gold", "Oil India", "Silver Lake")
 *     is the company, not the commodity
 *   - executive full names                      : whole-phrase, case-insensitive (so
 *     "Achin Gupta" does not fire on "Sachin Gupta"); executive ALIASES (surnames like
 *     "Musk") whole-word and case-sensitive. Former executives still resolve.
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
  Utilities: ['utilities', 'utility stocks'],
  Commodities: ['precious metals', 'commodity prices', 'commodity markets'],
  Telecom: ['telecom sector', 'telcos', 'telecom stocks'],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Company names that are also ordinary English words — only count them when they
// appear Capitalized/UPPER in the original text (so "US visa limits" ≠ Visa Inc).
const AMBIGUOUS = new Set(['visa', 'meta', 'reliance', 'avalanche', 'cosmos', 'polygon']);
// Ticker symbols that collide with everyday uppercase text ("PM Modi", "F&O", "Series C",
// "T-bills", "V-shaped", "CAT 2026", "RTX 5090", ACN = acetonitrile) — never matched as bare symbols; these
// companies resolve through their names/aliases only.
// A bank's short name followed by one of these is its brokerage / fund arm talking
// ("HDFC Securities bullish on…", "Kotak Institutional Equities says…") — commentary
// by a different entity, not news about the bank.
const ARM_SUFFIX = /^\s+(securities|institutional|amc|mutual|asset|capital|research|direct|prudential|lombard|cards?|pension|ventures)\b/;
const AMBIGUOUS_SYMBOLS = new Set(['T', 'C', 'F', 'V', 'PM', 'CAT', 'RTX', 'ACN']);
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// A commodity counts only when the HEADLINE is about it (see headlineOnly below). Headlines
// say "Oil rises…" far more often than "oil prices" or "crude oil", so a bare headline word
// is accepted here — but only to confirm an alias that matched somewhere in the article.
const COMMODITY_HEADLINE = {
  WTI: /\b(oil|crude|brent|opec)\b/gi,
  NG: /\b(natural gas|natgas|lng|gas prices)\b/gi,
  XAU: /\b(gold|bullion)\b/gi,
  XAG: /\bsilver\b/gi,
};
// Companies whose NAME contains a commodity word. "Senco Gold jumps 8%" is a jeweller's
// results, not the gold price, so the word inside one of these names never tags the
// commodity. Most of them are outside the universe — they are listed only to be ruled out.
const COMMODITY_COMPANY_NAMES = [
  'Senco Gold', 'Sky Gold', 'Deccan Gold', 'Barrick Gold', 'Gold Fields', 'Harmony Gold', 'Kinross Gold',
  'Royal Gold', 'Eldorado Gold', 'Gold Road',
  'Silver Lake', 'Silver Touch', 'Pan American Silver', 'First Majestic Silver',
  'Oil India', 'Indian Oil', 'Oil and Natural Gas Corp', 'Oil & Natural Gas Corp', 'Hindustan Oil Exploration',
  'Marathon Oil', 'Murphy Oil', 'Imperial Oil', 'Gulf Oil', 'Standard Oil', 'Petronet LNG',
];
const COMMODITY_COMPANY_RE = new RegExp(`\\b(?:${COMMODITY_COMPANY_NAMES.map(escapeRegex).join('|')})`, 'gi');
const CORPORATE_SUFFIX = /^\s+(ltd|limited|inc|corp|corporation|plc|llc)\b/i;
// Capitalised words that sit in front of a commodity without making a company name
// ("Spot Gold slips", "Why Gold is rising", "India Gold demand falls").
const NOT_A_NAME = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'as', 'if', 'while', 'after', 'before', 'for', 'on', 'in', 'with', 'at',
  'why', 'how', 'what', 'when', 'where', 'will', 'is', 'are', 'was', 'can', 'could', 'should', 'did', 'does', 'has',
  'buy', 'sell', 'hold', 'today', 'now', 'this', 'that', 'here', 'more', 'most', 'all',
  'spot', 'comex', 'record', 'physical', 'digital', 'sovereign', 'paper', 'global', 'domestic', 'local',
  'cheap', 'cheaper', 'costly', 'costlier', 'higher', 'lower', 'pure', 'safe', 'haven', 'safe-haven',
  'brent', 'crude', 'shale', 'heavy', 'light', 'sweet', 'white', 'yellow',
  'india', 'indian', 'china', 'chinese', 'russia', 'russian', 'saudi', 'iran', 'iranian', 'iraq', 'iraqi',
  'venezuela', 'venezuelan', 'dubai', 'gulf', 'american', 'european', 'asian', 'london', 'york', 'delhi', 'mumbai',
]);

// True when the commodity word at [s, e) of `text` is part of a company's name: inside a
// known name, followed by "Ltd"/"Inc"…, or — in a sentence-case line, where a capital
// mid-sentence means a proper noun — a Capitalised word right after another one ("Senco Gold
// jumps"). All-caps words in front ("MCX Gold", "RBI Gold reserves") are left alone, and so
// are Title Case Headlines, where every word is capitalised and the capitals say nothing.
function inCompanyName(text, s, e) {
  for (const m of text.matchAll(COMMODITY_COMPANY_RE)) {
    if (m.index < e && s < m.index + m[0].length) return true;
  }
  if (!/^[A-Z][a-z]/.test(text.slice(s, e))) return false;
  const after = text.slice(e);
  if (CORPORATE_SUFFIX.test(after)) return true;
  const before = /([A-Za-z][A-Za-z'’&-]*)\s+$/.exec(text.slice(0, s));
  return !!before && /^[A-Z][a-z]/.test(before[1]) && !NOT_A_NAME.has(before[1].toLowerCase())
    && /^(['’]s)?\s+[a-z]/.test(after);
}

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
    for (const e of c.execs || []) {
      executives.push({
        full_name: e.name,
        ticker: c.ticker,
        role: e.role || null,
        aliases: e.aliases || [],
        as_of: e.asOf || null,
        source: e.source || null,
        ended_on: e.until || null,
      });
    }
  }
  return { companies, executives };
}

/**
 * Pure resolver factory. companies: [{ticker,name,aliases,sector,...}],
 * executives: [{full_name, ticker, aliases?}].
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

  // Commodities are matched on the HEADLINE only. Their aliases are everyday phrases ("oil
  // prices", "gold"), and a passing mention in a summary ("…crude oil prices and the rupee
  // will be key variables") made unrelated macro stories count toward the commodity's
  // sentiment. A story about a commodity names it in the headline — by alias, or by the
  // plain word in COMMODITY_HEADLINE.
  const headlineOnly = new Set(companies.filter((c) => c.asset_class === 'commodity').map((c) => c.ticker));
  const isCommodity = (tks) => [...tks].every((t) => headlineOnly.has(t));
  // The plain commodity word in the headline, outside any company name.
  const headlineNames = (t, title) => !!COMMODITY_HEADLINE[t] && [...title.matchAll(COMMODITY_HEADLINE[t])]
    .some((m) => !inCompanyName(title, m.index, m.index + m[0].length));

  for (const c of companies) {
    sectorByTicker.set(c.ticker, c.sector || null);
    symbolByTicker.set(c.ticker, c.ticker.toUpperCase());
    addAlias(c.name, c.ticker);
    for (const al of c.aliases || []) addAlias(al, c.ticker);
  }

  // Executives: full name (case-insensitive) + short aliases (case-sensitive), both
  // bounded by non-alphanumerics rather than \b so accented names ("Tomé") still match.
  const bounded = (s) => `(?<![A-Za-z0-9])${escapeRegex(s)}(?![A-Za-z0-9])`;
  const execRe = [];
  for (const e of executives) {
    const name = e.full_name.toLowerCase();
    execRe.push({ re: new RegExp(bounded(name)), lower: true, name, ticker: e.ticker });
    for (const al of e.aliases || []) execRe.push({ re: new RegExp(bounded(al)), lower: false, name, ticker: e.ticker });
  }

  // Precompile whole-word regexes for short aliases + symbols.
  const shortAliasRe = [...shortAliases.keys()].map((a) => ({
    re: new RegExp(`\\b${escapeRegex(a)}\\b`, 'gi'),
    tickers: shortAliases.get(a),
  }));
  const symbolRe = [...symbolByTicker.entries()].filter(([, sym]) => !AMBIGUOUS_SYMBOLS.has(sym)).map(([ticker, sym]) => ({
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

  // Companies named in a piece of text (names, aliases, symbols). Pure.
  function companiesIn(original) {
    const lower = original.toLowerCase();
    const tickers = new Set();

    // Company names / long aliases (case-insensitive substring). Every occurrence is
    // recorded first so the longest-match rule can be applied to long and short alike.
    const spans = []; // { s, e, tks } for each long-alias occurrence
    for (const [alias, tks] of longAliases) {
      for (let i = lower.indexOf(alias); i !== -1; i = lower.indexOf(alias, i + 1)) {
        if (isCommodity(tks) && inCompanyName(original, i, i + alias.length)) continue;
        spans.push({ s: i, e: i + alias.length, tks });
      }
    }
    // Shadowed = strictly inside a longer alias that belongs only to other companies.
    const shadowed = (s, e, tks) => spans.some((sp) =>
      sp.s <= s && e <= sp.e && sp.e - sp.s > e - s && ![...tks].some((t) => sp.tks.has(t)));
    for (const sp of spans) {
      if (!shadowed(sp.s, sp.e, sp.tks)) sp.tks.forEach((t) => tickers.add(t));
    }
    // Short aliases (whole-word, case-insensitive).
    for (const { re, tickers: tks } of shortAliasRe) {
      for (const m of lower.matchAll(re)) {
        if (shadowed(m.index, m.index + m[0].length, tks)) continue;
        if (ARM_SUFFIX.test(lower.slice(m.index + m[0].length))) continue;
        if (isCommodity(tks) && inCompanyName(original, m.index, m.index + m[0].length)) continue;
        tks.forEach((t) => tickers.add(t));
        break;
      }
    }
    // Ticker symbols (whole-word, UPPERCASE only — avoids "sol"/"ada" noise).
    for (const { re, ticker } of symbolRe) {
      if (re.test(original)) tickers.add(ticker);
    }
    // Ambiguous common-word names (e.g. "Visa") — only when capitalized in original.
    for (const { re, tickers: tks } of capitalRe) {
      if (re.test(original)) tks.forEach((t) => tickers.add(t));
    }
    return tickers;
  }

  // What a text is ABOUT, not everything it mentions. When the headline names companies,
  // those are the subject, and a name that appears only later in the summary is a passing
  // mention (feed boilerplate such as "...and the latest from Apple") — it is left out. A
  // headline that names no one falls back to the whole summary.
  function resolve(title = '', summary = '', extra = []) {
    const full = matchAll(title, summary, extra);
    const head = matchAll(title, '', extra);
    if (!head.tickers.length) return full;
    // The summary's opening sentence usually restates the subject in full ("Strategy Inc.
    // added 334 bitcoin…"), so a company named there still counts; later sentences do not.
    const opening = String(summary).split(/(?<=[.!?])\s+/)[0].slice(0, 240);
    const lead = companiesIn(opening);
    const tickers = [...new Set([...head.tickers, ...full.tickers.filter((t) => lead.has(t))])];
    return { tickers, executives: head.executives, sectors: full.sectors };
  }

  function matchAll(title = '', summary = '', extra = []) {
    const original = `${title} ${summary}`;
    const lower = original.toLowerCase();
    const tickers = companiesIn(original);
    const executivesHit = new Set();
    const sectors = new Set();

    if ([...tickers].some((t) => headlineOnly.has(t))) {
      const inHeadline = companiesIn(String(title));
      for (const t of [...tickers]) {
        if (!headlineOnly.has(t) || inHeadline.has(t)) continue;
        if (!headlineNames(t, String(title))) tickers.delete(t);
      }
    }
    // Executives → their company (key-person events with no ticker in the headline).
    for (const { re, lower: ci, name, ticker } of execRe) {
      if (re.test(ci ? lower : original)) { tickers.add(ticker); executivesHit.add(name); }
    }
    // Extra holdings outside the curated universe (still get basic matching). Curated
    // tickers are skipped: their rules above already ran, and the loose name match here
    // would undo them (a "Gold" holding matching "Goldman").
    for (const e of extra) {
      const t = typeof e === 'string' ? { ticker: e } : e;
      if (!t.ticker || tickers.has(t.ticker) || symbolByTicker.has(t.ticker)) continue;
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

  // ticker → company name, for wording that must name the company (the per-company prompt).
  const nameByTicker = Object.fromEntries(companies.map((c) => [c.ticker, c.name]));
  return { resolve, sectorByTicker, nameByTicker };
}

// ─── DB-backed singleton (cached index, refreshed periodically) ──────
let _resolver = null;
let _loadedAt = 0;
const TTL_MS = 10 * 60 * 1000;

async function loadIndex(force = false) {
  if (_resolver && !force && Date.now() - _loadedAt < TTL_MS) return _resolver;
  const { query } = require('../db');
  const companies = await query('SELECT ticker, name, aliases, sector, asset_class FROM companies WHERE is_active = true');
  const executives = await query('SELECT full_name, ticker, aliases FROM executives');
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
      `INSERT INTO companies (ticker, name, aliases, sector, asset_class, exchange, country, is_active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, true, now())
       ON CONFLICT (ticker) DO UPDATE SET
         name=EXCLUDED.name, aliases=EXCLUDED.aliases, sector=EXCLUDED.sector,
         asset_class=EXCLUDED.asset_class, exchange=EXCLUDED.exchange, country=EXCLUDED.country,
         is_active=true, updated_at=now()`,
      [c.ticker, c.name, c.aliases, c.sector, c.asset_class, c.exchange, c.country]
    );
  }
  // Tickers dropped from the file (renamed/delisted, e.g. TATAMOTORS, LTIM) stop
  // resolving but keep their row, so older events that reference them still join.
  await execute(
    'UPDATE companies SET is_active = false, updated_at = now() WHERE is_active AND NOT (ticker = ANY($1))',
    [companies.map((c) => c.ticker)]
  );
  for (const e of executives) {
    await execute(
      `INSERT INTO executives (full_name, ticker, role, aliases, as_of, source, ended_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (full_name, ticker) DO UPDATE SET
         role=EXCLUDED.role, aliases=EXCLUDED.aliases, as_of=EXCLUDED.as_of,
         source=EXCLUDED.source, ended_on=EXCLUDED.ended_on`,
      [e.full_name, e.ticker, e.role, e.aliases, e.as_of, e.source, e.ended_on]
    );
  }
  // The table is owned by the file: a name removed there (a wrong entry, not a former
  // exec — those stay with `until`) must not keep resolving from a stale row.
  await execute(
    `DELETE FROM executives e WHERE NOT EXISTS (
       SELECT 1 FROM unnest($1::text[], $2::text[]) AS f(full_name, ticker)
        WHERE f.full_name = e.full_name AND f.ticker = e.ticker)`,
    [executives.map((e) => e.full_name), executives.map((e) => e.ticker)]
  );
  const n = (await query('SELECT count(*) c FROM companies WHERE is_active'))[0].c;
  console.log(`   🏷️  universe seeded: ${n} companies, ${executives.length} executives`);
}

module.exports = { buildResolver, resolve, loadIndex, seedUniverse, universeRows, SECTOR_THEMES, AMBIGUOUS, AMBIGUOUS_SYMBOLS };
