/**
 * A stock the user does not hold, as Ask may describe it: its price and SenIQ's sentiment
 * reading, and nothing else.
 *
 * News detail, smart money and portfolio impact stay with holdings. The snapshot is what
 * the pages already show anyone who looks the company up, so it is the one thing Ask can
 * say about a name outside the portfolio:
 *   - a question ONLY about curated names the user does not hold used to get a fixed
 *     refusal; it now gets the snapshot, written by code (no model call, no question used),
 *     with what the price did over the past year when the question asks about the past, and
 *     a line that SenIQ does not advise when the question asks what to do;
 *   - a question that mixes a held and a non-held stock reaches the model, which reads the
 *     same snapshot through the get_stock_snapshot tool (qaTools.js).
 *
 * The number of stories behind a reading is always given, and with no stories there is no
 * reading: "neutral" would be a claim the data does not make.
 */

const { QA, SENTIMENT } = require('../config');

const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);

// ── Pure ──

/**
 * Which company a typed name or ticker means, out of the reference rows a search returned
 * (best first). An exact ticker, then an exact name or alias, then a lone match; several
 * loose matches are handed back for the user to choose from. Pure.
 * → { company } | { matches: [...] } | { none: true }
 */
function pickCompany(typed, rows) {
  const q = String(typed || '').trim().replace(/^\$/, '').toLowerCase();
  if (!q || !rows || !rows.length) return { none: true };
  const one = (list) => (list.length === 1 ? { company: list[0] } : null);
  const names = (r) => [r.name, ...(r.aliases || [])].filter(Boolean).map((n) => String(n).toLowerCase());
  return one(rows.filter((r) => String(r.ticker).toLowerCase() === q))
    || one(rows.filter((r) => names(r).includes(q)))
    || one(rows)
    || { matches: rows.slice(0, QA.SNAPSHOT_MATCHES).map((r) => ({ ticker: r.ticker, name: r.name, exchange: r.exchange || null })) };
}

/**
 * The snapshot of one company from its quote and its sentiment (scoreTicker's result). Pure.
 * `company` = a row of the reference: { ticker, name, asset_class, exchange, tier }.
 */
function buildSnapshot(company, quote, sentiment, { held = false, now = new Date() } = {}) {
  const stories = sentiment && sentiment.acute ? Number(sentiment.acute.count) || 0 : 0;
  const z = sentiment && sentiment.baseline ? sentiment.baseline.z : null;
  // The news is read for the curated names and for anything someone holds; a listed name
  // nobody holds has no stories because nobody looked, not because there were none.
  const tracked = company.tier === 'curated' || held || (sentiment && sentiment.baseline && sentiment.baseline.points > 0);
  const out = {
    kind: 'stock_snapshot',
    ticker: company.ticker,
    name: company.name || company.ticker,
    asset_class: company.asset_class || null,
    exchange: company.exchange || null,
    held,
    as_of: now.toISOString(),
    price: quote && quote.price != null ? round(quote.price, quote.price < 1 ? 6 : 2) : null,
    currency: quote ? quote.currency || null : null,
    day_change_pct: quote && quote.changePct != null ? round(quote.changePct) : null,
  };
  if (out.price == null) out.price_note = 'no live price available right now';
  if (stories > 0) {
    out.sentiment = {
      label: sentiment.label,
      score: sentiment.acute.score,          // 0 to 1; 0.5 is neutral
      stories,
      window_hours: SENTIMENT.ACUTE_WINDOW_HOURS,
      ...(z != null ? { z_vs_90d: z } : { z_note: 'too little history for a z-score' }),
    };
  } else {
    out.sentiment = null;
    out.sentiment_note = tracked
      ? `no reading: no stories in the last ${SENTIMENT.ACUTE_WINDOW_HOURS} hours`
      : 'not tracked yet: SenIQ does not read the news for this company';
  }
  out.note = held
    ? 'This company IS in the user\'s portfolio: use the holding tools for its news, sentiment detail, smart money and impact.'
    : 'Not in the user\'s portfolio. Price and sentiment are all SenIQ has for it: no news detail, smart money or impact. Adding it to the portfolio brings those.';
  return out;
}

const SYMBOL = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
function priceText(price, currency) {
  const digits = price < 1 ? 6 : 2;
  const n = Number(price).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
  return SYMBOL[currency] ? `${SYMBOL[currency]}${n}` : `${n}${currency ? ` ${currency}` : ''}`;
}
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// One snapshot as a sentence or two. Pure.
function snapshotLine(s) {
  const who = s.name && s.name !== s.ticker ? `${s.name} (${s.ticker})` : s.ticker;
  let price;
  if (s.price == null) price = 'There is no live price for it right now.';
  else {
    const c = s.day_change_pct;
    const move = c == null ? 'day change not available' : c === 0 ? 'unchanged today' : `${c > 0 ? 'up' : 'down'} ${Math.abs(c).toFixed(2)}% today`;
    price = `Price ${priceText(s.price, s.currency)}, ${move}.`;
  }
  let tone;
  if (!s.sentiment) {
    tone = s.sentiment_note && s.sentiment_note.startsWith('not tracked')
      ? 'SenIQ does not read the news for it yet, so there is no sentiment reading.'
      : `No sentiment reading: SenIQ has no stories on it from the last ${SENTIMENT.ACUTE_WINDOW_HOURS} hours.`;
  } else {
    const basis = s.sentiment.z_vs_90d != null
      ? `z-score ${s.sentiment.z_vs_90d} against its own 90-day normal`
      : 'too little history to compare with its usual level';
    tone = `News sentiment ${s.sentiment.label} (${Number(s.sentiment.score).toFixed(2)} on a 0 to 1 scale, 0.5 is neutral) from ${plural(s.sentiment.stories, 'story', 'stories')} in the last ${s.sentiment.window_hours} hours; ${basis}.`;
  }
  return `${who}: ${price} ${tone}`;
}

// A question that asks what to do, or what a price will do. Pure.
const ADVICE_ASKED = [
  /\b(should|shall|can|could|would|must|do)\s+(i|we)\s+(\w+\s+){0,2}(buy|sell|hold|invest|exit|add|book|accumulate|short|trim|enter)\b/i,
  /\b(a|an)\s+(good|bad|safe|strong|better|great|risky)\s+(buy|sell|bet|investment|pick|stock to (buy|own))\b/i,
  /\b(good|right|bad|best)\s+time\s+to\s+(buy|sell|invest|enter|exit)\b/i,
  /\bworth\s+(buying|investing|holding|selling)\b/i,
  /\bbuy\s+or\s+sell\b|\b(price\s+target|target\s+price)\b|\brecommend/i,
  /\b(will|is|going\s+to)\s+(\w+\s+){0,3}(go\s+up|go\s+down|rise|fall|crash|rally|drop|recover|double|rebound)\b/i,
  /\b(predict|prediction|forecast)\b/i,
];
const asksForAdvice = (question) => ADVICE_ASKED.some((re) => re.test(String(question || '')));

// A question about what a price did over time, not only where it is now. Pure.
const HISTORY_ASKED = /\b(histor\w*|past\s+(week|month|quarter|year|few)|last\s+(week|month|quarter|year|\d+\s+(days?|weeks?|months?))|over\s+the\s+(last|past)|this\s+(week|month|quarter|year)|year[-\s]to[-\s]date|ytd|52[-\s]week|all[-\s]time|since\s+\w+|perform\w*|how\s+(has|have|did)\b|returns?|chart|peak|its\s+(high|low))\b/i;
const asksAboutHistory = (question) => HISTORY_ASKED.test(String(question || ''));

const LABEL = { '1_week': '1 week', '1_month': '1 month', '3_months': '3 months', '6_months': '6 months', '1_year': '1 year', year_to_date: 'this calendar year' };
// A price-history result (priceHistory.buildHistory) as one line. Pure.
function historyLine(h) {
  if (!h || !h.changes) return 'There is no price history for it right now.';
  const moves = Object.entries(h.changes).filter(([, c]) => c)
    .map(([k, c]) => `${LABEL[k] || k} ${c.change_pct > 0 ? '+' : ''}${c.change_pct.toFixed(2)}%`);
  const from = h.history_starts ? ` (its history here starts ${h.history_starts})` : '';
  return `Closing prices to ${h.last_close.date}${from}: ${moves.join(', ')}. Highest close in the period ${priceText(h.highest_close.close, h.currency)} on ${h.highest_close.date}, lowest ${priceText(h.lowest_close.close, h.currency)} on ${h.lowest_close.date}.`;
}

/**
 * The code-written answer to a question only about stocks the user does not hold. Pure.
 * `left` = tickers named in the question beyond the ones snapshotted. `advice`: the question
 * asked what to do, so the answer says it does not advise. `histories` = price-history
 * results by ticker, given when the question asked about the past.
 */
function snapshotAnswer(snapshots, left = [], { advice = false, histories = null } = {}) {
  if (!snapshots.length) return null;
  const many = snapshots.length + left.length > 1;
  const names = snapshots.map((s) => s.ticker).concat(left).join(', ');
  const lines = [
    ...(advice ? ['SenIQ doesn\'t give buy, sell or hold advice, or predictions. Here is what it has.'] : []),
    `${names} ${many ? "aren't" : "isn't"} in your portfolio, so SenIQ has only ${many ? 'their' : 'its'} price and sentiment reading${histories ? ', and what the price did over the past year' : ''}.`,
    ...snapshots.flatMap((s) => [snapshotLine(s), ...(histories ? [historyLine(histories[s.ticker])] : [])]),
  ];
  if (left.length) lines.push(`Not shown here: ${left.join(', ')}. Ask about ${left.length === 1 ? 'it' : 'them'} separately.`);
  lines.push(`Add ${many ? 'them' : 'it'} to your portfolio (Portfolio page, "Add Asset") for news, smart money and the impact on your holdings.`);
  return lines.join('\n');
}

// ── DB- and network-backed ──

// A typed name or ticker → reference rows, best first: the Add Asset search's ordering
// (GET /api/portfolio/search), plus an exact alias, which the curated names have.
async function searchCompanies(typed) {
  const raw = String(typed || '').trim().replace(/^\$/, '').slice(0, 40);
  if (!raw) return [];
  const like = raw.replace(/[%_\\]/g, '\\$&');
  return require('../db').query(
    `SELECT ticker, name, aliases, asset_class, exchange, country, tier
       FROM companies
      WHERE is_active AND (ticker ILIKE $1 || '%' OR name ILIKE '%' || $1 || '%'
            OR EXISTS (SELECT 1 FROM unnest(aliases) al WHERE lower(al) = lower($2)))
      ORDER BY (upper(ticker) = upper($2)) DESC, (lower(name) = lower($2)) DESC,
               EXISTS (SELECT 1 FROM unnest(aliases) al WHERE lower(al) = lower($2)) DESC,
               (ticker ILIKE $1 || '%') DESC, (tier = 'curated') DESC, length(name), ticker
      LIMIT $3`,
    [like, raw, QA.SNAPSHOT_MATCHES + 1]
  );
}

async function findCompany(typed) {
  return pickCompany(typed, await searchCompanies(typed));
}

// Price and sentiment for one reference row. A failed quote or score leaves that part empty.
async function snapshot(company, { held = false } = {}) {
  const { getQuotes } = require('./priceService');
  const { scoreTicker } = require('./sentimentScoring');
  const [quotes, sentiment] = await Promise.all([
    getQuotes([{ ticker: company.ticker, assetClass: company.asset_class, exchange: company.exchange }]).catch(() => ({})),
    scoreTicker(company.ticker).catch(() => null),
  ]);
  return buildSnapshot(company, quotes[company.ticker] || null, sentiment, { held });
}

/**
 * The answer for a question only about curated names the user does not hold: a snapshot of
 * each, up to QA.SNAPSHOT_MAX_NAMES. null when there is nothing to show (the caller keeps
 * the fixed refusal).
 */
async function outsideAnswer(tickers, question = '') {
  const want = tickers.slice(0, QA.SNAPSHOT_MAX_NAMES);
  const rows = await require('../db').query(
    'SELECT ticker, name, asset_class, exchange, country, tier FROM companies WHERE is_active AND ticker = ANY($1)', [want]);
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  const snaps = [];
  for (const t of want) if (byTicker.has(t)) snaps.push(await snapshot(byTicker.get(t)));
  const shown = new Set(snaps.map((s) => s.ticker));
  let histories = null;
  if (snaps.length && asksAboutHistory(question)) {
    const { priceHistory } = require('./priceHistory');
    histories = {};
    for (const s of snaps) histories[s.ticker] = await priceHistory(byTicker.get(s.ticker));
  }
  return snapshotAnswer(snaps, tickers.filter((t) => !shown.has(t)), { advice: asksForAdvice(question), histories });
}

module.exports = { pickCompany, buildSnapshot, snapshotLine, snapshotAnswer, historyLine, asksForAdvice, asksAboutHistory, priceText, searchCompanies, findCompany, snapshot, outsideAnswer };
