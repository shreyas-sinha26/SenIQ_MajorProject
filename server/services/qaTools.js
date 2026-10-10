/**
 * Ask's tools (E6 v2) — what Claude may call to answer a portfolio question.
 *
 * Facts come from exact queries over engine tables (holdings, attribution, events,
 * sentiment, smart money); only search_news does free-text retrieval (newsSearch.js), and
 * get_story_detail expands one of its results.
 *
 * SCOPE IS ENFORCED HERE, not in the prompt: every ticker argument is checked against the
 * user's holdings (ctx.heldSet) before any query runs. A prompt-injected or confused model
 * asking for a stock the user doesn't own gets a not_in_portfolio error, never data.
 * The exceptions are get_stock_snapshot and get_price_history: the price, the sentiment
 * reading and the past year's prices of any company in the reference, held or not, and
 * nothing more (stockSnapshot.js, priceHistory.js). The four tools that read the app's other
 * pages (pageTools.js) take no ticker at all: a fund, a politician, an investor, or the
 * user's own alerts and brief.
 */

const { QA, SENTIMENT } = require('../config');
const { scoreTicker, explainSentiment, labelFor } = require('./sentimentScoring');
const { getImpactFeed } = require('./impactScoring');
const { searchNews, getStory } = require('./newsSearch');
const { listDisclosures, getDisclosure } = require('./disclosures');
const { findCompany, snapshot } = require('./stockSnapshot');
const { priceHistory } = require('./priceHistory');
const pages = require('./pageTools');

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
const clampDays = (d) => Math.max(1, Math.min(QA.NEWS_DAYS_MAX, Number.isFinite(Number(d)) ? Math.round(Number(d)) : QA.NEWS_DAYS_DEFAULT));

// ── Pure helpers ──

/**
 * Today's return attribution: each priced holding's contribution to the portfolio's move,
 * in percentage points = weight% × change% / 100. Weights are shares of the PRICED portfolio,
 * so the total is the priced part's move; unpriced holdings are listed, never guessed. Pure.
 *
 * That weight goes out as `priced_weight_pct`, beside `exposure_pct` — the holding's size as
 * every page shows it. The two differ whenever a holding has no price or no quantity, and an
 * answer that quoted the weight as the size disagreed with the Portfolio page.
 */
function computeAttribution(holdings) {
  const priced = holdings.filter((h) => h.change_pct != null && h.weight_pct != null);
  const contributions = priced
    .map((h) => ({
      ticker: h.ticker,
      asset_class: h.asset_class,
      exposure_pct: h.exposure_pct ?? null,
      priced_weight_pct: h.weight_pct,
      change_pct: h.change_pct,
      contribution_pct: round((h.weight_pct * h.change_pct) / 100, 3),
    }))
    .sort((a, b) => a.contribution_pct - b.contribution_pct); // biggest drag first
  const total = contributions.reduce((s, c) => s + c.contribution_pct, 0);
  // Stated outright so the model reads the comparison instead of working it out: "X caused
  // most of the loss" is wrong whenever gains elsewhere offset part of it.
  const detractors = contributions.filter((c) => c.contribution_pct < 0);
  const contributors = contributions.filter((c) => c.contribution_pct > 0);
  const sum = (rows) => round(rows.reduce((s, c) => s + c.contribution_pct, 0), 3);
  const lift = contributors.length ? contributors[contributors.length - 1] : null;
  return {
    portfolio_change_pct: priced.length ? round(total, 2) : null,
    contributions,
    biggest_drag: detractors.length ? { ticker: detractors[0].ticker, contribution_pct: detractors[0].contribution_pct } : null,
    biggest_lift: lift ? { ticker: lift.ticker, contribution_pct: lift.contribution_pct } : null,
    detractors_total_pct: sum(detractors),
    contributors_total_pct: sum(contributors),
    offsetting: detractors.length > 0 && contributors.length > 0, // losses and gains partly cancel
    unpriced: holdings.filter((h) => !priced.includes(h)).map((h) => h.ticker),
    note: priced.length
      ? 'Equities: change since previous close. Crypto: rolling 24h. Covers priced holdings only. contribution_pct = priced_weight_pct × change_pct / 100; priced_weight_pct is the share among priced holdings and is only for that sum. A holding\'s size in the portfolio is exposure_pct.'
      : 'No live prices available for these holdings, so the move cannot be attributed.',
  };
}

/**
 * Holdings ordered largest first, each with its rank, plus the comparison spelled out —
 * so "largest", "second-largest" and "unpriced" are read from the result, not inferred.
 * `key` is the share used to order them (exposure_pct). Pure.
 */
function rankHoldings(rows, key = 'exposure_pct') {
  const holdings = rows.slice()
    .sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1))
    .map((h, i) => ({ rank: i + 1, ...h }));
  return {
    holdings,
    largest: holdings.length ? { ticker: holdings[0].ticker, [key]: holdings[0][key] } : null,
    order_by_exposure: holdings.map((h) => `${h.rank}. ${h.ticker} ${h[key] ?? '?'}%`).join(', '),
    unpriced: holdings.filter((h) => h.price == null).map((h) => h.ticker),
  };
}

// "4 trades: 3 sell, 1 buy" — the tally a reader would otherwise count by hand. Pure.
function tallyBy(rows, field) {
  const counts = {};
  for (const r of rows) counts[String(r[field] || 'unknown').toLowerCase()] = (counts[String(r[field] || 'unknown').toLowerCase()] || 0) + 1;
  const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
  return `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const { AMBIGUOUS, AMBIGUOUS_SYMBOLS } = require('./entityResolver');

/**
 * Which known tickers/companies does a question mention? `universe` = [{ticker, name, aliases}].
 * Short tickers (≤3 chars) only match as uppercase words or $TICKER, so "all"/"it"/"on" in
 * normal English never trigger; longer tickers and names match case-insensitively. Pure.
 *
 * Two lists are shared with the news resolver so a question is read the way a headline is:
 * symbols that are everyday uppercase text ("F&O", "PM", "Series C") count only as $F / $PM,
 * and names that are ordinary words ("visa", "meta", "cosmos") count only when capitalized.
 */
// Tickers that are also everyday words. Like the short symbols, they count only when
// written as a symbol (UPPERCASE or $-prefixed): "near-term" is not NEAR Protocol and
// "the cost of capital" is not Costco.
const WORD_TICKERS = new Set(['near', 'cost', 'coin', 'hood', 'link', 'atom', 'uber', 'dell', 'doge']);

function findMentionedTickers(text, universe) {
  const q = String(text || '');
  const found = new Set();
  for (const c of universe) {
    const t = c.ticker;
    if (!t || t === '__MARKET__') continue;
    const tickerRe = AMBIGUOUS_SYMBOLS.has(t)
      ? new RegExp(`\\$${escapeRe(t)}(?![A-Za-z0-9&])`)
      : t.length <= 3 || WORD_TICKERS.has(t.toLowerCase()) || (t.length === 4 && AMBIGUOUS.has(t.toLowerCase())) // META: "meta-analysis" is not the stock
      ? new RegExp(`(^|[^A-Za-z0-9])\\$?${escapeRe(t)}(?![A-Za-z0-9])`)
      : new RegExp(`(^|[^A-Za-z0-9])\\$?${escapeRe(t)}(?![A-Za-z0-9])`, 'i');
    let hit = tickerRe.test(q);
    if (!hit) {
      for (const n of [c.name, ...(c.aliases || [])]) {
        if (!n || n.length < 4) continue;
        const lower = n.toLowerCase();
        const re = AMBIGUOUS.has(lower)
          ? new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(lower[0].toUpperCase() + lower.slice(1))}|${escapeRe(lower.toUpperCase())})(?![A-Za-z0-9-])`)
          : new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, 'i');
        if (re.test(q)) { hit = true; break; }
      }
    }
    if (hit) found.add(t);
  }
  return [...found];
}

const PORTFOLIO_WORDS = /\b(my|portfolio|holdings?|i own|i hold)\b/i;

/**
 * Pre-check before any Claude call: a question only about stocks the user doesn't hold is
 * answered with a fixed refusal (no model call, no quota). Mixed or portfolio-level
 * questions go through — the tools still refuse the outside tickers — and so does a question
 * for the Institutions or Congress pages. Pure.
 */
function scopeCheck(question, universe, heldSet) {
  const mentioned = findMentionedTickers(question, universe);
  const outside = mentioned.filter((t) => !heldSet.has(t));
  const inside = mentioned.filter((t) => heldSet.has(t));
  // A fund's filing, a politician's trades or an investor's deals are a page of their own
  // (pageTools.js), whatever company the question names on the way.
  const refuse = outside.length > 0 && inside.length === 0 && !PORTFOLIO_WORDS.test(question) && !pages.isPageQuestion(question);
  return { mentioned, outside, inside, refuse };
}

function outOfScopeAnswer(outside) {
  const list = outside.join(', ');
  const verb = outside.length === 1 ? "isn't" : "aren't";
  return `${list} ${verb} in your portfolio, so SenIQ doesn't track ${outside.length === 1 ? 'it' : 'them'} for you. Add ${outside.length === 1 ? 'it' : 'them'} to your portfolio to get news, sentiment and impact — then ask again.`;
}

// ── Tool definitions (static: part of the cached prompt prefix — keep order stable) ──
const tickerProp = { type: 'string', description: 'A ticker from the user\'s holdings, e.g. "AAPL".' };
const daysProp = { type: 'integer', description: `Look-back window in days (1–${QA.NEWS_DAYS_MAX}, default ${QA.NEWS_DAYS_DEFAULT}).` };

const TOOLS = [
  {
    name: 'get_portfolio_overview',
    description: 'The user\'s holdings: asset class, exposure % (each holding\'s share of the portfolio, the figure the app\'s pages show), live price and day change % (null when unpriced), and current sentiment (label, acute score, z-score vs 90-day baseline, momentum). Start here for most portfolio questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_attribution',
    description: 'Why the portfolio is up or down TODAY: each priced holding\'s contribution in percentage points (its weight among priced holdings × day change), sorted biggest drag first, plus holdings that could not be priced. Use for "why is my portfolio down/up". Pair with get_top_events or get_ticker_news to explain the biggest movers.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_top_events',
    description: 'The ranked portfolio-impact feed: events scored by how much of THIS user\'s portfolio they affect (impact score, exposure %, direction). The first row is today\'s most important event.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'How many events (1–10, default 5).' } } },
  },
  {
    name: 'get_ticker_news',
    description: 'Recent news events for ONE held ticker, newest first, deduplicated into events, with event type, source count and average sentiment. Use for "news on X" / "what happened to X".',
    input_schema: { type: 'object', properties: { ticker: tickerProp, days: daysProp }, required: ['ticker'] },
  },
  {
    name: 'get_sentiment',
    description: 'Sentiment detail for ONE held ticker: acute score/label/confidence, momentum (improving/declining vs prior week), and the z-score vs its own 90-day baseline.',
    input_schema: { type: 'object', properties: { ticker: tickerProp }, required: ['ticker'] },
  },
  {
    name: 'explain_sentiment',
    description: 'WHY a held ticker\'s sentiment is where it is: the stories from the last 72h that produced the acute score and z-score, each with its exact contribution (the contributions add up to the z-score), weight, source and date. Use for "why did sentiment on X jump/drop" or "what is driving X\'s score".',
    input_schema: { type: 'object', properties: { ticker: tickerProp, limit: { type: 'integer', description: 'How many stories (1–8, default 5).' } }, required: ['ticker'] },
  },
  {
    name: 'get_smart_money',
    description: 'Congressional trades and institutional 13F position changes touching the user\'s holdings (or one held ticker); for Indian stocks, NSE bulk/block deals and insider (promoter, director) trades. Disclosures lag the trades — always state the dates.',
    input_schema: { type: 'object', properties: { ticker: { ...tickerProp, description: 'Optional: limit to one held ticker.' } } },
  },
  {
    name: 'get_market_news',
    description: 'Market-wide and macro events (rates, budgets, geopolitics, broad indices) — not tied to one holding. Use for "why is the market down" or macro questions.',
    input_schema: { type: 'object', properties: { days: daysProp } },
  },
  {
    name: 'search_news',
    description: 'Search ingested news for a topic (e.g. "margin pressure", "export ban", "iPhone demand"). Returns STORIES, not single articles: each has an id, title, date span, source count and, where the story affects this portfolio, its impact. Ranked by how well it matches and how much it matters to this user. Restricted to the user\'s holdings and market-wide news. Use when the question is about WHAT was reported rather than scores or rankings.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain words.' },
        ticker: { ...tickerProp, description: 'Optional: restrict to one held ticker.' },
        days: daysProp,
      },
      required: ['query'],
    },
  },
  {
    name: 'get_disclosures',
    description: 'Company filings with the regulator (SEC 8-K "current reports": earnings releases, executive changes, material agreements, impairments) for the user\'s US-listed holdings. PRIMARY SOURCES: what the company itself filed, with the filing date. Use for "what did X file / announce officially", or to check a news story against the filing. Pass `query` to search filing text, or `id` (from an earlier result) for one filing\'s longer excerpt. Not available for Indian stocks, crypto or commodities — the result says which holdings are covered.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { ...tickerProp, description: 'Optional: one held ticker. Default: all US-listed holdings.' },
        query: { type: 'string', description: 'Optional: words to look for in the filing text, e.g. "share repurchase".' },
        days: { type: 'integer', description: 'Look-back in days (1–180, default 180).' },
        id: { type: 'string', description: 'Optional: a filing id from an earlier result (e.g. "d12") to open it.' },
      },
    },
  },
  {
    name: 'get_story_detail',
    description: 'The articles behind ONE story returned by search_news (pass its id, e.g. "e12"): each article\'s title, longer summary, source and date. Use only when a story card is not enough to answer.',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'A story id from search_news results.' } }, required: ['id'] },
  },
  {
    name: 'get_stock_snapshot',
    description: 'Price and sentiment for ONE company the user does NOT hold, by name or ticker: live price, day change %, the latest session\'s high and low, and SenIQ\'s sentiment label and score with the number of stories behind it. This is everything SenIQ can say about a stock outside the portfolio: no news detail, smart money or impact. Use it when a question sets a held stock beside one that is not held. If several companies match the name, the result lists them: ask the user which one. For a held stock use the holding tools instead.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'The company\'s name or ticker as the user wrote it, e.g. "AMD" or "Hero MotoCorp".' } }, required: ['name'] },
  },
  {
    name: 'get_price_history',
    description: 'What ONE price did over the past year, for a holding or any company, coin or commodity in SenIQ\'s reference, by name or ticker: the change over 1 week, 1 month, 3 months, 6 months, 1 year and the calendar year to date (each with the date and close it is measured from), the highest and lowest price traded and the highest and lowest close with their dates and how far the last close is from each, the latest session\'s high and low, average daily volume, the latest daily closes and the month-end closes. Use for "how has X done this year / this month", "what was X\'s high today", "what is X\'s high for the year", "how far is X off its peak". It does not explain why the price moved (use the news tools for a holding).',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'The name or ticker as the user wrote it, e.g. "NVDA", "Bitcoin" or "Hero MotoCorp".' } }, required: ['name'] },
  },
  {
    name: 'get_fund_holdings',
    description: 'The Institutions page: the funds SenIQ tracks from their 13F filings (the ones the user follows first), or, with a fund named, that fund\'s largest positions in its latest filing and how it changed from the quarter before (positions new, added to, reduced). Use for "what does Berkshire hold", "what did Burry buy last quarter", "which funds do you track". For which funds traded ONE of the user\'s holdings use get_smart_money instead.',
    input_schema: { type: 'object', properties: { fund: { type: 'string', description: 'Optional: the fund or its manager as the user wrote it, e.g. "Berkshire Hathaway" or "Michael Burry". Leave out to list the tracked funds.' } } },
  },
  {
    name: 'get_politician_trades',
    description: 'The Congress page: disclosed stock trades by members of the US Congress. With no arguments, the trades in the user\'s holdings and by the politicians they follow. With a politician named, that politician\'s trades in any stock. With scope "all", the newest disclosures across Congress — only when the question asks about Congress as a whole.',
    input_schema: { type: 'object', properties: {
      politician: { type: 'string', description: 'Optional: the politician\'s name as the user wrote it.' },
      scope: { type: 'string', enum: ['mine', 'all'], description: 'Optional: "mine" (default) or "all" for the whole of Congress.' },
    } },
  },
  {
    name: 'get_india_deals',
    description: 'The India side of the Institutions and Congress pages: NSE bulk and block deals, and insider (promoter, director) trades. With no arguments, those in the user\'s Indian holdings and deals by the Indian investors they follow. With an investor named (LIC, SBI Mutual Fund, Rekha Jhunjhunwala…), that investor\'s deals in any stock. With scope "all", the newest deals and insider trades across the market — only when the question asks about the market as a whole.',
    input_schema: { type: 'object', properties: {
      investor: { type: 'string', description: 'Optional: the investor\'s name as the user wrote it.' },
      scope: { type: 'string', enum: ['mine', 'all'], description: 'Optional: "mine" (default) or "all" for the whole market.' },
    } },
  },
  {
    name: 'get_alerts_and_brief',
    description: 'The user\'s own alerts (what SenIQ flagged for them, newest first, with how many are unread) and their latest daily brief (its date, headline and text). Use for "what alerts did I get", "did I miss anything", "what did today\'s brief say", "summarise my brief".',
    input_schema: { type: 'object', properties: { what: { type: 'string', enum: ['alerts', 'brief', 'both'], description: 'Optional: "alerts", "brief" or "both" (default).' } } },
  },
];

// ── Executors ──
class ScopeError extends Error {}

function requireHeld(ctx, raw) {
  const t = String(raw || '').trim().toUpperCase().replace(/^\$/, '');
  if (!t) throw new ScopeError('ticker is required');
  if (!ctx.heldSet.has(t)) throw new ScopeError(`not_in_portfolio: ${t} is not in the user's portfolio, so no data is available for it. Tell the user it isn't tracked and that they can add it to their portfolio.`);
  return t;
}

// The company a typed name or ticker means, for the two tools that read outside the
// portfolio: { company }, or the result to hand back when several match. A holding that is
// not in the reference (a ticker the user typed in) is still theirs to ask about.
async function namedCompany(name, ctx, kind) {
  const typed = String(name || '').trim().slice(0, 40);
  if (!typed) throw new ScopeError('name is required');
  const found = await findCompany(typed);
  if (found.company) return found;
  if (found.matches) return { kind, matches: found.matches, note: 'Several companies match that name. Ask the user which one they mean; do not pick one.' };
  const held = (ctx.holdings || []).find((h) => h.ticker === typed.toUpperCase().replace(/^\$/, ''));
  if (held) return { company: { ticker: held.ticker, name: held.company_name || held.ticker, asset_class: held.asset_class, exchange: held.exchange, tier: 'held' } };
  throw new ScopeError(`not_found: SenIQ's company reference has nothing called "${typed}", so there is nothing to show for it. Say so; do not describe it from memory.`);
}

// A read of one of the app's other pages; its { error } is a refusal the model can read.
async function pageRead(fn, args, ctx) {
  const r = await fn(args || {}, ctx);
  if (r && r.error) throw new ScopeError(r.error);
  return r;
}

const EXECUTORS = {
  async get_portfolio_overview(_args, ctx) {
    const out = [];
    for (const h of ctx.holdings.slice(0, QA.MAX_HOLDINGS)) {
      let s = null;
      try { s = await scoreTicker(h.ticker); } catch { s = null; }
      out.push({
        ticker: h.ticker,
        name: h.company_name || h.ticker,
        asset_class: h.asset_class,
        exposure_pct: h.exposure_pct,
        // No price or no quantity: the share is an estimate (the pages mark it "≈").
        ...(h.market_value == null ? { exposure_estimated: true } : {}),
        price: h.price,
        currency: h.currency,
        day_change_pct: h.change_pct,
        sentiment: s ? { label: s.label, acute: s.acute.score, z: s.baseline.z, momentum: s.momentum.direction, articles_72h: s.acute.count } : null,
      });
    }
    return {
      as_of: new Date().toISOString(),
      ...rankHoldings(out),
      note: 'Holdings are listed largest first; rank 1 is the largest exposure. exposure_pct is the holding\'s share of the portfolio, as the Portfolio page shows it. A holding marked exposure_estimated has no live price or no quantity, so its share is an estimate (it is counted at the average size of the priced holdings); say "about". A holding in "unpriced" has no live price, so its day change is unknown.',
    };
  },

  async get_stock_snapshot({ name } = {}, ctx) {
    const found = await namedCompany(name, ctx, 'stock_snapshot');
    return found.company ? snapshot(found.company, { held: ctx.heldSet.has(found.company.ticker) }) : found;
  },

  async get_price_history({ name } = {}, ctx) {
    const found = await namedCompany(name, ctx, 'price_history');
    return found.company ? priceHistory(found.company, { held: ctx.heldSet.has(found.company.ticker) }) : found;
  },

  get_fund_holdings: (args, ctx) => pageRead(pages.fundHoldings, args, ctx),
  get_politician_trades: (args, ctx) => pageRead(pages.politicianTrades, args, ctx),
  get_india_deals: (args, ctx) => pageRead(pages.indiaDeals, args, ctx),
  get_alerts_and_brief: (args, ctx) => pageRead(pages.alertsAndBrief, args, ctx),

  async get_attribution(_args, ctx) {
    return { as_of: new Date().toISOString(), ...computeAttribution(ctx.holdings) };
  },

  async get_top_events({ limit } = {}, ctx) {
    const n = Math.max(1, Math.min(10, Number(limit) || 5));
    const feed = await getImpactFeed(ctx.userId, n);
    return {
      // Already ordered: rank 1 is the event with the highest impact on this portfolio.
      events: feed.map((e, i) => ({
        rank: i + 1,
        title: e.title, source: e.source, url: e.url, date: day(e.published_at),
        impact_score: round(Number(e.impact_score), 3), exposure_pct: round(Number(e.exposure_pct), 1), direction: e.direction,
      })),
    };
  },

  async get_ticker_news({ ticker, days } = {}, ctx) {
    const t = requireHeld(ctx, ticker);
    const d = clampDays(days);
    const { query } = require('../db');
    const rows = await query(
      `SELECT e.id, e.title, e.url, e.source, e.event_type, e.source_count, e.last_seen,
              avg(s.sentiment_score) AS score
         FROM events e
         JOIN articles a ON a.event_id = e.id
         JOIN article_sentiments s ON s.article_id = a.id
        WHERE s.ticker = $1 AND e.last_seen > now() - ($2 || ' days')::interval
        GROUP BY e.id
        ORDER BY e.last_seen DESC
        LIMIT 10`,
      [t, String(d)]
    );
    return {
      ticker: t, window_days: d,
      events: rows.map((r) => ({
        title: r.title, source: r.source, url: r.url, date: day(r.last_seen), type: r.event_type,
        sources: r.source_count, sentiment: labelFor(Number(r.score)), sentiment_score: round(Number(r.score), 2),
      })),
    };
  },

  async get_sentiment({ ticker } = {}, ctx) {
    const t = requireHeld(ctx, ticker);
    const s = await scoreTicker(t);
    return { ticker: t, ...s };
  },

  async explain_sentiment({ ticker, limit } = {}, ctx) {
    const t = requireHeld(ctx, ticker);
    const n = Math.max(1, Math.min(8, Number(limit) || 5));
    const { query } = require('../db');
    const rows = await query(
      `SELECT a.id, a.event_id, a.title, a.url, a.source, a.platform, a.published_at,
              s.sentiment_score AS score, s.confidence
         FROM article_sentiments s
         JOIN articles a ON a.id = s.article_id
        WHERE s.ticker = $1
          AND a.published_at > now() - ($2 || ' days')::interval`,
      [t, String(SENTIMENT.BASELINE_DAYS)]
    );
    const x = explainSentiment(rows, { limit: n });
    const unit = x.basis === 'baseline' ? 'z-score units (they add up to the z-score)' : 'score points away from neutral 0.5 (too little history for a z-score)';
    return {
      ticker: t,
      window_hours: SENTIMENT.ACUTE_WINDOW_HOURS,
      acute: x.acute,
      baseline: x.baseline,
      contribution_unit: unit,
      note: x.drivers.length ? undefined : 'No scored articles in the acute window, so the score sits at neutral.',
      drivers: x.drivers.map((d) => ({
        title: String(d.title).slice(0, 160), source: d.source, url: d.url, date: day(d.published_at),
        articles: d.articles, sentiment_score: d.sentiment_score, weight_pct: d.weight_pct,
        contribution: d.contribution, direction: d.direction,
      })),
      other_stories: x.rest,
    };
  },

  async get_smart_money({ ticker } = {}, ctx) {
    const tickers = ticker ? [requireHeld(ctx, ticker)] : [...ctx.heldSet];
    const { query } = require('../db');
    const congress = await query(
      `SELECT politician, chamber, party, transaction_type, ticker,
              transaction_date::text AS transaction_date, disclosure_date::text AS disclosure_date
         FROM congress_trades WHERE ticker = ANY($1)
        ORDER BY disclosure_date DESC NULLS LAST, transaction_date DESC NULLS LAST LIMIT 10`,
      [tickers]
    );
    const institutions = await query(
      `SELECT i.name, h.ticker, h.change_type, h.shares, h.value,
              f.period_of_report::text AS period_of_report, f.filed_at::text AS filed_at
         FROM institution_holdings h
         JOIN institution_filings f ON f.id = h.filing_id
         JOIN institutions i ON i.id = f.institution_id
        WHERE h.ticker = ANY($1) AND h.change_type IN ('new','added','reduced')
        ORDER BY f.filed_at DESC NULLS LAST, h.value DESC NULLS LAST LIMIT 10`,
      [tickers]
    );
    const congressRows = congress.map((c) => ({ politician: c.politician, chamber: c.chamber, party: c.party, action: c.transaction_type, ticker: c.ticker, traded: day(c.transaction_date), disclosed: day(c.disclosure_date) }));
    const institutionRows = institutions.map((r) => ({ fund: r.name, ticker: r.ticker, change: r.change_type, shares: Number(r.shares), value_usd: Number(r.value), quarter_end: day(r.period_of_report), filed: day(r.filed_at) }));
    // India: NSE bulk/block deals and insider trades. The keys appear only when there are rows.
    const deals = await query(
      `SELECT deal_type, deal_date::text AS deal_date, ticker, client_name, side, quantity, price, value
         FROM india_deals WHERE ticker = ANY($1)
        ORDER BY deal_date DESC, value DESC LIMIT 10`,
      [tickers]
    );
    const insiders = await query(
      `SELECT ticker, person, category, mode, side, quantity, value, trade_from::text AS trade_from, disclosed_at::text AS disclosed_at
         FROM india_insider_trades WHERE ticker = ANY($1) AND side IN ('buy','sell')
        ORDER BY disclosed_at DESC NULLS LAST, value DESC NULLS LAST LIMIT 10`,
      [tickers]
    );
    const dealRows = deals.map((d) => ({ client: d.client_name, deal: d.deal_type, action: d.side, ticker: d.ticker, shares: Number(d.quantity), price_inr: Number(d.price), value_inr: Number(d.value), traded: d.deal_date }));
    const insiderRows = insiders.map((t) => ({ person: t.person, category: t.category, how: t.mode, action: t.side, ticker: t.ticker, shares: t.quantity == null ? null : Number(t.quantity), value_inr: t.value == null ? null : Number(t.value), traded: t.trade_from, disclosed: t.disclosed_at }));
    const india = dealRows.length || insiderRows.length ? {
      india_note: 'Indian stocks: bulk/block deals are large trades NSE publishes the same day with the client named; insider trades are SEBI disclosures by promoters, directors and key managers, usually within two trading days. India has no congressional-trade disclosures.',
      india_deals: dealRows,
      india_insider_trades_summary: tallyBy(insiderRows, 'action'),
      india_insider_trades: insiderRows,
    } : {};
    return {
      note: 'Disclosures lag the actual trades (13F up to 45 days after quarter end; congress up to 45 days after the trade). Each row\'s "action"/"change" is exactly what was disclosed — repeat it as written. For a fund, shares and value_usd are the SIZE OF ITS POSITION at the quarter end, not the amount it bought or sold; a 13F does not give that amount.',
      congress_summary: tallyBy(congressRows, 'action'),
      congress: congressRows,
      institutions_summary: tallyBy(institutionRows, 'change'),
      institutions: institutionRows,
      ...india,
    };
  },

  async get_market_news({ days } = {}) {
    const d = clampDays(days);
    const { query } = require('../db');
    const rows = await query(
      `SELECT title, url, source, event_type, source_count, last_seen, importance
         FROM events
        WHERE relevance_tier IN ('market','world') AND last_seen > now() - ($1 || ' days')::interval
        ORDER BY importance DESC, last_seen DESC
        LIMIT 10`,
      [String(d)]
    );
    return {
      window_days: d,
      events: rows.map((r) => ({ title: r.title, source: r.source, url: r.url, date: day(r.last_seen), type: r.event_type, sources: r.source_count })),
    };
  },

  async search_news({ query: q, ticker, days } = {}, ctx) {
    if (!q || !String(q).trim()) throw new ScopeError('query is required');
    const tickers = ticker ? [requireHeld(ctx, ticker)] : [...ctx.heldSet, '__MARKET__'];
    const d = clampDays(days ?? QA.NEWS_DAYS_MAX);
    const r = await searchNews({ query: String(q).slice(0, 200), tickers, userId: ctx.userId, includeMarket: !ticker, days: d });
    return { window_days: d, search_mode: r.mode, results: r.results.map((x) => ({ ...x, first_seen: day(x.first_seen), last_seen: day(x.last_seen) })) };
  },

  async get_disclosures({ ticker, query: q, days, id } = {}, ctx) {
    const tickers = ticker ? [requireHeld(ctx, ticker)] : [...ctx.heldSet];
    if (id != null && String(id).trim()) {
      const one = await getDisclosure({ id, tickers: [...ctx.heldSet] });
      if (!one) throw new ScopeError(`filing_not_found: no filing "${String(id).slice(0, 24)}" for this portfolio. Use an id from get_disclosures results.`);
      return { source: 'SEC EDGAR (primary source)', filing: one };
    }
    const r = await listDisclosures({ tickers, query: q ? String(q).slice(0, 200) : '', days });
    const uncovered = tickers.filter((t) => !r.covered.includes(t));
    return {
      source: 'SEC EDGAR 8-K filings (primary source). `filed` is when it became public.',
      filings: r.results,
      covered_holdings: r.covered,
      ...(uncovered.length ? { no_filings_available_for: uncovered, why: 'Filings exist only for US-listed stocks SenIQ has already checked; Indian stocks, crypto and commodities have none here, and a newly added US stock is picked up on the next poll.' } : {}),
    };
  },

  async get_story_detail({ id } = {}, ctx) {
    if (!id || !String(id).trim()) throw new ScopeError('id is required');
    const st = await getStory({ id, tickers: [...ctx.heldSet], userId: ctx.userId });
    if (!st) throw new ScopeError(`story_not_found: no story "${String(id).slice(0, 24)}" is available for this portfolio. Use an id from search_news results.`);
    return {
      ...st, first_seen: day(st.first_seen), last_seen: day(st.last_seen),
      articles: st.articles.map((a) => ({ ...a, published_at: day(a.published_at) })),
    };
  },
};

/**
 * Run one tool call. `executors` is the set available in this mode (v2 adds the strategy
 * tools); a name outside it is refused like any unknown tool. Always resolves to a tool_result block: scope violations and failures
 * come back as is_error results so Claude can explain them instead of the loop crashing.
 */
async function runTool(block, ctx, executors = EXECUTORS) {
  const exec = Object.prototype.hasOwnProperty.call(executors, block.name) ? executors[block.name] : null;
  let content;
  let isError = false;
  try {
    if (!exec) throw new ScopeError(`unknown tool ${block.name}`);
    content = JSON.stringify(await exec(block.input || {}, ctx));
  } catch (err) {
    isError = true;
    content = err instanceof ScopeError ? err.message : 'tool failed — this data is unavailable right now';
    if (!(err instanceof ScopeError)) console.error(`Ask tool ${block.name} failed:`, err.message);
  }
  if (content.length > QA.MAX_TOOL_RESULT_CHARS) content = content.slice(0, QA.MAX_TOOL_RESULT_CHARS) + '…[truncated]';
  return { type: 'tool_result', tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) };
}

module.exports = { TOOLS, EXECUTORS, ScopeError, runTool, computeAttribution, rankHoldings, tallyBy, findMentionedTickers, scopeCheck, outOfScopeAnswer, requireHeld };
