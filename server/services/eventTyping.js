/**
 * Event typing (Engine Phase E2).
 *
 * Labels an event by WHAT KIND of development it is — the thing "holdings
 * intelligence" needs (earnings vs lawsuit vs CEO exit vs product launch). The type
 * drives severity in the impact score and routing in the report/alerts.
 *
 * Deterministic, keyword/pattern based (cheap, explainable, runs on every event). The
 * first matching rule in priority order wins, so high-severity types (M&A, legal,
 * disruption) outrank generic ones. Pure function — unit-tested offline.
 *
 * Returns one of: ma | legal | disruption | executive | earnings | guidance |
 *                 rating | insider | product | macro | other
 */

// Ordered by priority (most material / specific first). Matched as lowercase substrings.
const RULES = [
  ['ma', ['acquir', 'merger', ' merges', 'takeover', 'buyout', 'to buy ', 'stake sale', 'open offer', 'amalgamat', 'to acquire']],
  ['legal', ['lawsuit', ' sues', 'sued', ' fine', 'penalty', ' probe', 'investigat', 'antitrust', 'fraud', 'settlement', 'regulator', 'sebi', ' sec ', 'court', 'verdict', ' ban', 'raid', 'tax demand', 'insolvency']],
  ['disruption', ['recall', 'data breach', 'breach', ' hack', 'cyberattack', 'outage', 'shutdown', ' strike', 'fire at', 'explosion', 'accident', ' halt', 'disruption', 'closure', 'contaminat', 'sabotage']],
  ['executive', ['ceo', 'cfo', 'resign', 'steps down', 'step down', 'to retire', 'appoint', 'new chief', 'chairman', 'managing director', ' md ', 'quits', 'exits as', 'leadership change']],
  ['earnings', ['earnings', 'quarterly result', 'q1 result', 'q2 result', 'q3 result', 'q4 result', 'net profit', 'net loss', ' revenue', 'beats estimat', 'misses estimat', ' pat ', 'profit jump', 'profit fall', 'profit rise', 'posts profit', 'posts loss', ' results']],
  ['guidance', ['guidance', 'forecast', 'outlook', 'profit warning', ' warns', 'lowers outlook', 'raises outlook']],
  ['rating', ['upgrade', 'downgrade', 'target price', 'price target', 'cuts target', 'raises target', 'buy rating', 'sell rating', 'overweight', 'underweight', 'initiate coverage', 'buy or sell', 'stocks to buy', 'stock to buy', 'top picks']],
  ['insider', ['insider', 'promoter', 'block deal', 'bulk deal', 'pledge', 'buys stake', 'sells stake', 'raises stake', 'stake buy']],
  ['product', ['launch', 'unveil', 'rolls out', 'roll out', 'introduce', 'new product', 'releases', 'debut']],
];

/**
 * @param {string} title
 * @param {string} [summary]
 * @param {string} [tier] relevance tier — market/world with no specific match → 'macro'
 */
function classifyEventType(title = '', summary = '', tier = 'holding') {
  const text = `${title} ${summary}`.toLowerCase();
  for (const [type, kws] of RULES) {
    if (kws.some((k) => text.includes(k))) return type;
  }
  if (tier === 'market' || tier === 'world') return 'macro';
  return 'other';
}

// ─── Stance: is this a reported event, or talk about one? ────
// The type above says what a story is about; the stance says what kind of writing it is.
// Only an event is news in the sense the impact score means. Returns:
//   'event'      something happened, or was reported to have happened
//   'commentary' opinion, prediction, preview, explainer or a question: someone's view
//   'roundup'    a list or market wrap that names many companies in passing
const ROUNDUP = [
  /\b(stocks?|shares?) to (watch|buy|track)\b/, /\btop (\d+ |stock )?(stocks?|movers|gainers|losers|picks)\b/,
  /\b(top|biggest|which) .*\bmovers\b/, /\bstocks? (in focus|in news)\b/, /\bbuzzing stocks?\b/,
  /\bmarket (live|wrap|today|open(ing)?|clos(e|ing))\b/, /\blive updates?\b/, /\blive:/, /\bstock market today\b/,
  /\bearnings trends? highlights?\b/, /\bfeatured highlights\b/, /\bstock of the day\b/, /\bweek ahead\b/,
  /\bnames \d+ .*\bstocks?\b/, /\b\d+ (\w+ ){0,2}stocks? (to|for|that)\b/,
];
const COMMENTARY = [
  /\?\s*$/, /^(why|what|how|should|will|is|are|can|could|does|do|which|where|when)\b/,
  /\b(prediction|opinion|explained|explainer|analysis|preview|outlook)\b/, /\bhere'?s (why|what|how)\b/,
  /\bwhat to expect\b/, /\bhow to trade\b/, /\bshould you\b/, /\bis it time\b/, /\bhistory says\b/,
  /\b\d+ (triggers?|reasons?|things|factors?|takeaways|lessons?|charts?)\b/,
  /\b(experts?|analysts?)['’]? (view|say|says|believe|expect|weigh)\b/, /\bweighs in\b/,
  /\b(could|might|may|likely to|set to|poised to)\b/, /\bvs\.? .*\bwhich\b/,
  /\bbest (\w+ ){0,2}stocks?\b/, /\bstocks? (investors )?should\b/, /\bhere'?s \d+\b/,
  /\b(summit|conclave|webinar|podcast|interview)\b/,   // talk about markets, not a market event
];
// "Hunter Biden Says…", "Peter Schiff Warns…", "Scott Galloway: …" — a named person's view.
const PERSON_SAYS = /^((?:[A-Z][\w.'’-]+\s+){1,3}?)(says|warns|calls|slams|predicts|believes|thinks|argues|claims|rejects|sees|expects)\b/i;
const PERSON_COLON = /^((?:[A-Z][\w.'’-]+\s+){1,2}[A-Z][\w.'’-]+):\s/;

/**
 * @param {string} title
 * @param {(text:string)=>boolean} [isCompany] true when the text names a tracked company
 *        or its executive — "Tata Motors says it will cut jobs" is the company speaking,
 *        which is an event, not commentary.
 */
function classifyStance(title = '', isCompany = () => false) {
  const t = String(title).trim();
  const lower = t.toLowerCase();
  if (ROUNDUP.some((re) => re.test(lower))) return 'roundup';
  const who = t.match(PERSON_SAYS) || t.match(PERSON_COLON);
  if (who && /^[A-Z]/.test(t) && !isCompany(who[1])) return 'commentary';
  if (COMMENTARY.some((re) => re.test(lower))) return 'commentary';
  return 'event';
}

function severityFor(type) {
  const { EVENT_TYPES } = require('../config');
  return EVENT_TYPES.SEVERITY[type] ?? EVENT_TYPES.SEVERITY.other;
}

module.exports = { classifyEventType, classifyStance, severityFor };
