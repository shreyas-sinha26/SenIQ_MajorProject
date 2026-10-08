/**
 * SenIQ data tools for the key-authenticated transports (/mcp and /v1).
 *
 * These are the SAME read tools the Ask agent uses (services/qaTools.js EXECUTORS) —
 * portfolio, impact feed, news, sentiment and its drivers, smart money — exposed to a user's own agent
 * or script. One catalog (DATA_TOOLS) drives both transports so they can't drift.
 *
 * Scope differs from Ask in one deliberate way. Ask is holdings-only. Here:
 *   - portfolio tools (overview, attribution, top events, smart money / news search
 *     with no ticker) stay on the user's own holdings;
 *   - a tool called WITH a ticker accepts any holding OR any active ticker in the
 *     curated universe — an agent drafting a strategy needs sentiment and news for a
 *     stock before the user owns it.
 * Nothing here writes, and nothing here calls a model.
 */
const { QA } = require('../config');
const { EXECUTORS, ScopeError } = require('./qaTools');

const ticker = (description, required = false) => ({ type: 'string', description, required });
const days = { type: 'integer', description: `Look-back window in days (1–${QA.NEWS_DAYS_MAX}, default ${QA.NEWS_DAYS_DEFAULT}).` };
const ANY_TICKER = 'A ticker the user holds or one in SenIQ\'s tracked universe, e.g. "NVDA", "RELIANCE", "BTC".';

// name → { description, args, rest: {path, ticker in path?} }. `priced` = needs live quotes.
const DATA_TOOLS = [
  {
    name: 'get_portfolio_overview',
    description: 'The user\'s holdings: asset class, exposure %, weight %, live price and day change % (null when unpriced), and current sentiment (label, acute score, z-score vs its 90-day baseline, momentum). Start here for portfolio questions.',
    args: {},
    rest: '/v1/portfolio',
    priced: true,
  },
  {
    name: 'get_attribution',
    description: 'Why the user\'s portfolio is up or down TODAY: each priced holding\'s contribution in percentage points (weight × day change), biggest drag first, plus holdings that could not be priced.',
    args: {},
    rest: '/v1/portfolio/attribution',
    priced: true,
  },
  {
    name: 'get_top_events',
    description: 'The user\'s ranked portfolio-impact feed: news events scored by how much of THEIR portfolio they affect (impact score, exposure %, direction). The first row is today\'s most important event for them.',
    args: { limit: { type: 'integer', description: 'How many events (1–10, default 5).' } },
    rest: '/v1/events',
  },
  {
    name: 'get_ticker_news',
    description: 'Recent news events for ONE ticker, newest first, deduplicated into events, with event type, source count and average sentiment.',
    args: { ticker: ticker(ANY_TICKER, true), days },
    rest: '/v1/tickers/:ticker/news',
  },
  {
    name: 'get_sentiment',
    description: 'Sentiment detail for ONE ticker: acute score/label/confidence (recency- and source-weighted), momentum vs the prior week, and the z-score vs its own 90-day baseline. This is the dashboard\'s score; the strategy factor sentiment_avg is a plain daily mean, so the two can differ.',
    args: { ticker: ticker(ANY_TICKER, true) },
    rest: '/v1/tickers/:ticker/sentiment',
  },
  {
    name: 'explain_sentiment',
    description: 'Why ONE ticker\'s sentiment is where it is: the stories from the last 72h behind the acute score and z-score, each with its exact contribution (contributions add up to the z-score), weight, source and date.',
    args: { ticker: ticker(ANY_TICKER, true), limit: { type: 'integer', description: 'How many stories (1–8, default 5).' } },
    rest: '/v1/tickers/:ticker/sentiment/drivers',
  },
  {
    name: 'get_smart_money',
    description: 'Congressional trades and institutional 13F position changes — for one ticker, or across the user\'s holdings when no ticker is given. For Indian stocks: NSE bulk/block deals and insider (promoter, director) trades. Disclosures lag the trades; always state the dates.',
    args: { ticker: ticker(`Optional. ${ANY_TICKER}`) },
    rest: '/v1/smart-money',
  },
  {
    name: 'get_market_news',
    description: 'Market-wide and macro events (rates, budgets, geopolitics, broad indices) — not tied to one ticker.',
    args: { days },
    rest: '/v1/news/market',
  },
  {
    name: 'search_news',
    description: 'Search ingested news for a topic (e.g. "margin pressure", "export ban"). Returns stories (id, title, date span, source count, portfolio impact where there is one), ranked by match and by how much each matters to the user. Covers one ticker when given, otherwise the user\'s holdings plus market-wide news.',
    args: {
      query: { type: 'string', description: 'What to look for, in plain words.', required: true },
      ticker: ticker(`Optional. ${ANY_TICKER}`),
      days,
    },
    rest: '/v1/news/search',
  },
  {
    name: 'get_disclosures',
    description: 'Company filings with the regulator (SEC 8-K current reports: earnings releases, executive changes, material agreements) — primary sources with their filing dates. For one ticker, or across the user\'s US-listed holdings. Pass query to search filing text, or id to open one filing. US-listed stocks only; filings are fetched for stocks the user holds.',
    args: {
      ticker: ticker(`Optional. ${ANY_TICKER}`),
      query: { type: 'string', description: 'Optional: words to look for in the filing text.' },
      days: { type: 'integer', description: 'Look-back in days (1–180, default 180).' },
      id: { type: 'string', description: 'Optional: a filing id from an earlier result, e.g. "d12".' },
    },
    rest: '/v1/disclosures',
  },
  {
    name: 'get_story_detail',
    description: 'The articles behind one story from search_news: title, longer summary, source and date for each. Pass the ticker you searched with if it is not one of the user\'s holdings.',
    args: {
      id: { type: 'string', description: 'A story id from search_news results, e.g. "e12".', required: true },
      ticker: ticker(`Optional. ${ANY_TICKER}`),
    },
    rest: '/v1/news/stories/:id',
  },
];
const BY_NAME = new Map(DATA_TOOLS.map((t) => [t.name, t]));

// Active universe tickers, cached briefly — the list only changes on a reseed.
let _universe = null;
let _universeAt = 0;
async function universeTickers() {
  if (_universe && Date.now() - _universeAt < 5 * 60 * 1000) return _universe;
  const { query } = require('../db');
  const rows = await query('SELECT ticker FROM companies WHERE is_active');
  _universe = new Set(rows.map((r) => r.ticker));
  _universeAt = Date.now();
  return _universe;
}

const normTicker = (raw) => String(raw || '').trim().toUpperCase().replace(/^\$/, '');

/**
 * Run one data tool for a user. Resolves to
 *   { ok: true, data } | { ok: false, status: 400|404|500, error }
 * — never throws, so both transports can map it straight onto their reply shape.
 */
async function runDataTool(userId, name, rawArgs = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, status: 404, error: `unknown tool ${name}` };
  const args = { ...rawArgs };

  try {
    const { query } = require('../db'); // lazy, like qaTools — keeps the catalog loadable offline
    // Only the two portfolio tools need live quotes; the rest just need the ticker list.
    const holdings = tool.priced
      ? await require('./portfolioService').getWeightedHoldings(userId)
      : await query('SELECT ticker, company_name, asset_class FROM portfolio WHERE user_id = $1', [userId]);
    const heldSet = new Set(holdings.map((h) => h.ticker));

    if (args.ticker != null && String(args.ticker).trim() !== '') {
      const t = normTicker(args.ticker);
      if (!heldSet.has(t) && !(await universeTickers()).has(t)) {
        return { ok: false, status: 404, error: `${t} is not in your portfolio or SenIQ's tracked universe, so there is no data for it. Add it to the portfolio to start tracking it.` };
      }
      heldSet.add(t); // in scope for this one call
      args.ticker = t;
    } else {
      delete args.ticker;
      if (tool.args.ticker && tool.args.ticker.required) return { ok: false, status: 400, error: 'ticker is required' };
    }

    return { ok: true, data: await EXECUTORS[name](args, { userId, holdings, heldSet }) };
  } catch (err) {
    if (err instanceof ScopeError) return { ok: false, status: 400, error: err.message };
    console.error(`data tool ${name} failed:`, err.message);
    return { ok: false, status: 500, error: 'this data is unavailable right now' };
  }
}

module.exports = { DATA_TOOLS, runDataTool };
