/**
 * Curated company universe (Engine Phase E1).
 *
 * The capped reference: ~US 100 large-caps + Nifty 50 (plus recent leavers) + top
 * crypto + the launch commodities. Each entry feeds entity resolution — matching news
 * to the right ticker, a sector so sector-wide news touches holdings, and key
 * executives so "Jensen Huang" resolves to NVDA even with no ticker in the headline.
 * Holdings OUTSIDE this list still work on basic name/symbol matching; they just don't
 * get sector/exec enrichment. Grow this list over time.
 *
 * Shape: { ticker, name, aliases?: string[], sector, exchange, country, assetClass, execs }
 * `name` is auto-added as an alias; add only EXTRA aliases (short forms, brands).
 * Alias matching (see entityResolver.js): one word = whole-word, several words =
 * substring, both case-insensitive — so never add a one-word alias that is also an
 * ordinary word ("chase", "slack", "target"); use a longer phrase instead.
 *
 * Executives live in executives.json (keyed by ticker) so scripts/refresh_executives.js
 * can re-check them against a source and stamp the date; they are merged in below.
 */

const EXECUTIVES = require('./executives.json');

// ── US (large-cap; ~S&P 100 core) ──
const US = [
  // Technology
  { ticker: 'AAPL', name: 'Apple', aliases: ['apple inc', 'iphone', 'ipad', 'macbook'], sector: 'Technology' },
  { ticker: 'MSFT', name: 'Microsoft', aliases: ['microsoft corp', 'azure', 'xbox'], sector: 'Technology' },
  { ticker: 'NVDA', name: 'Nvidia', aliases: ['nvidia corp', 'geforce'], sector: 'Technology' },
  { ticker: 'AVGO', name: 'Broadcom', aliases: ['vmware'], sector: 'Technology' },
  { ticker: 'ORCL', name: 'Oracle', aliases: ['oracle corp'], sector: 'Technology' },
  { ticker: 'CRM', name: 'Salesforce', aliases: ['agentforce', 'mulesoft'], sector: 'Technology' },
  { ticker: 'ADBE', name: 'Adobe', aliases: ['photoshop'], sector: 'Technology' },
  { ticker: 'AMD', name: 'AMD', aliases: ['advanced micro devices', 'ryzen', 'radeon', 'epyc'], sector: 'Technology' },
  { ticker: 'INTC', name: 'Intel', aliases: ['intel corp'], sector: 'Technology' },
  { ticker: 'QCOM', name: 'Qualcomm', aliases: ['snapdragon'], sector: 'Technology' },
  { ticker: 'CSCO', name: 'Cisco', aliases: ['cisco systems', 'splunk'], sector: 'Technology' },
  { ticker: 'IBM', name: 'IBM', aliases: ['international business machines', 'watsonx', 'red hat'], sector: 'Technology' },
  { ticker: 'TXN', name: 'Texas Instruments', sector: 'Technology' },
  { ticker: 'PLTR', name: 'Palantir', sector: 'Technology' },
  { ticker: 'UBER', name: 'Uber', aliases: ['uber eats'], sector: 'Technology' },
  { ticker: 'NOW', name: 'ServiceNow', sector: 'Technology' },
  { ticker: 'INTU', name: 'Intuit', aliases: ['turbotax', 'quickbooks'], sector: 'Technology' },
  { ticker: 'AMAT', name: 'Applied Materials', sector: 'Technology' },
  { ticker: 'MU', name: 'Micron Technology', aliases: ['micron'], sector: 'Technology' },
  { ticker: 'PANW', name: 'Palo Alto Networks', sector: 'Technology' },
  { ticker: 'CRWD', name: 'CrowdStrike', sector: 'Technology' },
  { ticker: 'DELL', name: 'Dell Technologies', aliases: ['dell'], sector: 'Technology' },
  { ticker: 'ACN', name: 'Accenture', sector: 'Technology' },
  { ticker: 'ANET', name: 'Arista Networks', aliases: ['arista'], sector: 'Technology' },
  // Communication Services
  { ticker: 'GOOGL', name: 'Alphabet', aliases: ['google', 'youtube', 'waymo', 'deepmind'], sector: 'Communication Services' },
  { ticker: 'META', name: 'Meta Platforms', aliases: ['meta', 'facebook', 'instagram', 'whatsapp'], sector: 'Communication Services' },
  { ticker: 'NFLX', name: 'Netflix', sector: 'Communication Services' },
  { ticker: 'DIS', name: 'Disney', aliases: ['walt disney', 'espn'], sector: 'Communication Services' },
  { ticker: 'T', name: 'AT&T', sector: 'Communication Services' },
  { ticker: 'VZ', name: 'Verizon', sector: 'Communication Services' },
  { ticker: 'TMUS', name: 'T-Mobile', sector: 'Communication Services' },
  { ticker: 'CMCSA', name: 'Comcast', aliases: ['nbcuniversal', 'xfinity'], sector: 'Communication Services' },
  // Consumer Discretionary
  { ticker: 'AMZN', name: 'Amazon', aliases: ['aws', 'amazon web services', 'prime video', 'whole foods'], sector: 'Consumer Discretionary' },
  { ticker: 'TSLA', name: 'Tesla', aliases: ['tesla inc', 'cybertruck'], sector: 'Consumer Discretionary' },
  { ticker: 'MCD', name: "McDonald's", aliases: ['mcdonalds'], sector: 'Consumer Discretionary' },
  { ticker: 'NKE', name: 'Nike', sector: 'Consumer Discretionary' },
  { ticker: 'HD', name: 'Home Depot', sector: 'Consumer Discretionary' },
  { ticker: 'SBUX', name: 'Starbucks', sector: 'Consumer Discretionary' },
  { ticker: 'LOW', name: "Lowe's", aliases: ['lowes'], sector: 'Consumer Discretionary' },
  { ticker: 'BKNG', name: 'Booking Holdings', aliases: ['booking.com', 'priceline'], sector: 'Consumer Discretionary' },
  { ticker: 'TJX', name: 'TJX Companies', aliases: ['tj maxx'], sector: 'Consumer Discretionary' },
  { ticker: 'GM', name: 'General Motors', aliases: ['chevrolet'], sector: 'Consumer Discretionary' },
  { ticker: 'F', name: 'Ford Motor', aliases: ['ford'], sector: 'Consumer Discretionary' },
  { ticker: 'ABNB', name: 'Airbnb', sector: 'Consumer Discretionary' },
  { ticker: 'CMG', name: 'Chipotle', sector: 'Consumer Discretionary' },
  // Financials
  { ticker: 'JPM', name: 'JPMorgan Chase', aliases: ['jpmorgan', 'jp morgan', 'chase bank'], sector: 'Financials' },
  { ticker: 'BAC', name: 'Bank of America', aliases: ['bofa', 'merrill lynch'], sector: 'Financials' },
  { ticker: 'WFC', name: 'Wells Fargo', sector: 'Financials' },
  { ticker: 'GS', name: 'Goldman Sachs', aliases: ['goldman'], sector: 'Financials' },
  { ticker: 'MS', name: 'Morgan Stanley', sector: 'Financials' },
  { ticker: 'C', name: 'Citigroup', aliases: ['citi', 'citibank'], sector: 'Financials' },
  { ticker: 'V', name: 'Visa', aliases: ['visa inc'], sector: 'Financials' },
  { ticker: 'MA', name: 'Mastercard', sector: 'Financials' },
  { ticker: 'AXP', name: 'American Express', aliases: ['amex'], sector: 'Financials' },
  { ticker: 'BLK', name: 'BlackRock', aliases: ['ishares'], sector: 'Financials' },
  { ticker: 'BX', name: 'Blackstone', sector: 'Financials' },
  { ticker: 'BRK.B', name: 'Berkshire Hathaway', aliases: ['berkshire', 'geico'], sector: 'Financials' },
  { ticker: 'SCHW', name: 'Charles Schwab', aliases: ['schwab'], sector: 'Financials' },
  { ticker: 'SPGI', name: 'S&P Global', sector: 'Financials' },
  { ticker: 'PYPL', name: 'PayPal', aliases: ['venmo'], sector: 'Financials' },
  { ticker: 'COIN', name: 'Coinbase', sector: 'Financials' },
  { ticker: 'HOOD', name: 'Robinhood', sector: 'Financials' },
  { ticker: 'MSTR', name: 'Strategy Inc', aliases: ['microstrategy'], sector: 'Financials' },
  // Health Care
  { ticker: 'UNH', name: 'UnitedHealth', aliases: ['unitedhealthcare', 'optum'], sector: 'Health Care' },
  { ticker: 'JNJ', name: 'Johnson & Johnson', aliases: ['j&j'], sector: 'Health Care' },
  { ticker: 'LLY', name: 'Eli Lilly', aliases: ['lilly', 'zepbound', 'mounjaro'], sector: 'Health Care' },
  { ticker: 'PFE', name: 'Pfizer', sector: 'Health Care' },
  { ticker: 'MRK', name: 'Merck', aliases: ['keytruda'], sector: 'Health Care' },
  { ticker: 'ABBV', name: 'AbbVie', aliases: ['humira', 'skyrizi'], sector: 'Health Care' },
  { ticker: 'TMO', name: 'Thermo Fisher', sector: 'Health Care' },
  { ticker: 'ABT', name: 'Abbott Laboratories', aliases: ['abbott labs'], sector: 'Health Care' },
  { ticker: 'AMGN', name: 'Amgen', sector: 'Health Care' },
  { ticker: 'GILD', name: 'Gilead Sciences', aliases: ['gilead'], sector: 'Health Care' },
  { ticker: 'ISRG', name: 'Intuitive Surgical', sector: 'Health Care' },
  { ticker: 'CVS', name: 'CVS Health', aliases: ['aetna'], sector: 'Health Care' },
  { ticker: 'DHR', name: 'Danaher', sector: 'Health Care' },
  { ticker: 'BMY', name: 'Bristol Myers Squibb', aliases: ['bristol-myers', 'bristol myers'], sector: 'Health Care' },
  // Consumer Staples
  { ticker: 'WMT', name: 'Walmart', aliases: ["sam's club"], sector: 'Consumer Staples' },
  { ticker: 'PG', name: 'Procter & Gamble', aliases: ['p&g'], sector: 'Consumer Staples' },
  { ticker: 'KO', name: 'Coca-Cola', aliases: ['coca cola'], sector: 'Consumer Staples' },
  { ticker: 'PEP', name: 'PepsiCo', aliases: ['pepsi', 'frito-lay'], sector: 'Consumer Staples' },
  { ticker: 'COST', name: 'Costco', sector: 'Consumer Staples' },
  { ticker: 'PM', name: 'Philip Morris International', aliases: ['philip morris', 'zyn'], sector: 'Consumer Staples' },
  { ticker: 'MDLZ', name: 'Mondelez', aliases: ['oreo'], sector: 'Consumer Staples' },
  { ticker: 'TGT', name: 'Target Corporation', aliases: ['target corp'], sector: 'Consumer Staples' },
  // Energy
  { ticker: 'XOM', name: 'Exxon Mobil', aliases: ['exxon', 'exxonmobil'], sector: 'Energy' },
  { ticker: 'CVX', name: 'Chevron', sector: 'Energy' },
  { ticker: 'COP', name: 'ConocoPhillips', aliases: ['conoco'], sector: 'Energy' },
  // Industrials
  { ticker: 'BA', name: 'Boeing', sector: 'Industrials' },
  { ticker: 'CAT', name: 'Caterpillar', sector: 'Industrials' },
  { ticker: 'GE', name: 'GE Aerospace', aliases: ['general electric'], sector: 'Industrials' },
  { ticker: 'HON', name: 'Honeywell', sector: 'Industrials' },
  { ticker: 'UPS', name: 'United Parcel Service', sector: 'Industrials' },
  { ticker: 'RTX', name: 'RTX Corporation', aliases: ['rtx corp', 'raytheon', 'pratt & whitney'], sector: 'Industrials' },
  { ticker: 'LMT', name: 'Lockheed Martin', aliases: ['lockheed'], sector: 'Industrials' },
  { ticker: 'DE', name: 'Deere & Company', aliases: ['john deere', 'deere'], sector: 'Industrials' },
  { ticker: 'UNP', name: 'Union Pacific', sector: 'Industrials' },
  { ticker: 'FDX', name: 'FedEx', sector: 'Industrials' },
  // Utilities + Materials
  { ticker: 'NEE', name: 'NextEra Energy', aliases: ['nextera'], sector: 'Utilities' },
  { ticker: 'LIN', name: 'Linde', sector: 'Materials' },
];

// ── India (Nifty 50, plus names that left the index since 2024) ──
const IN = [
  { ticker: 'RELIANCE', name: 'Reliance Industries', aliases: ['reliance', 'ril', 'jio'], sector: 'Energy' },
  { ticker: 'TCS', name: 'Tata Consultancy Services', aliases: ['tcs', 'tata consultancy'], sector: 'Information Technology' },
  { ticker: 'INFY', name: 'Infosys', sector: 'Information Technology' },
  { ticker: 'HDFCBANK', name: 'HDFC Bank', aliases: ['hdfc'], sector: 'Financials' },
  { ticker: 'ICICIBANK', name: 'ICICI Bank', aliases: ['icici'], sector: 'Financials' },
  { ticker: 'HINDUNILVR', name: 'Hindustan Unilever', aliases: ['hul'], sector: 'FMCG' },
  { ticker: 'ITC', name: 'ITC', aliases: ['itc limited'], sector: 'FMCG' },
  { ticker: 'SBIN', name: 'State Bank of India', aliases: ['sbi'], sector: 'Financials' },
  { ticker: 'BHARTIARTL', name: 'Bharti Airtel', aliases: ['airtel'], sector: 'Telecom' },
  { ticker: 'KOTAKBANK', name: 'Kotak Mahindra Bank', aliases: ['kotak'], sector: 'Financials' },
  { ticker: 'LT', name: 'Larsen & Toubro', aliases: ['l&t', 'larsen'], sector: 'Industrials' },
  { ticker: 'AXISBANK', name: 'Axis Bank', sector: 'Financials' },
  { ticker: 'BAJFINANCE', name: 'Bajaj Finance', sector: 'Financials' },
  { ticker: 'ASIANPAINT', name: 'Asian Paints', sector: 'Materials' },
  { ticker: 'MARUTI', name: 'Maruti Suzuki', aliases: ['maruti'], sector: 'Automobile' },
  { ticker: 'HCLTECH', name: 'HCL Technologies', aliases: ['hcl tech', 'hcltech'], sector: 'Information Technology' },
  { ticker: 'SUNPHARMA', name: 'Sun Pharmaceutical', aliases: ['sun pharma'], sector: 'Pharmaceuticals' },
  { ticker: 'TITAN', name: 'Titan Company', aliases: ['tanishq'], sector: 'Consumer Discretionary' },
  { ticker: 'ULTRACEMCO', name: 'UltraTech Cement', aliases: ['ultratech'], sector: 'Materials' },
  { ticker: 'WIPRO', name: 'Wipro', sector: 'Information Technology' },
  { ticker: 'NESTLEIND', name: 'Nestle India', aliases: ['maggi'], sector: 'FMCG' },
  { ticker: 'ONGC', name: 'Oil and Natural Gas Corporation', sector: 'Energy' },
  { ticker: 'NTPC', name: 'NTPC', sector: 'Power' },
  { ticker: 'POWERGRID', name: 'Power Grid Corporation', aliases: ['powergrid'], sector: 'Power' },
  { ticker: 'M&M', name: 'Mahindra & Mahindra', aliases: ['mahindra', 'm&m', 'mahindra and mahindra'], sector: 'Automobile' },
  // Tata Motors demerged in Oct 2025: TATAMOTORS no longer trades. TMCV kept the name,
  // so a bare "Tata Motors" resolves to TMCV.
  { ticker: 'TMPV', name: 'Tata Motors Passenger Vehicles', aliases: ['tata motors pv', 'jaguar land rover', 'jlr'], sector: 'Automobile' },
  { ticker: 'TMCV', name: 'Tata Motors', aliases: ['tata motors cv', 'tata motors commercial'], sector: 'Automobile' },
  { ticker: 'TATASTEEL', name: 'Tata Steel', sector: 'Materials' },
  { ticker: 'JSWSTEEL', name: 'JSW Steel', sector: 'Materials' },
  { ticker: 'ADANIENT', name: 'Adani Enterprises', aliases: ['adani', 'adani group'], sector: 'Conglomerate' },
  { ticker: 'ADANIPORTS', name: 'Adani Ports', aliases: ['apsez'], sector: 'Industrials' },
  { ticker: 'COALINDIA', name: 'Coal India', sector: 'Energy' },
  { ticker: 'BAJAJFINSV', name: 'Bajaj Finserv', sector: 'Financials' },
  { ticker: 'HDFCLIFE', name: 'HDFC Life Insurance', aliases: ['hdfc life'], sector: 'Insurance' },
  { ticker: 'SBILIFE', name: 'SBI Life Insurance', aliases: ['sbi life'], sector: 'Insurance' },
  { ticker: 'GRASIM', name: 'Grasim Industries', aliases: ['grasim'], sector: 'Materials' },
  { ticker: 'DRREDDY', name: "Dr. Reddy's Laboratories", aliases: ['dr reddy', "dr reddy's", "dr. reddy's"], sector: 'Pharmaceuticals' },
  { ticker: 'CIPLA', name: 'Cipla', sector: 'Pharmaceuticals' },
  { ticker: 'DIVISLAB', name: "Divi's Laboratories", aliases: ['divis lab'], sector: 'Pharmaceuticals' },
  { ticker: 'BRITANNIA', name: 'Britannia Industries', aliases: ['britannia'], sector: 'FMCG' },
  { ticker: 'EICHERMOT', name: 'Eicher Motors', aliases: ['royal enfield', 'eicher'], sector: 'Automobile' },
  { ticker: 'HEROMOTOCO', name: 'Hero MotoCorp', sector: 'Automobile' },
  { ticker: 'BAJAJ-AUTO', name: 'Bajaj Auto', sector: 'Automobile' },
  { ticker: 'HINDALCO', name: 'Hindalco Industries', aliases: ['hindalco', 'novelis'], sector: 'Materials' },
  { ticker: 'TECHM', name: 'Tech Mahindra', sector: 'Information Technology' },
  { ticker: 'INDUSINDBK', name: 'IndusInd Bank', aliases: ['indusind'], sector: 'Financials' },
  { ticker: 'APOLLOHOSP', name: 'Apollo Hospitals', sector: 'Health Care' },
  { ticker: 'BPCL', name: 'Bharat Petroleum', aliases: ['bpcl'], sector: 'Energy' },
  { ticker: 'TATACONSUM', name: 'Tata Consumer Products', aliases: ['tata consumer'], sector: 'FMCG' },
  { ticker: 'LTM', name: 'LTIMindtree', aliases: ['ltm limited', 'lti mindtree'], sector: 'Information Technology' }, // was LTIM
  { ticker: 'SHRIRAMFIN', name: 'Shriram Finance', sector: 'Financials' },
  { ticker: 'TRENT', name: 'Trent Limited', aliases: ['trent ltd', 'westside', 'zudio'], sector: 'Consumer Discretionary' },
  { ticker: 'BEL', name: 'Bharat Electronics', sector: 'Industrials' },
  { ticker: 'ETERNAL', name: 'Eternal Limited', aliases: ['eternal ltd', 'zomato', 'blinkit'], sector: 'Consumer Discretionary' },
  { ticker: 'JIOFIN', name: 'Jio Financial Services', aliases: ['jio financial'], sector: 'Financials' },
  { ticker: 'INDIGO', name: 'InterGlobe Aviation', aliases: ['indigo'], sector: 'Industrials' },
  { ticker: 'MAXHEALTH', name: 'Max Healthcare', sector: 'Health Care' },
];

// ── Crypto (top ~25) ──
// coingeckoId = the price key (CoinGecko /simple/price); all 25 checked against the API 2026-10-07.
const CRYPTO = [
  { ticker: 'BTC', name: 'Bitcoin', coingeckoId: 'bitcoin' }, { ticker: 'ETH', name: 'Ethereum', aliases: ['ether'], coingeckoId: 'ethereum' },
  { ticker: 'USDT', name: 'Tether', coingeckoId: 'tether' }, { ticker: 'BNB', name: 'BNB', aliases: ['binance coin'], coingeckoId: 'binancecoin' },
  { ticker: 'SOL', name: 'Solana', coingeckoId: 'solana' }, { ticker: 'XRP', name: 'XRP', aliases: ['ripple'], coingeckoId: 'ripple' },
  { ticker: 'USDC', name: 'USD Coin', aliases: ['circle stablecoin'], coingeckoId: 'usd-coin' }, { ticker: 'ADA', name: 'Cardano', coingeckoId: 'cardano' },
  { ticker: 'DOGE', name: 'Dogecoin', coingeckoId: 'dogecoin' }, { ticker: 'AVAX', name: 'Avalanche', coingeckoId: 'avalanche-2' },
  { ticker: 'TRX', name: 'TRON', coingeckoId: 'tron' }, { ticker: 'DOT', name: 'Polkadot', coingeckoId: 'polkadot' },
  { ticker: 'LINK', name: 'Chainlink', coingeckoId: 'chainlink' }, { ticker: 'POL', name: 'Polygon', aliases: ['matic'], coingeckoId: 'polygon-ecosystem-token' },
  { ticker: 'TON', name: 'Toncoin', coingeckoId: 'the-open-network' }, { ticker: 'SHIB', name: 'Shiba Inu', coingeckoId: 'shiba-inu' },
  { ticker: 'LTC', name: 'Litecoin', coingeckoId: 'litecoin' }, { ticker: 'BCH', name: 'Bitcoin Cash', coingeckoId: 'bitcoin-cash' },
  { ticker: 'UNI', name: 'Uniswap', coingeckoId: 'uniswap' }, { ticker: 'XLM', name: 'Stellar Lumens', aliases: ['stellar network'], coingeckoId: 'stellar' },
  { ticker: 'ATOM', name: 'Cosmos', coingeckoId: 'cosmos' }, { ticker: 'ETC', name: 'Ethereum Classic', coingeckoId: 'ethereum-classic' },
  { ticker: 'APT', name: 'Aptos', coingeckoId: 'aptos' }, { ticker: 'ARB', name: 'Arbitrum', coingeckoId: 'arbitrum' },
  { ticker: 'NEAR', name: 'NEAR Protocol', coingeckoId: 'near' },
].map((c) => ({ ...c, sector: 'Crypto', assetClass: 'crypto', exchange: 'CRYPTO', country: 'GLOBAL' }));

// ── Commodities (prices: Yahoo front-month futures, see priceService.COMMODITY_YAHOO) ──
// Brent is read with WTI as one "crude oil". The eleven after natural gas are everyday
// words ("sugar", "copper", "corn"), so the resolver counts them only in a headline that
// talks about the commodity as one — see COMMODITY_CONTEXT in entityResolver.js. Their
// tickers are spelled out: the futures codes (CC, ZS, HG) are also stock symbols.
const COMMODITY = [
  { ticker: 'XAU', name: 'Gold', aliases: ['bullion', 'yellow metal'] },
  { ticker: 'XAG', name: 'Silver' },
  { ticker: 'WTI', name: 'Crude Oil (WTI)', aliases: ['crude oil', 'brent crude', 'oil prices'] },
  { ticker: 'NG', name: 'Natural Gas', aliases: ['natgas'] },
  { ticker: 'COPPER', name: 'Copper' },
  { ticker: 'XPT', name: 'Platinum' },
  { ticker: 'XPD', name: 'Palladium' },
  { ticker: 'ALUMINIUM', name: 'Aluminium', aliases: ['aluminum'] },
  { ticker: 'WHEAT', name: 'Wheat' },
  { ticker: 'CORN', name: 'Corn', aliases: ['maize'] },
  { ticker: 'SOYBEAN', name: 'Soybeans', aliases: ['soybean', 'soyabean'] },
  { ticker: 'SUGAR', name: 'Sugar' },
  { ticker: 'COFFEE', name: 'Coffee' },
  { ticker: 'COTTON', name: 'Cotton' },
  { ticker: 'COCOA', name: 'Cocoa' },
].map((c) => ({ ...c, sector: 'Commodities', assetClass: 'commodity', exchange: 'COMMODITY', country: 'GLOBAL' }));

const UNIVERSE = [
  ...US.map((c) => ({ ...c, assetClass: 'equity', exchange: 'US', country: 'US' })),
  ...IN.map((c) => ({ ...c, assetClass: 'equity', exchange: 'NSE', country: 'IN' })),
  ...CRYPTO,
  ...COMMODITY,
].map((c) => ({ ...c, execs: EXECUTIVES[c.ticker] || [] }));

module.exports = { UNIVERSE };
