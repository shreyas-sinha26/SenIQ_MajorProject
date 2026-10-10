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
 *   - an executive named beside another venture of theirs ("Musk's SpaceX") does not tag
 *     their listed company unless the text names that company too
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
const AMBIGUOUS = new Set(['visa', 'meta', 'reliance', 'avalanche', 'cosmos', 'polygon', 'quant', 'ondo', 'pepe', 'jupiter', 'render', 'aerodrome', 'sui']);
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
// The later commodities are everyday words — a "sugar tax", a "coffee chain", "copper wire".
// They count only when the headline also talks about a commodity as one: its price, its
// futures, its crop or its trade.
const COMMODITY_NEEDS_CONTEXT = new Set(['COPPER', 'XPT', 'XPD', 'ALUMINIUM', 'WHEAT', 'CORN', 'SOYBEAN', 'SUGAR', 'COFFEE', 'COTTON', 'COCOA']);
const COMMODITY_CONTEXT = /\b(prices?|futures|rates?|rall(?:y|ies)|surges?|jumps?|rises?|gains?|falls?|slumps?|slips?|drops?|plunges?|climbs?|output|production|crop|harvest|exports?|imports?|supply|demand|stocks|inventor(?:y|ies)|mcx|ncdex|lme|per (?:tonne|ton|kg|quintal|bushel|pound|ounce))\b/i;
// Coins whose name or symbol is an everyday word, a place or a person — "Jupiter Wagons",
// "Quant Mutual Fund", "Ondo State", "AI HYPE", "Pepe Jeans", "Sui Southern Gas". They count only when the story
// also talks about crypto, or names the coin in a way nothing else is named.
const CRYPTO_NEEDS_CONTEXT = new Set(['HYPE', 'QNT', 'TAO', 'ENA', 'ONDO', 'WLD', 'ICP', 'PEPE', 'JUP', 'ALGO', 'RENDER', 'FIL', 'AERO', 'INJ', 'RAY', 'SUI', 'CAKE']);
const CRYPTO_CONTEXT = /\b(crypto\w*|tokens?|coins?|memecoins?|altcoins?|stablecoins?|blockchains?|defi|web3|on-?chain|dex|staking|airdrops?|mainnet|bitcoin|btc|ethereum|solana|binance|coinbase|hyperliquid|quant network|bittensor|ethena|ondo finance|worldcoin|internet computer|dfinity|algorand|render network|filecoin|aerodrome finance|injective|raydium|sui network|pancakeswap)\b/i;
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

// A commodity word that is describing something else: an object made of it or an award
// ("gold grills", "silver medal"), a figure of speech ("silver lining", "the gold standard"),
// or another product altogether ("palm oil", "olive oil"). Capitals give no clue here —
// these turn up in Title Case Headlines too — so the neighbouring word decides. Kept to
// words that never follow the metal when the story is about its price ("gold rush" and
// "gold chains" are left out: both head stories about gold itself).
const NOT_THE_METAL_AFTER = /^[\s-]+(grills?|grillz|medals?|medall?ists?|cards?|plated|toilet|statues?|troph(?:y|ies)|standard|lining|screen|bullets?|jubilee|spoon|tooth|teeth)\b/i;
const NOT_CRUDE_BEFORE = /\b(olive|palm|edible|cooking|coconut|mustard|sunflower|soybean|soya|vegetable|groundnut|castor|fish|hair|essential|engine|baby|massage|snake)\s+$/i;
function describesSomethingElse(text, s, e) {
  const word = text.slice(s, e).toLowerCase();
  if (word === 'gold' || word === 'silver') return NOT_THE_METAL_AFTER.test(text.slice(e));
  if (/^oil\b/.test(word)) return NOT_CRUDE_BEFORE.test(text.slice(0, s));
  return false;
}

// True when the commodity word at [s, e) of `text` does not mean the commodity: it is part
// of a company's name, or it is describing something else.
const notTheCommodity = (text, s, e) => inCompanyName(text, s, e) || describesSomethingElse(text, s, e);

// An executive who also runs companies SenIQ does not track. A story that names one of those
// ventures and not the executive's listed company is about the venture: "Musk's SpaceX files
// to go public" and "Starlink wins an India licence, Musk says" are not Tesla news, and they
// used to pull Tesla's score down. Keyed by the executive's full name, lower case.
const OTHER_VENTURES = {
  'elon musk': /\b(spacex|starlink|starship|xai|grok|neuralink|boring company|twitter|x corp)\b/i,
};

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

// ─── Holdings outside the curated universe ───────────────────
// A held company with no hand-written entry is matched strictly: nobody has checked its name
// against everyday words, and a loose match here is how "Trent" met "current".
const LISTED = require('../data/listed.json').companies;
const LISTED_BY_TICKER = new Map(LISTED.map((c) => [c.ticker, c]));
// Companies graduated from IPO Watch (the 'ipo' tier of the reference). They are in the
// table, not the file, so loadIndex reads them in; they are matched as strictly as a listed
// company. Nobody has checked a one-word name against ordinary words, so each counts as
// `plain`: only beside a company cue.
let IPO_TIER = new Map();
const NAME_TAIL = /[\s,]+(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|n\.?v|s\.?a|holdings?|group|trust|the)\.?$/i;
// "Orion180 Insurance Group Inc." → "Orion180 Insurance": the name without its corporate tail. Pure.
function coreName(name) {
  let n = String(name || '').trim();
  for (let i = 0; i < 3 && NAME_TAIL.test(n); i++) n = n.replace(NAME_TAIL, '').replace(/[\s,&]+$/, '').trim();
  return n;
}
function setIpoTier(rows) {
  IPO_TIER = new Map((rows || []).map((c) => {
    const core = coreName(c.name);
    return [c.ticker, { ticker: c.ticker, name: c.name, core, country: c.country, plain: !/\s/.test(core) }];
  }));
}
const edge = (s) => `(?<![A-Za-z0-9])${escapeRegex(s)}(?![A-Za-z0-9])`;
// Words that show a capitalised word is being used as a company's name.
const COMPANY_CUE = "(?:['’]s\\b|\\s+(?:Inc|Corp|Corporation|Co|Ltd|Limited|Holdings|Group|shares?|stock|stocks)\\b)";
// Listed names that a headline mostly uses for something else. Each counts only beside a word
// that makes it the company ("BSE shares", "CME Group", "JM Financial Ltd", "shares of
// Jefferies"), and a possessive is not one: the other uses take it too ("BSE's Sensex",
// "MSCI's broadest index", "GIFT City's", "People's Bank of China"). Found by running this
// matcher for every listed name over the stored stories and reading the matches (2026-10-10
// and -11). The cost: a story about one of them that names it bare ("JM Financial among top
// losers") is not tagged.
const LISTED_NEEDS_CUE = new Set([
  // a quarter, an exchange or its index, a word, a place, a person, a fund's name
  'QTWO', 'BSE', 'NDAQ', 'CME', 'MSCI', 'STT', 'ROG', 'ATUL', 'CHCO', 'PPLI', 'XYZ',
  // a broker or a rating agency, named for its view of another company
  'JEF', 'MCO', 'EVR', 'JMFINANCIL', 'CRISIL', 'NUVAMA', 'ANGELONE',
]);
// "stock" is not a cue in front of what a market has ("Nasdaq stock futures", "BSE stock exchange").
const STRICT_CUE = '\\s+(?:Inc|Corp|Corporation|Co|Ltd|Limited|Holdings?|Group|[Ss]hares?|[Ss]tock(?!\\s+(?:[Mm]arkets?|[Ee]xchanges?|[Ff]utures|[Ii]nd(?:ex|ices)|[Pp]icks?|[Ii]deas?)\\b))\\b';

/**
 * Whether a text names a held company that is not in the curated universe. Pure.
 *   symbol — in exchange notation ("NASDAQ: SEZL", "$SEZL") at any length; bare and
 *            UPPERCASE only when long enough not to be a word: 5+ letters for a US listed
 *            stock, 4+ for an Indian one (headlines do write "IRFC", "BHEL"), any length
 *            for a ticker we know nothing about (how it always was).
 *   name   — the name without its corporate tail ("Thor Industries"), as whole words and
 *            with its capitals. A one-word name that is also an ordinary word ("Gap",
 *            "Block") counts only beside a company cue ("Gap Inc", "Gap shares").
 *            A name in LISTED_NEEDS_CUE needs a cue however it is written (name or bare
 *            symbol, one word or several), and the possessive is not one.
 * `holding` = { ticker, name? }: for a listed ticker the name comes from listed.json.
 */
function namesHolding(holding, text) {
  const sym = String(holding.ticker).toUpperCase();
  const listed = LISTED_BY_TICKER.get(sym) || IPO_TIER.get(sym);
  const strict = !!listed && LISTED_NEEDS_CUE.has(sym);
  if (new RegExp(`(?:\\b(?:NYSE|NASDAQ|Nasdaq|NSE|BSE|AMEX)\\s*:\\s*|\\$)${escapeRegex(sym)}(?![A-Za-z0-9])`).test(text)) return true;
  const bare = sym.length >= (!listed ? 1 : listed.country === 'IN' ? 4 : 5);
  // `brand`: an Indian symbol that is the name headlines use, in any capitals ("Paytm").
  if (bare && !strict && new RegExp(edge(sym), listed && listed.brand ? 'i' : '').test(text)) return true;
  const core = listed ? listed.core : String(holding.name || '').trim();
  if (core.length < (listed ? 2 : 4)) return false;
  const open = '(?<![A-Za-z0-9])';
  const close = '(?![A-Za-z0-9])';
  const cued = (forms, cue) => new RegExp(`${open}(${forms})${cue}|\\b(?:[Ss]hares|[Ss]tock) of (${forms})${close}`, 'g');
  let re;
  // Every way the name is written: the name and, where a bare symbol counts, the symbol (a
  // brand also as headlines write it, "Nuvama", "Crisil").
  if (strict) re = cued([...new Set([core, ...(bare ? [sym, ...(listed.brand ? [sym[0] + sym.slice(1).toLowerCase()] : [])] : [])])].map(escapeRegex).join('|'), STRICT_CUE);
  // Several words: as written, capitals included — "Preferred Bank" is the company, "the
  // preferred bank for exporters" is not. A holding we know only by a typed name is looser.
  else if (/\s/.test(core)) re = new RegExp(edge(core), listed ? 'g' : 'gi');
  else if (listed && listed.plain) re = cued(escapeRegex(core), COMPANY_CUE);
  else re = new RegExp(edge(core), 'g');
  // The name inside a longer company's name is that other company: "Bank of India" in
  // "Union Bank of India", "Tata Motors" in "Tata Motors Passenger Vehicles".
  const longer = longerNames(core);
  const lower = text.toLowerCase();
  for (const m of text.matchAll(re)) {
    const inside = longer.some((name) => {
      for (let i = lower.indexOf(name); i !== -1; i = lower.indexOf(name, i + 1)) {
        if (i <= m.index && m.index + m[0].length <= i + name.length + 2) return true;
      }
      return false;
    });
    if (!inside) return true;
  }
  return false;
}

// The Indian listed names, as the `extra` list the resolver takes: with INDIA_LISTED_NEWS on
// the pipeline matches them in the news whether anyone holds them or not.
const indianListed = () => LISTED.filter((c) => c.country === 'IN').map((c) => ({ ticker: c.ticker, name: c.name }));

// Names that are not companies we hold a row for, but contain one's name.
const OTHER_NAMES = ['reserve bank of india', 'export-import bank of india', 'securities and exchange board of india', 'south indian bank'];
let knownNames = null;
const longerCache = new Map();
// Every known name (lower-case) that strictly contains this one.
function longerNames(core) {
  const c = core.toLowerCase();
  if (longerCache.has(c)) return longerCache.get(c);
  if (!knownNames) {
    const { UNIVERSE } = require('../data/universe');
    knownNames = [...new Set([...LISTED.map((x) => x.core), ...UNIVERSE.flatMap((x) => [x.name, ...(x.aliases || [])]), ...OTHER_NAMES].map((n) => String(n).toLowerCase()))];
  }
  const out = knownNames.filter((n) => n.length > c.length && n.includes(c));
  longerCache.set(c, out);
  return out;
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
    .some((m) => !notTheCommodity(title, m.index, m.index + m[0].length));

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

  // Listed-tier names of several words, lower-case → their ticker, less any that a curated
  // company already answers to.
  const LISTED_SPANS = LISTED.filter((c) => /\s/.test(c.core) && !longAliases.has(c.core.toLowerCase()) && !symbolByTicker.has(c.ticker))
    .map((c) => [c.core.toLowerCase(), new Set([c.ticker])]);

  // Companies named in a piece of text (names, aliases, symbols). Pure.
  function companiesIn(original) {
    const lower = original.toLowerCase();
    const tickers = new Set();

    // Company names / long aliases (case-insensitive substring). Every occurrence is
    // recorded first so the longest-match rule can be applied to long and short alike.
    const spans = []; // { s, e, tks } for each long-alias occurrence
    for (const [alias, tks] of longAliases) {
      for (let i = lower.indexOf(alias); i !== -1; i = lower.indexOf(alias, i + 1)) {
        if (isCommodity(tks) && notTheCommodity(original, i, i + alias.length)) continue;
        spans.push({ s: i, e: i + alias.length, tks });
      }
    }
    // A listed company's name is a span too — not to tag it (that needs a holder), but so a
    // curated name inside it is read as the other company: "ITC Hotels" is not ITC, "Adani
    // Power" is not Adani Enterprises.
    for (const [name, tk] of LISTED_SPANS) {
      for (let i = lower.indexOf(name); i !== -1; i = lower.indexOf(name, i + 1)) spans.push({ s: i, e: i + name.length, tks: tk, other: true });
    }
    // Shadowed = strictly inside a longer alias that belongs only to other companies.
    const shadowed = (s, e, tks) => spans.some((sp) =>
      sp.s <= s && e <= sp.e && sp.e - sp.s > e - s && ![...tks].some((t) => sp.tks.has(t)));
    for (const sp of spans) {
      if (!sp.other && !shadowed(sp.s, sp.e, sp.tks)) sp.tks.forEach((t) => tickers.add(t));
    }
    // Short aliases (whole-word, case-insensitive).
    for (const { re, tickers: tks } of shortAliasRe) {
      for (const m of lower.matchAll(re)) {
        if (shadowed(m.index, m.index + m[0].length, tks)) continue;
        if (ARM_SUFFIX.test(lower.slice(m.index + m[0].length))) continue;
        if (isCommodity(tks) && notTheCommodity(original, m.index, m.index + m[0].length)) continue;
        tks.forEach((t) => tickers.add(t));
        break;
      }
    }
    // Ticker symbols (whole-word, UPPERCASE only — avoids "sol"/"ada" noise).
    for (const { re, ticker } of symbolRe) {
      if (tickers.has(ticker)) continue;
      for (const m of original.matchAll(new RegExp(re.source, 'g'))) {
        if (!shadowed(m.index, m.index + m[0].length, new Set([ticker]))) { tickers.add(ticker); break; }
      }
    }
    // Ambiguous common-word names (e.g. "Visa") — only when capitalized in original.
    for (const { re, tickers: tks } of capitalRe) {
      for (const m of original.matchAll(new RegExp(re.source, 'g'))) {
        if (!shadowed(m.index, m.index + m[0].length, tks)) { tks.forEach((t) => tickers.add(t)); break; }
      }
    }
    return tickers;
  }

  // What a text is ABOUT, not everything it mentions. When the headline names companies,
  // those are the subject, and a name that appears only later in the summary is a passing
  // mention (feed boilerplate such as "...and the latest from Apple") — it is left out. A
  // headline that names no one falls back to the whole summary.
  function resolve(title = '', summary = '', extra = []) {
    const full = matchAll(title, summary, extra);
    const head = matchAll(title, '', extra, `${title} ${summary}`);
    if (!head.tickers.length) return full;
    // The summary's opening sentence usually restates the subject in full ("Strategy Inc.
    // added 334 bitcoin…"), so a company named there still counts; later sentences do not.
    const opening = String(summary).split(/(?<=[.!?])\s+/)[0].slice(0, 240);
    const lead = companiesIn(opening);
    const tickers = [...new Set([...head.tickers, ...full.tickers.filter((t) => lead.has(t))])];
    return { tickers, executives: head.executives, sectors: full.sectors };
  }

  // `context`: the text searched for crypto talk — the whole story, even when only the
  // headline is being matched.
  function matchAll(title = '', summary = '', extra = [], context = null) {
    const original = `${title} ${summary}`;
    const lower = original.toLowerCase();
    const tickers = companiesIn(original);
    const executivesHit = new Set();
    const sectors = new Set();

    if ([...tickers].some((t) => headlineOnly.has(t))) {
      const inHeadline = companiesIn(String(title));
      for (const t of [...tickers]) {
        if (!headlineOnly.has(t)) continue;
        if (COMMODITY_NEEDS_CONTEXT.has(t)) { if (!inHeadline.has(t) || !COMMODITY_CONTEXT.test(String(title))) tickers.delete(t); continue; }
        if (inHeadline.has(t)) continue;
        if (!headlineNames(t, String(title))) tickers.delete(t);
      }
    }
    if ([...tickers].some((t) => CRYPTO_NEEDS_CONTEXT.has(t)) && !CRYPTO_CONTEXT.test(context || original)) {
      for (const t of [...tickers]) if (CRYPTO_NEEDS_CONTEXT.has(t)) tickers.delete(t);
    }
    // Executives → their company (key-person events with no ticker in the headline) —
    // unless the text is about another venture of theirs and never names the company.
    for (const { re, lower: ci, name, ticker } of execRe) {
      if (!re.test(ci ? lower : original)) continue;
      if (OTHER_VENTURES[name] && !tickers.has(ticker) && OTHER_VENTURES[name].test(original)) continue;
      tickers.add(ticker);
      executivesHit.add(name);
    }
    // Extra holdings outside the curated universe (still get basic matching). Curated
    // tickers are skipped: their rules above already ran, and the loose name match here
    // would undo them (a "Gold" holding matching "Goldman").
    for (const e of extra) {
      const t = typeof e === 'string' ? { ticker: e } : e;
      if (!t.ticker || tickers.has(t.ticker) || symbolByTicker.has(t.ticker)) continue;
      if (namesHolding(t, original)) tickers.add(t.ticker);
    }
    // Explicit sector themes.
    for (const { re, sector } of sectorThemeRe) {
      if (re.test(lower)) sectors.add(sector);
    }

    return { tickers: [...tickers], executives: [...executivesHit], sectors: [...sectors] };
  }

  // ticker → company name, for wording that must name the company (the per-company prompt).
  const nameByTicker = Object.fromEntries(companies.map((c) => [c.ticker, c.name]));
  // What the text itself calls a company: the longest of its name, aliases and symbol that
  // appears in the text ("Kotak Bank", not "Kotak Mahindra Bank"); its name when none does.
  const formsByTicker = Object.fromEntries(companies.map((c) =>
    [c.ticker, [...new Set([c.name, ...(c.aliases || []), c.ticker].filter(Boolean))].sort((a, b) => b.length - a.length)]));
  function surface(ticker, text) {
    const lower = String(text || '').toLowerCase();
    const hit = (formsByTicker[ticker] || []).find((f) => new RegExp(`(?<![a-z0-9])${escapeRegex(f.toLowerCase())}(?![a-z0-9])`).test(lower));
    if (!hit) return nameByTicker[ticker] || ticker;
    const at = lower.search(new RegExp(`(?<![a-z0-9])${escapeRegex(hit.toLowerCase())}(?![a-z0-9])`));
    return String(text).slice(at, at + hit.length); // as written in the text
  }
  return { resolve, sectorByTicker, nameByTicker, surface };
}

// ─── DB-backed singleton (cached index, refreshed periodically) ──────
let _resolver = null;
let _loadedAt = 0;
const TTL_MS = 10 * 60 * 1000;

async function loadIndex(force = false) {
  if (_resolver && !force && Date.now() - _loadedAt < TTL_MS) return _resolver;
  const { query } = require('../db');
  const companies = await query("SELECT ticker, name, aliases, sector, asset_class FROM companies WHERE is_active = true AND tier = 'curated'");
  const executives = await query('SELECT full_name, ticker, aliases FROM executives');
  setIpoTier(await query("SELECT ticker, name, country FROM companies WHERE is_active = true AND tier = 'ipo'"));
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
      `INSERT INTO companies (ticker, name, aliases, sector, asset_class, exchange, country, is_active, tier, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, true, 'curated', now())
       ON CONFLICT (ticker) DO UPDATE SET
         name=EXCLUDED.name, aliases=EXCLUDED.aliases, sector=EXCLUDED.sector,
         asset_class=EXCLUDED.asset_class, exchange=EXCLUDED.exchange, country=EXCLUDED.country,
         is_active=true, tier='curated', updated_at=now()`,
      [c.ticker, c.name, c.aliases, c.sector, c.asset_class, c.exchange, c.country]
    );
  }
  // Tickers dropped from the file (renamed/delisted, e.g. TATAMOTORS, LTIM) stop
  // resolving but keep their row, so older events that reference them still join.
  await execute(
    "UPDATE companies SET is_active = false, updated_at = now() WHERE is_active AND tier = 'curated' AND NOT (ticker = ANY($1))",
    [companies.map((c) => c.ticker)]
  );
  // The listed tier (listed.json): one statement for the whole file. A curated row is never
  // overwritten — the hand-written entry wins — and a name dropped from the file goes inactive.
  const listed = LISTED.filter((c) => !companies.some((k) => k.ticker === c.ticker));
  await execute(
    `INSERT INTO companies (ticker, name, sector, asset_class, exchange, country, is_active, tier, updated_at)
     SELECT t, n, s, 'equity', e, c, true, 'listed', now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS f(t, n, s, e, c)
     ON CONFLICT (ticker) DO UPDATE SET
       name=EXCLUDED.name, sector=EXCLUDED.sector, exchange=EXCLUDED.exchange, country=EXCLUDED.country,
       is_active=true, tier='listed', updated_at=now()
     WHERE companies.tier IN ('listed', 'ipo')`,   // a graduated IPO that enters the file joins the listed tier
    [listed.map((c) => c.ticker), listed.map((c) => c.name), listed.map((c) => c.sector), listed.map((c) => c.exchange), listed.map((c) => c.country)]
  );
  await execute(
    "UPDATE companies SET is_active = false, updated_at = now() WHERE is_active AND tier = 'listed' AND NOT (ticker = ANY($1))",
    [listed.map((c) => c.ticker)]
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
  const n = (await query("SELECT count(*) FILTER (WHERE tier = 'curated') c, count(*) FILTER (WHERE tier = 'listed') l FROM companies WHERE is_active"))[0];
  console.log(`   🏷️  universe seeded: ${n.c} companies, ${executives.length} executives; ${n.l} more listed`);
}

module.exports = { buildResolver, namesHolding, indianListed, LISTED_NEEDS_CUE, coreName, setIpoTier, resolve, loadIndex, seedUniverse, universeRows, SECTOR_THEMES, AMBIGUOUS, AMBIGUOUS_SYMBOLS, OTHER_VENTURES };
