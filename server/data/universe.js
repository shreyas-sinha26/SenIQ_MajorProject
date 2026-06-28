/**
 * Curated company universe (Engine Phase E1).
 *
 * The capped v1 reference: ~US large-caps + Nifty 50 + top crypto. Each entry feeds
 * entity resolution — matching news to the right ticker, a sector so sector-wide news
 * touches holdings, and key executives so "Tim Cook" resolves to AAPL even with no
 * ticker in the headline. Holdings OUTSIDE this list still work on basic name/symbol
 * matching; they just don't get sector/exec enrichment. Grow this list over time.
 *
 * Shape: { ticker, name, aliases?: string[], sector, exchange, country, assetClass, execs?: [{name, role}] }
 * `name` is auto-added as an alias; add only EXTRA aliases (short forms, brands).
 */

// ── US (large-cap; ~S&P 100 core) ──
const US = [
  { ticker: 'AAPL', name: 'Apple', aliases: ['iphone', 'apple inc'], sector: 'Technology', execs: [{ name: 'Tim Cook', role: 'CEO' }] },
  { ticker: 'MSFT', name: 'Microsoft', aliases: ['azure', 'xbox'], sector: 'Technology', execs: [{ name: 'Satya Nadella', role: 'CEO' }] },
  { ticker: 'NVDA', name: 'Nvidia', aliases: ['nvidia corp'], sector: 'Technology', execs: [{ name: 'Jensen Huang', role: 'CEO' }] },
  { ticker: 'GOOGL', name: 'Alphabet', aliases: ['google', 'youtube'], sector: 'Communication Services', execs: [{ name: 'Sundar Pichai', role: 'CEO' }] },
  { ticker: 'AMZN', name: 'Amazon', aliases: ['aws'], sector: 'Consumer Discretionary', execs: [{ name: 'Andy Jassy', role: 'CEO' }] },
  { ticker: 'META', name: 'Meta Platforms', aliases: ['facebook', 'instagram', 'whatsapp'], sector: 'Communication Services', execs: [{ name: 'Mark Zuckerberg', role: 'CEO' }] },
  { ticker: 'TSLA', name: 'Tesla', aliases: ['cybertruck'], sector: 'Consumer Discretionary', execs: [{ name: 'Elon Musk', role: 'CEO' }] },
  { ticker: 'AVGO', name: 'Broadcom', sector: 'Technology', execs: [{ name: 'Hock Tan', role: 'CEO' }] },
  { ticker: 'ORCL', name: 'Oracle', sector: 'Technology' },
  { ticker: 'CRM', name: 'Salesforce', sector: 'Technology', execs: [{ name: 'Marc Benioff', role: 'CEO' }] },
  { ticker: 'ADBE', name: 'Adobe', sector: 'Technology' },
  { ticker: 'AMD', name: 'AMD', aliases: ['advanced micro devices', 'ryzen'], sector: 'Technology', execs: [{ name: 'Lisa Su', role: 'CEO' }] },
  { ticker: 'INTC', name: 'Intel', sector: 'Technology' },
  { ticker: 'QCOM', name: 'Qualcomm', sector: 'Technology' },
  { ticker: 'CSCO', name: 'Cisco', sector: 'Technology' },
  { ticker: 'IBM', name: 'IBM', aliases: ['international business machines'], sector: 'Technology' },
  { ticker: 'TXN', name: 'Texas Instruments', sector: 'Technology' },
  { ticker: 'NFLX', name: 'Netflix', sector: 'Communication Services' },
  { ticker: 'PLTR', name: 'Palantir', sector: 'Technology' },
  { ticker: 'UBER', name: 'Uber', sector: 'Technology', execs: [{ name: 'Dara Khosrowshahi', role: 'CEO' }] },
  { ticker: 'JPM', name: 'JPMorgan Chase', aliases: ['jpmorgan', 'jp morgan', 'chase'], sector: 'Financials', execs: [{ name: 'Jamie Dimon', role: 'CEO' }] },
  { ticker: 'BAC', name: 'Bank of America', aliases: ['bofa'], sector: 'Financials' },
  { ticker: 'WFC', name: 'Wells Fargo', sector: 'Financials' },
  { ticker: 'GS', name: 'Goldman Sachs', aliases: ['goldman'], sector: 'Financials' },
  { ticker: 'MS', name: 'Morgan Stanley', sector: 'Financials' },
  { ticker: 'V', name: 'Visa', aliases: ['visa inc'], sector: 'Financials' },
  { ticker: 'MA', name: 'Mastercard', sector: 'Financials' },
  { ticker: 'AXP', name: 'American Express', aliases: ['amex'], sector: 'Financials' },
  { ticker: 'BLK', name: 'BlackRock', sector: 'Financials' },
  { ticker: 'BRK.B', name: 'Berkshire Hathaway', aliases: ['berkshire'], sector: 'Financials', execs: [{ name: 'Warren Buffett', role: 'CEO' }] },
  { ticker: 'PYPL', name: 'PayPal', aliases: ['venmo'], sector: 'Financials' },
  { ticker: 'COIN', name: 'Coinbase', sector: 'Financials', execs: [{ name: 'Brian Armstrong', role: 'CEO' }] },
  { ticker: 'UNH', name: 'UnitedHealth', sector: 'Health Care' },
  { ticker: 'JNJ', name: 'Johnson & Johnson', sector: 'Health Care' },
  { ticker: 'LLY', name: 'Eli Lilly', sector: 'Health Care' },
  { ticker: 'PFE', name: 'Pfizer', sector: 'Health Care' },
  { ticker: 'MRK', name: 'Merck', sector: 'Health Care' },
  { ticker: 'ABBV', name: 'AbbVie', sector: 'Health Care' },
  { ticker: 'TMO', name: 'Thermo Fisher', sector: 'Health Care' },
  { ticker: 'WMT', name: 'Walmart', sector: 'Consumer Staples' },
  { ticker: 'PG', name: 'Procter & Gamble', sector: 'Consumer Staples' },
  { ticker: 'KO', name: 'Coca-Cola', sector: 'Consumer Staples' },
  { ticker: 'PEP', name: 'PepsiCo', sector: 'Consumer Staples' },
  { ticker: 'COST', name: 'Costco', sector: 'Consumer Staples' },
  { ticker: 'MCD', name: "McDonald's", sector: 'Consumer Discretionary' },
  { ticker: 'NKE', name: 'Nike', sector: 'Consumer Discretionary' },
  { ticker: 'HD', name: 'Home Depot', sector: 'Consumer Discretionary' },
  { ticker: 'SBUX', name: 'Starbucks', sector: 'Consumer Discretionary' },
  { ticker: 'DIS', name: 'Disney', aliases: ['walt disney'], sector: 'Communication Services' },
  { ticker: 'XOM', name: 'Exxon Mobil', aliases: ['exxon'], sector: 'Energy' },
  { ticker: 'CVX', name: 'Chevron', sector: 'Energy' },
  { ticker: 'BA', name: 'Boeing', sector: 'Industrials' },
  { ticker: 'CAT', name: 'Caterpillar', sector: 'Industrials' },
  { ticker: 'GE', name: 'GE Aerospace', aliases: ['general electric'], sector: 'Industrials' },
];

// ── India (Nifty 50) ──
const IN = [
  { ticker: 'RELIANCE', name: 'Reliance Industries', aliases: ['reliance', 'jio'], sector: 'Energy', execs: [{ name: 'Mukesh Ambani', role: 'Chairman' }] },
  { ticker: 'TCS', name: 'Tata Consultancy Services', aliases: ['tcs'], sector: 'Information Technology' },
  { ticker: 'INFY', name: 'Infosys', sector: 'Information Technology', execs: [{ name: 'Narayana Murthy', role: 'Founder' }] },
  { ticker: 'HDFCBANK', name: 'HDFC Bank', aliases: ['hdfc'], sector: 'Financials' },
  { ticker: 'ICICIBANK', name: 'ICICI Bank', aliases: ['icici'], sector: 'Financials' },
  { ticker: 'HINDUNILVR', name: 'Hindustan Unilever', aliases: ['hul'], sector: 'FMCG' },
  { ticker: 'ITC', name: 'ITC', aliases: ['itc limited'], sector: 'FMCG' },
  { ticker: 'SBIN', name: 'State Bank of India', aliases: ['sbi'], sector: 'Financials' },
  { ticker: 'BHARTIARTL', name: 'Bharti Airtel', aliases: ['airtel'], sector: 'Telecom' },
  { ticker: 'KOTAKBANK', name: 'Kotak Mahindra Bank', aliases: ['kotak'], sector: 'Financials' },
  { ticker: 'LT', name: 'Larsen & Toubro', aliases: ['l&t'], sector: 'Industrials' },
  { ticker: 'AXISBANK', name: 'Axis Bank', sector: 'Financials' },
  { ticker: 'BAJFINANCE', name: 'Bajaj Finance', sector: 'Financials' },
  { ticker: 'ASIANPAINT', name: 'Asian Paints', sector: 'Materials' },
  { ticker: 'MARUTI', name: 'Maruti Suzuki', aliases: ['maruti'], sector: 'Automobile' },
  { ticker: 'HCLTECH', name: 'HCL Technologies', aliases: ['hcl tech'], sector: 'Information Technology' },
  { ticker: 'SUNPHARMA', name: 'Sun Pharmaceutical', aliases: ['sun pharma'], sector: 'Pharmaceuticals' },
  { ticker: 'TITAN', name: 'Titan Company', sector: 'Consumer Discretionary' },
  { ticker: 'ULTRACEMCO', name: 'UltraTech Cement', aliases: ['ultratech'], sector: 'Materials' },
  { ticker: 'WIPRO', name: 'Wipro', sector: 'Information Technology' },
  { ticker: 'NESTLEIND', name: 'Nestle India', sector: 'FMCG' },
  { ticker: 'ONGC', name: 'Oil and Natural Gas Corporation', sector: 'Energy' },
  { ticker: 'NTPC', name: 'NTPC', sector: 'Power' },
  { ticker: 'POWERGRID', name: 'Power Grid Corporation', sector: 'Power' },
  { ticker: 'M&M', name: 'Mahindra & Mahindra', aliases: ['mahindra'], sector: 'Automobile' },
  { ticker: 'TATAMOTORS', name: 'Tata Motors', sector: 'Automobile' },
  { ticker: 'TATASTEEL', name: 'Tata Steel', sector: 'Materials' },
  { ticker: 'JSWSTEEL', name: 'JSW Steel', sector: 'Materials' },
  { ticker: 'ADANIENT', name: 'Adani Enterprises', aliases: ['adani'], sector: 'Conglomerate', execs: [{ name: 'Gautam Adani', role: 'Chairman' }] },
  { ticker: 'ADANIPORTS', name: 'Adani Ports', sector: 'Industrials' },
  { ticker: 'COALINDIA', name: 'Coal India', sector: 'Energy' },
  { ticker: 'BAJAJFINSV', name: 'Bajaj Finserv', sector: 'Financials' },
  { ticker: 'HDFCLIFE', name: 'HDFC Life Insurance', sector: 'Insurance' },
  { ticker: 'SBILIFE', name: 'SBI Life Insurance', sector: 'Insurance' },
  { ticker: 'GRASIM', name: 'Grasim Industries', sector: 'Materials' },
  { ticker: 'DRREDDY', name: "Dr. Reddy's Laboratories", aliases: ['dr reddy'], sector: 'Pharmaceuticals' },
  { ticker: 'CIPLA', name: 'Cipla', sector: 'Pharmaceuticals' },
  { ticker: 'DIVISLAB', name: "Divi's Laboratories", aliases: ['divis lab'], sector: 'Pharmaceuticals' },
  { ticker: 'BRITANNIA', name: 'Britannia Industries', sector: 'FMCG' },
  { ticker: 'EICHERMOT', name: 'Eicher Motors', aliases: ['royal enfield'], sector: 'Automobile' },
  { ticker: 'HEROMOTOCO', name: 'Hero MotoCorp', sector: 'Automobile' },
  { ticker: 'BAJAJ-AUTO', name: 'Bajaj Auto', sector: 'Automobile' },
  { ticker: 'HINDALCO', name: 'Hindalco Industries', sector: 'Materials' },
  { ticker: 'TECHM', name: 'Tech Mahindra', sector: 'Information Technology' },
  { ticker: 'INDUSINDBK', name: 'IndusInd Bank', sector: 'Financials' },
  { ticker: 'APOLLOHOSP', name: 'Apollo Hospitals', sector: 'Health Care' },
  { ticker: 'BPCL', name: 'Bharat Petroleum', aliases: ['bpcl'], sector: 'Energy' },
  { ticker: 'TATACONSUM', name: 'Tata Consumer Products', sector: 'FMCG' },
  { ticker: 'LTIM', name: 'LTIMindtree', sector: 'Information Technology' },
  { ticker: 'SHRIRAMFIN', name: 'Shriram Finance', sector: 'Financials' },
];

// ── Crypto (top ~25) ──
const CRYPTO = [
  { ticker: 'BTC', name: 'Bitcoin' }, { ticker: 'ETH', name: 'Ethereum' },
  { ticker: 'USDT', name: 'Tether' }, { ticker: 'BNB', name: 'BNB', aliases: ['binance coin'] },
  { ticker: 'SOL', name: 'Solana' }, { ticker: 'XRP', name: 'XRP', aliases: ['ripple'] },
  { ticker: 'USDC', name: 'USD Coin' }, { ticker: 'ADA', name: 'Cardano' },
  { ticker: 'DOGE', name: 'Dogecoin' }, { ticker: 'AVAX', name: 'Avalanche' },
  { ticker: 'TRX', name: 'TRON' }, { ticker: 'DOT', name: 'Polkadot' },
  { ticker: 'LINK', name: 'Chainlink' }, { ticker: 'POL', name: 'Polygon', aliases: ['matic'] },
  { ticker: 'TON', name: 'Toncoin' }, { ticker: 'SHIB', name: 'Shiba Inu' },
  { ticker: 'LTC', name: 'Litecoin' }, { ticker: 'BCH', name: 'Bitcoin Cash' },
  { ticker: 'UNI', name: 'Uniswap' }, { ticker: 'XLM', name: 'Stellar' },
  { ticker: 'ATOM', name: 'Cosmos' }, { ticker: 'ETC', name: 'Ethereum Classic' },
  { ticker: 'APT', name: 'Aptos' }, { ticker: 'ARB', name: 'Arbitrum' },
  { ticker: 'NEAR', name: 'NEAR Protocol' },
].map((c) => ({ ...c, sector: 'Crypto', assetClass: 'crypto', exchange: 'CRYPTO', country: 'GLOBAL' }));

const UNIVERSE = [
  ...US.map((c) => ({ ...c, assetClass: 'equity', exchange: 'US', country: 'US' })),
  ...IN.map((c) => ({ ...c, assetClass: 'equity', exchange: 'NSE', country: 'IN' })),
  ...CRYPTO,
];

module.exports = { UNIVERSE };
