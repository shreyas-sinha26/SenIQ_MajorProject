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

function severityFor(type) {
  const { EVENT_TYPES } = require('../config');
  return EVENT_TYPES.SEVERITY[type] ?? EVENT_TYPES.SEVERITY.other;
}

module.exports = { classifyEventType, severityFor };
