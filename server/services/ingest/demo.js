/**
 * Offline demo news — the fallback when every live source is unreachable (no keys
 * + no network), so the app stays demonstrable on localhost. Normalized to the
 * Phase 2 article shape with platform 'news'.
 */

const { hashId } = require('./util');

const DEMO_NEWS = [
  { title: 'Nvidia upgraded by Morgan Stanley, AI demand accelerates', summary: 'Morgan Stanley raises Nvidia price target citing unprecedented AI chip demand and data center growth.', source: 'Reuters' },
  { title: 'Tesla misses Q2 delivery estimates, shares fall premarket', summary: 'Tesla delivered fewer vehicles than expected in Q2, raising concerns about demand slowdown.', source: 'Bloomberg' },
  { title: 'Apple beats revenue expectations on strong iPhone sales', summary: 'Apple reported quarterly revenue above analyst expectations driven by iPhone 16 demand.', source: 'CNBC' },
  { title: 'Federal Reserve holds interest rates steady, signals caution', summary: 'The Fed kept rates unchanged citing persistent inflation concerns and economic uncertainty.', source: 'Reuters' },
  { title: 'Microsoft Azure revenue surges 29% on AI workload growth', summary: 'Microsoft cloud division reports strong growth driven by enterprise AI adoption.', source: 'TechCrunch' },
  { title: 'Amazon AWS profits hit record as cloud spending increases', summary: 'Amazon Web Services reported record quarterly profits as businesses increase cloud spending.', source: 'Bloomberg' },
  { title: 'Reliance Jio adds 10 million subscribers in Q3', summary: 'Reliance Jio continues strong subscriber growth in Indian telecom market.', source: 'Economic Times' },
  { title: 'HDFC Bank reports 20% profit growth in quarterly results', summary: 'HDFC Bank beats analyst estimates with strong loan growth and improving asset quality.', source: 'Mint' },
  { title: 'Google faces antitrust ruling, shares drop 3%', summary: 'A federal court ruled against Google in an antitrust case impacting its search dominance.', source: 'WSJ' },
  { title: 'Bitcoin surges past $70,000 on ETF inflows', summary: 'Cryptocurrency markets rally as institutional investors pour money into Bitcoin ETFs.', source: 'CoinDesk' },
  { title: 'Meta launches new AI features across Instagram and WhatsApp', summary: 'Meta integrates generative AI tools into its social media platforms for content creation.', source: 'The Verge' },
  { title: 'Oil prices climb on OPEC supply cut extension', summary: 'Crude oil prices rise as OPEC extends production cuts through next quarter.', source: 'Reuters' },
  { title: 'AMD gains market share from Intel in server processors', summary: 'AMD EPYC processors continue to win enterprise customers from Intel Xeon lineup.', source: 'AnandTech' },
  { title: 'Infosys wins $1.5 billion deal with European bank', summary: 'Infosys secures large digital transformation contract with a major European financial institution.', source: 'Economic Times' },
  { title: 'Netflix subscriber growth beats estimates, stock rallies', summary: 'Netflix added more subscribers than expected, benefiting from password sharing crackdown.', source: 'Variety' },
  { title: 'Adani Group stocks surge on improved credit ratings', summary: 'Adani enterprises see sharp gains after credit agencies upgrade outlook.', source: 'Mint' },
  { title: 'Goldman Sachs predicts recession risk declining', summary: 'Goldman Sachs economists lower US recession probability citing resilient consumer spending.', source: 'Bloomberg' },
  { title: 'NASDAQ hits all-time high driven by tech earnings', summary: 'Technology-heavy NASDAQ index reaches record levels on strong quarterly earnings reports.', source: 'MarketWatch' },
  { title: 'PayPal restructures, cuts 2,500 jobs in cost-saving push', summary: 'PayPal announces significant layoffs as part of strategic restructuring to improve margins.', source: 'CNBC' },
  { title: 'Disney+ streaming losses narrow significantly', summary: 'Disney streaming division moves closer to profitability with improving unit economics.', source: 'Deadline' },
];

function getDemoNews() {
  const now = Date.now();
  return DEMO_NEWS.map((a, i) => ({
    // Stable id keyed on the headline so re-runs DEDUPE (ON CONFLICT) instead of
    // inserting a fresh copy of the same demo article every pipeline pass.
    external_id: hashId('demo', a.title),
    title: a.title,
    summary: a.summary,
    source: a.source,
    url: '', // no real article behind demo data — rendered non-clickable
    image_url: '',
    published_at: new Date(now - i * 15 * 60 * 1000).toISOString(),
    platform: 'news',
  }));
}

module.exports = { getDemoNews };
