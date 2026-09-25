/**
 * Ask's tools (E6 v2) — what Claude may call to answer a portfolio question.
 *
 * Facts come from exact queries over engine tables (holdings, attribution, events,
 * sentiment, smart money); only search_news does free-text retrieval (newsSearch.js).
 *
 * SCOPE IS ENFORCED HERE, not in the prompt: every ticker argument is checked against the
 * user's holdings (ctx.heldSet) before any query runs. A prompt-injected or confused model
 * asking for a stock the user doesn't own gets a not_in_portfolio error, never data.
 */

const { QA } = require('../config');
const { scoreTicker, labelFor } = require('./sentimentScoring');
const { getImpactFeed } = require('./impactScoring');
const { searchNews } = require('./newsSearch');

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
const clampDays = (d) => Math.max(1, Math.min(QA.NEWS_DAYS_MAX, Number.isFinite(Number(d)) ? Math.round(Number(d)) : QA.NEWS_DAYS_DEFAULT));

// ── Pure helpers ──

/**
 * Today's return attribution: each priced holding's contribution to the portfolio's move,
 * in percentage points = weight% × change% / 100. Weights are shares of the PRICED portfolio,
 * so the total is the priced part's move; unpriced holdings are listed, never guessed. Pure.
 */
function computeAttribution(holdings) {
  const priced = holdings.filter((h) => h.change_pct != null && h.weight_pct != null);
  const contributions = priced
    .map((h) => ({
      ticker: h.ticker,
      asset_class: h.asset_class,
      weight_pct: h.weight_pct,
      change_pct: h.change_pct,
      contribution_pct: round((h.weight_pct * h.change_pct) / 100, 3),
    }))
    .sort((a, b) => a.contribution_pct - b.contribution_pct); // biggest drag first
  const total = contributions.reduce((s, c) => s + c.contribution_pct, 0);
  return {
    portfolio_change_pct: priced.length ? round(total, 2) : null,
    contributions,
    unpriced: holdings.filter((h) => !priced.includes(h)).map((h) => h.ticker),
    note: priced.length
      ? 'Equities: change since previous close. Crypto: rolling 24h. Covers priced holdings only.'
      : 'No live prices available for these holdings, so the move cannot be attributed.',
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which known tickers/companies does a question mention? `universe` = [{ticker, name, aliases}].
 * Short tickers (≤3 chars) only match as uppercase words or $TICKER, so "all"/"it"/"on" in
 * normal English never trigger; longer tickers and names match case-insensitively. Pure.
 */
function findMentionedTickers(text, universe) {
  const q = String(text || '');
  const found = new Set();
  for (const c of universe) {
    const t = c.ticker;
    if (!t || t === '__MARKET__') continue;
    const tickerRe = t.length <= 3
      ? new RegExp(`(^|[^A-Za-z0-9])\\$?${escapeRe(t)}(?![A-Za-z0-9])`)
      : new RegExp(`(^|[^A-Za-z0-9])\\$?${escapeRe(t)}(?![A-Za-z0-9])`, 'i');
    let hit = tickerRe.test(q);
    if (!hit) {
      for (const n of [c.name, ...(c.aliases || [])]) {
        if (n && n.length >= 4 && new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, 'i').test(q)) { hit = true; break; }
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
 * questions go through — the tools still refuse the outside tickers. Pure.
 */
function scopeCheck(question, universe, heldSet) {
  const mentioned = findMentionedTickers(question, universe);
  const outside = mentioned.filter((t) => !heldSet.has(t));
  const inside = mentioned.filter((t) => heldSet.has(t));
  const refuse = outside.length > 0 && inside.length === 0 && !PORTFOLIO_WORDS.test(question);
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
    description: 'The user\'s holdings: asset class, exposure %, weight %, live price and day change % (null when unpriced), and current sentiment (label, acute score, z-score vs 90-day baseline, momentum). Start here for most portfolio questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_attribution',
    description: 'Why the portfolio is up or down TODAY: each priced holding\'s contribution in percentage points (weight × day change), sorted biggest drag first, plus holdings that could not be priced. Use for "why is my portfolio down/up". Pair with get_top_events or get_ticker_news to explain the biggest movers.',
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
    name: 'get_smart_money',
    description: 'Congressional trades and institutional 13F position changes touching the user\'s holdings (or one held ticker). These disclosures lag by weeks — always state the dates.',
    input_schema: { type: 'object', properties: { ticker: { ...tickerProp, description: 'Optional: limit to one held ticker.' } } },
  },
  {
    name: 'get_market_news',
    description: 'Market-wide and macro events (rates, budgets, geopolitics, broad indices) — not tied to one holding. Use for "why is the market down" or macro questions.',
    input_schema: { type: 'object', properties: { days: daysProp } },
  },
  {
    name: 'search_news',
    description: 'Search the text of ingested headlines and summaries for a topic (e.g. "margin pressure", "export ban", "iPhone demand"). Restricted to the user\'s holdings and market-wide news. Use when the question is about WHAT was reported rather than scores or rankings.',
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
];

// ── Executors ──
class ScopeError extends Error {}

function requireHeld(ctx, raw) {
  const t = String(raw || '').trim().toUpperCase().replace(/^\$/, '');
  if (!t) throw new ScopeError('ticker is required');
  if (!ctx.heldSet.has(t)) throw new ScopeError(`not_in_portfolio: ${t} is not in the user's portfolio, so no data is available for it. Tell the user it isn't tracked and that they can add it to their portfolio.`);
  return t;
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
        weight_pct: h.weight_pct,
        price: h.price,
        currency: h.currency,
        day_change_pct: h.change_pct,
        sentiment: s ? { label: s.label, acute: s.acute.score, z: s.baseline.z, momentum: s.momentum.direction, articles_72h: s.acute.count } : null,
      });
    }
    return { as_of: new Date().toISOString(), holdings: out };
  },

  async get_attribution(_args, ctx) {
    return { as_of: new Date().toISOString(), ...computeAttribution(ctx.holdings) };
  },

  async get_top_events({ limit } = {}, ctx) {
    const n = Math.max(1, Math.min(10, Number(limit) || 5));
    const feed = await getImpactFeed(ctx.userId, n);
    return {
      events: feed.map((e) => ({
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

  async get_smart_money({ ticker } = {}, ctx) {
    const tickers = ticker ? [requireHeld(ctx, ticker)] : [...ctx.heldSet];
    const { query } = require('../db');
    const congress = await query(
      `SELECT politician, chamber, party, transaction_type, ticker, transaction_date, disclosure_date
         FROM congress_trades WHERE ticker = ANY($1)
        ORDER BY disclosure_date DESC NULLS LAST, transaction_date DESC NULLS LAST LIMIT 10`,
      [tickers]
    );
    const institutions = await query(
      `SELECT i.name, h.ticker, h.change_type, h.shares, h.value, f.period_of_report, f.filed_at
         FROM institution_holdings h
         JOIN institution_filings f ON f.id = h.filing_id
         JOIN institutions i ON i.id = f.institution_id
        WHERE h.ticker = ANY($1) AND h.change_type IN ('new','added','reduced')
        ORDER BY f.filed_at DESC NULLS LAST, h.value DESC NULLS LAST LIMIT 10`,
      [tickers]
    );
    return {
      note: 'Disclosures lag the actual trades (13F up to 45 days after quarter end; congress up to 45 days after the trade).',
      congress: congress.map((c) => ({ politician: c.politician, chamber: c.chamber, party: c.party, action: c.transaction_type, ticker: c.ticker, traded: day(c.transaction_date), disclosed: day(c.disclosure_date) })),
      institutions: institutions.map((r) => ({ fund: r.name, ticker: r.ticker, change: r.change_type, shares: Number(r.shares), value_usd: Number(r.value), quarter_end: day(r.period_of_report), filed: day(r.filed_at) })),
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
    const r = await searchNews({ query: String(q).slice(0, 200), tickers, includeMarket: !ticker, days: d });
    return { window_days: d, search_mode: r.mode, results: r.results.map((x) => ({ ...x, published_at: day(x.published_at) })) };
  },
};

/**
 * Run one tool call. Always resolves to a tool_result block: scope violations and failures
 * come back as is_error results so Claude can explain them instead of the loop crashing.
 */
async function runTool(block, ctx) {
  const exec = EXECUTORS[block.name];
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

module.exports = { TOOLS, EXECUTORS, runTool, computeAttribution, findMentionedTickers, scopeCheck, outOfScopeAnswer, requireHeld };
