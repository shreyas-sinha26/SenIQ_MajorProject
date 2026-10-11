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
const px = (n) => round(n, n < 1 ? 6 : 2);

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

// How an answer that uses a snapshot is laid out and how much it holds; sent with the result.
// No figures in it: a tool result is evidence to the grounding check.
const SNAPSHOT_SHAPE = 'Answer only what was asked. Asked for its price or its sentiment: one sentence, saying in a few words that it is not in the portfolio. Asked to set it beside another stock: one line for each as "name · price · day change · sentiment label with the number of stories behind it", keeping only the fields the question is about ("no reading" where there is none); then one short sentence that says which is not in the portfolio and, when the question asks which is better or higher, what the two readings are without choosing between the stocks. Leave out, unless asked: the session high and low, z-scores and momentum, exposure, the baseline, how many stories is few, and how to add the stock.';

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
    price: quote && quote.price != null ? px(quote.price) : null,
    currency: quote ? quote.currency || null : null,
    day_change_pct: quote && quote.changePct != null ? round(quote.changePct) : null,
  };
  // The latest session's high and low, where the price feed gives them (not for coins).
  if (quote && quote.dayHigh != null && quote.dayLow != null) Object.assign(out, { session_high: px(quote.dayHigh), session_low: px(quote.dayLow) });
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
    : 'Not in the user\'s portfolio. Price and sentiment are all SenIQ has for it: no news detail, smart money or impact.';
  out.answer_shape = SNAPSHOT_SHAPE;
  return out;
}

const SYMBOL = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
function priceText(price, currency) {
  const digits = price < 1 ? 6 : 2;
  const n = Number(price).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
  return SYMBOL[currency] ? `${SYMBOL[currency]}${n}` : `${n}${currency ? ` ${currency}` : ''}`;
}
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// What a question asks for, so the code-written answer gives that and stops: "What was
// Tesla's high today?" gets the high, not the price, the low and the sentiment reading as
// well. null when it asks for nothing in particular ("How is Tesla doing?", "Any news on
// Tesla?"), and the whole snapshot is then the answer. Pure.
const PRICE_ASKED = /\b(price[ds]?|quote[ds]?|ltp|cmp|(?:trading|trades?|quoting)\s+at|how\s+much\s+(?:is|are|does|do)|worth)\b/i;
const SENTIMENT_ASKED = /\b(sentiment|mood|tone|bullish|bearish|z-?score)\b/i;
function asksFor(question) {
  const q = String(question || '');
  const range = /\b(range|highs?\s+(?:and|or|&)\s+lows?)\b/i.test(q);
  const parts = {
    price: PRICE_ASKED.test(q),
    high: range || /\bhigh(?:est)?\b/i.test(q),
    low: range || /\blow(?:est)?\b/i.test(q),
    sentiment: SENTIMENT_ASKED.test(q),
  };
  return Object.values(parts).some(Boolean) ? parts : null;
}

// One snapshot in sentences. `parts` (asksFor) keeps it to what was asked; without it, the
// price and the sentiment reading. `withHistory`: the past is given on the next line
// (historyLine), so the line here is the price alone, or nothing when the question asked
// for the period's high or low. Pure.
function snapshotLine(s, parts = null, withHistory = false) {
  const who = s.name && s.name !== s.ticker ? `${s.name} (${s.ticker})` : s.ticker;
  const want = parts || { price: true, sentiment: !withHistory };
  const out = [];
  if (want.price || (withHistory && !want.sentiment && !want.high && !want.low)) {
    if (s.price == null) out.push('There is no live price for it right now.');
    else {
      const c = s.day_change_pct;
      // The change is the last session's against the one before (24 hours for a coin).
      // "Today" was wrong on a weekend: "up 2.38% today" on a Sunday.
      const span = s.asset_class === 'crypto' ? 'over the last 24 hours' : 'in its last session';
      const move = c == null ? 'day change not available' : c === 0 ? `unchanged ${span}` : `${c > 0 ? 'up' : 'down'} ${Math.abs(c).toFixed(2)}% ${span}`;
      out.push(`Price ${priceText(s.price, s.currency)}, ${move}.`);
    }
  }
  if ((want.high || want.low) && !withHistory) {
    const high = priceText(s.session_high ?? 0, s.currency);
    const low = priceText(s.session_low ?? 0, s.currency);
    if (s.session_high == null) out.push('SenIQ has no session high or low for it right now.');
    else if (want.high && want.low) out.push(`Its latest session's high was ${high} and its low ${low}.`);
    else out.push(`Its latest session's ${want.high ? `high was ${high}` : `low was ${low}`}.`);
  }
  if (want.sentiment) {
    if (!s.sentiment) {
      out.push(s.sentiment_note && s.sentiment_note.startsWith('not tracked')
        ? 'SenIQ does not read the news for it yet, so there is no sentiment reading.'
        : `No sentiment reading: SenIQ has no stories on it from the last ${SENTIMENT.ACUTE_WINDOW_HOURS} hours.`);
    } else {
      const basis = s.sentiment.z_vs_90d != null
        ? `z-score ${s.sentiment.z_vs_90d} against its own 90-day normal`
        : 'too little history to compare with its usual level';
      out.push(`News sentiment ${s.sentiment.label} (${Number(s.sentiment.score).toFixed(2)} on a 0 to 1 scale, 0.5 is neutral) from ${plural(s.sentiment.stories, 'story', 'stories')} in the last ${s.sentiment.window_hours} hours; ${basis}.`);
    }
  }
  return `${who}:${out.length ? ` ${out.join(' ')}` : ''}`;
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
// A price-history result (priceHistory.buildHistory) as one line. Asked for the high or
// the low (`parts`, asksFor), it is that figure and its date and no more. Pure.
function historyLine(h, parts = null) {
  if (!h || !h.changes) return 'There is no price history for it right now.';
  const from = h.history_starts ? ` (its history here starts ${h.history_starts})` : '';
  const traded = !!h.highest_price;
  const top = traded ? h.highest_price : h.highest_close;
  const bottom = traded ? h.lowest_price : h.lowest_close;
  const at = (x) => `${priceText(traded ? x.price : x.close, h.currency)} on ${x.date}`;
  if (parts && (parts.high || parts.low)) {
    const what = traded ? 'price' : 'close';
    const asked = [parts.high && `highest ${what} ${at(top)}`, parts.low && `lowest ${what} ${at(bottom)}`].filter(Boolean).join(', ');
    return `In the year to ${h.last_close.date}${from}: ${asked}.`;
  }
  const moves = Object.entries(h.changes).filter(([, c]) => c)
    .map(([k, c]) => `${LABEL[k] || k} ${c.change_pct > 0 ? '+' : ''}${c.change_pct.toFixed(2)}%`);
  return `Closing prices to ${h.last_close.date}${from}: ${moves.join(', ')}. Highest ${traded ? 'price' : 'close'} in the period ${at(top)}, lowest ${at(bottom)}.`;
}

/**
 * The code-written answer to a question only about stocks the user does not hold. Pure.
 * `left` = tickers named in the question beyond the ones snapshotted. `advice`: the question
 * asked what to do, so the answer says it does not advise. `histories` = price-history
 * results by ticker, given when the question asked about the past. `parts` = what the
 * question asked for (asksFor): given, the answer is that and nothing around it. A question
 * that asked for nothing in particular gets the price and the sentiment reading, and one
 * closing line on what a holding would add.
 */
function snapshotAnswer(snapshots, left = [], { advice = false, histories = null, parts = null } = {}) {
  if (!snapshots.length) return null;
  const many = snapshots.length + left.length > 1;
  const names = snapshots.map((s) => s.ticker).concat(left).join(', ');
  const lines = [
    ...(advice ? ['SenIQ doesn\'t give buy, sell or hold advice, or predictions. Here is what it has.'] : []),
    ...snapshots.flatMap((s) => {
      const line = snapshotLine(s, parts, !!histories);
      if (!histories) return [line];
      const past = historyLine(histories[s.ticker], parts);
      return line.endsWith(':') ? [`${line} ${past}`] : [line, past];   // nothing but the past was asked for
    }),
  ];
  if (left.length) lines.push(`Not shown here: ${left.join(', ')}. Ask about ${left.length === 1 ? 'it' : 'them'} separately.`);
  if (!parts && !histories) lines.push(`${names} ${many ? "aren't" : "isn't"} in your portfolio. Add ${many ? 'them' : 'it'} on the Portfolio page ("Add Asset") to see ${many ? 'their' : 'its'} stories, smart money and impact on your holdings.`);
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
  return snapshotAnswer(snaps, tickers.filter((t) => !shown.has(t)), { advice: asksForAdvice(question), histories, parts: asksFor(question) });
}

module.exports = { pickCompany, buildSnapshot, snapshotLine, snapshotAnswer, historyLine, asksFor, asksForAdvice, asksAboutHistory, priceText, searchCompanies, findCompany, snapshot, outsideAnswer, SNAPSHOT_SHAPE };
