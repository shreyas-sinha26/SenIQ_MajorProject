/**
 * Curated investors a user can follow on the Indian Institutions tab.
 *
 * NSE's bulk/block deal files carry the client's name as free text ("GOVERNMENT OF
 * SINGAPORE", "SBI MUTUAL FUND A/C SBI SMALL CAP FUND"), with no stable id. A deal belongs
 * to an investor when its cleaned name (lowercase, punctuation → spaces) CONTAINS one of
 * the investor's `match` phrases. Keep phrases long enough to be unambiguous — "sbi" alone
 * would also catch SBI Life and SBI Capital; a deal by an unlisted variant of a name is
 * simply not attributed.
 *
 * kind: domestic (Indian institution) | foreign (foreign portfolio investor) | individual.
 */

const INDIA_INVESTORS = [
  { slug: 'lic', name: 'LIC', kind: 'domestic', match: ['life insurance corporation of india'] },
  { slug: 'sbi-mf', name: 'SBI Mutual Fund', kind: 'domestic', match: ['sbi mutual fund'] },
  { slug: 'hdfc-mf', name: 'HDFC Mutual Fund', kind: 'domestic', match: ['hdfc mutual fund'] },
  { slug: 'icici-pru-mf', name: 'ICICI Prudential Mutual Fund', kind: 'domestic', match: ['icici prudential mutual fund'] },
  { slug: 'nippon-mf', name: 'Nippon India Mutual Fund', kind: 'domestic', match: ['nippon india mutual fund', 'nippon life india'] },
  { slug: 'gic-singapore', name: 'GIC (Government of Singapore)', kind: 'foreign', match: ['government of singapore'] },
  { slug: 'vanguard', name: 'Vanguard', kind: 'foreign', match: ['vanguard'] },
  { slug: 'blackrock', name: 'BlackRock', kind: 'foreign', match: ['blackrock', 'ishares'] },
  { slug: 'goldman-sachs', name: 'Goldman Sachs', kind: 'foreign', match: ['goldman sachs'] },
  { slug: 'morgan-stanley', name: 'Morgan Stanley', kind: 'foreign', match: ['morgan stanley'] },
  { slug: 'societe-generale', name: 'Societe Generale', kind: 'foreign', match: ['societe generale'] },
  { slug: 'rekha-jhunjhunwala', name: 'Rekha Jhunjhunwala', kind: 'individual', match: ['rekha jhunjhunwala', 'rekha rakesh jhunjhunwala'] },
  { slug: 'radhakishan-damani', name: 'Radhakishan Damani', kind: 'individual', match: ['radhakishan damani', 'radhakishan s damani', 'radhakishan shivkishan damani'] },
  { slug: 'ashish-kacholia', name: 'Ashish Kacholia', kind: 'individual', match: ['ashish kacholia', 'ashish rameshchandra kacholia'] },
  { slug: 'vijay-kedia', name: 'Vijay Kedia', kind: 'individual', match: ['vijay kedia', 'vijay kishanlal kedia', 'kedia securities'] },
  { slug: 'dolly-khanna', name: 'Dolly Khanna', kind: 'individual', match: ['dolly khanna'] },
];

const INVESTOR_BY_SLUG = Object.fromEntries(INDIA_INVESTORS.map((i) => [i.slug, i]));

// "GOVERNMENT OF SINGAPORE - E" → "government of singapore e". Pure.
const cleanName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The curated investor a client name belongs to, or null. Pure.
function matchInvestor(clientName) {
  const name = ` ${cleanName(clientName)} `;
  for (const inv of INDIA_INVESTORS) {
    if (inv.match.some((m) => name.includes(` ${m} `))) return inv;
  }
  return null;
}

module.exports = { INDIA_INVESTORS, INVESTOR_BY_SLUG, matchInvestor, cleanName };
