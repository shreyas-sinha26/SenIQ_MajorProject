/**
 * Ticker Matcher Service
 * Matches news articles to stock tickers using company names, CEO names, and aliases.
 */

const { NON_EQUITY_ALIASES } = require('./assetRegistry');

const TICKER_ALIASES = {
  'AAPL': ['apple', 'iphone', 'tim cook', 'apple inc'],
  'TSLA': ['tesla', 'elon musk', 'cybertruck', 'model 3', 'tesla motors'],
  'NVDA': ['nvidia', 'jensen huang', 'cuda', 'gpu', 'nvidia corp'],
  'MSFT': ['microsoft', 'azure', 'satya nadella', 'xbox', 'github'],
  'GOOGL': ['google', 'alphabet', 'sundar pichai', 'youtube', 'android'],
  'AMZN': ['amazon', 'jeff bezos', 'andy jassy', 'aws', 'prime'],
  'META': ['meta', 'facebook', 'instagram', 'whatsapp', 'mark zuckerberg'],
  'NFLX': ['netflix', 'reed hastings'],
  'AMD': ['amd', 'advanced micro devices', 'lisa su', 'ryzen'],
  'INTC': ['intel', 'pat gelsinger'],
  'CRM': ['salesforce', 'marc benioff'],
  'PYPL': ['paypal', 'venmo'],
  'JPM': ['jpmorgan', 'jp morgan', 'jamie dimon', 'chase'],
  'GS': ['goldman sachs', 'goldman'],
  'MS': ['morgan stanley'],
  'V': ['visa inc'],
  'BAC': ['bank of america', 'bofa'],
  'WMT': ['walmart'],
  'DIS': ['disney', 'walt disney'],
  'COIN': ['coinbase'],
  'RELIANCE': ['reliance', 'reliance industries', 'mukesh ambani', 'jio'],
  'HDFCBANK': ['hdfc bank', 'hdfc'],
  'TCS': ['tcs', 'tata consultancy'],
  'INFY': ['infosys', 'narayana murthy'],
  'WIPRO': ['wipro'],
  'ICICIBANK': ['icici bank', 'icici'],
  'SBIN': ['state bank of india', 'sbi'],
  'BHARTIARTL': ['bharti airtel', 'airtel'],
  'ITC': ['itc limited'],
  'TATAMOTORS': ['tata motors'],
  'ADANIENT': ['adani enterprises', 'adani', 'gautam adani'],
  '__MARKET__': ['fed', 'federal reserve', 'interest rate', 'rate hike', 'rate cut',
                  'inflation', 'gdp', 'recession', 'nasdaq', 's&p 500', 'dow jones',
                  'sensex', 'nifty', 'rbi', 'treasury', 'bond yield', 'economy',
                  'market crash', 'wall street']
};

// Non-equity assets (crypto/commodities) bring their own aliases from the registry.
Object.assign(TICKER_ALIASES, NON_EQUITY_ALIASES);

const ALIAS_TO_TICKERS = {};
for (const [ticker, aliases] of Object.entries(TICKER_ALIASES)) {
  for (const alias of aliases) {
    if (!ALIAS_TO_TICKERS[alias]) ALIAS_TO_TICKERS[alias] = [];
    ALIAS_TO_TICKERS[alias].push(ticker);
  }
  const tickerLower = ticker.toLowerCase();
  if (!ALIAS_TO_TICKERS[tickerLower]) ALIAS_TO_TICKERS[tickerLower] = [];
  ALIAS_TO_TICKERS[tickerLower].push(ticker);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchTickers(title, content = '') {
  const text = `${title} ${content}`.toLowerCase();
  const matchedTickers = new Set();
  for (const [alias, tickers] of Object.entries(ALIAS_TO_TICKERS)) {
    if (alias.length <= 3) {
      const regex = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
      if (regex.test(text)) tickers.forEach(t => matchedTickers.add(t));
    } else {
      if (text.includes(alias)) tickers.forEach(t => matchedTickers.add(t));
    }
  }
  return Array.from(matchedTickers);
}

function findAffectedUsers(tickers, userPortfolios) {
  const userMap = {};
  const isMarketNews = tickers.includes('__MARKET__');
  for (const { user_id, ticker: userTicker } of userPortfolios) {
    if (!userMap[user_id]) userMap[user_id] = [];
    if (isMarketNews && !userMap[user_id].includes('__MARKET__')) userMap[user_id].push('__MARKET__');
    if (tickers.includes(userTicker)) userMap[user_id].push(userTicker);
  }
  for (const userId of Object.keys(userMap)) {
    if (userMap[userId].length === 0) delete userMap[userId];
  }
  return userMap;
}

function getCompanyName(ticker) {
  const aliases = TICKER_ALIASES[ticker.toUpperCase()];
  if (aliases && aliases.length > 0) {
    return aliases[0].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  return ticker;
}

function getSupportedTickers() {
  return Object.keys(TICKER_ALIASES).filter(t => t !== '__MARKET__');
}

module.exports = { matchTickers, findAffectedUsers, getSupportedTickers, getCompanyName, TICKER_ALIASES };
