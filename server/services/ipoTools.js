/**
 * Ask's IPO Watch tools — read-only questions about the public issues on the IPO Watch page
 * (India mainboard and SME, and the US): what is open or coming up, how issues compare on
 * what is recorded, how recent listings did, and what the news says about one of them.
 *
 * Loaded into the agent only when FEATURES.IPO_WATCH is on.
 *
 * SCOPE. This is the one place Ask reads about companies the user does not hold. What is in
 * scope is the calendar: an issue the IPO Watch page shows. No tool here takes a ticker, so
 * the holdings rule in qaTools.js is untouched.
 *
 * COMPARE, NEVER PICK. A tool hands back figures as recorded, each with its date, and
 * orderings by ONE named figure, worked out here so the model reads a ranking instead of
 * making one. Nothing here rates an issue or combines figures into a score: a listing-gain
 * estimate needs the outcomes IPO_PLAN.md (Change 5) is still collecting.
 *
 * ASK ONLY. These are not in dataTools.js, so /mcp and /v1 do not serve them: the Indian
 * figures come from a source whose terms for reuse are not settled (IPO_PLAN.md).
 */

const { QA, IPO_WATCH } = require('../config');
const { ScopeError } = require('./qaTools');
const { shortDay, daySpan } = require('./answerText');

// Lazy, like qaTools' queries: the calendar modules open the database when loaded.
const watch = () => require('./ipoWatch');
const arc = () => require('./ipoWatch/arc');

const num = (x, d = 2) => {
  const n = Number(x);
  return x == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
};
const clip = (text, n) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// A timestamp → the day it fell on, on the exchange's clock.
const dayOf = (t) => (t ? new Intl.DateTimeFormat('en-CA', { timeZone: IPO_WATCH.TIMEZONE }).format(new Date(t)) : null);
// Empty fields are left out: a result has QA.MAX_TOOL_RESULT_CHARS to fit in. Pure.
const lean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== false));

// ── Pure helpers ──

/**
 * Where an issue is in its dates, in the words an answer uses, so every answer gives the
 * same ones and no more: the bidding days for what is coming, the listing day for what has
 * listed. Pure.
 */
function datesText(r, today = null) {
  const d = (iso) => shortDay(iso, today);
  if (r.market === 'US') {
    if (r.stage === 'listed') return d(r.first_trade_date || r.listing_date) ? `listed ${d(r.first_trade_date || r.listing_date)}` : null;
    if (r.stage === 'announced') return d(r.status_date) ? `filed ${d(r.status_date)}` : null;
    if (!d(r.listing_date)) return null;
    return `${today && r.stage === 'upcoming' && r.listing_date < today ? 'was expected' : 'expected'} ${d(r.listing_date)}`;
  }
  if (r.stage === 'open') return d(r.close_date) ? `bidding open until ${d(r.close_date)}` : 'bidding open';
  if (r.stage === 'upcoming') return r.open_date ? `bidding ${daySpan(r.open_date, r.close_date, today)}` : null;
  if (r.stage === 'closed') return [d(r.close_date) && `bidding closed ${d(r.close_date)}`, d(r.listing_date) && `lists ${d(r.listing_date)}`].filter(Boolean).join(', ') || null;
  if (r.stage === 'listed') return d(r.listing_date) ? `listed ${d(r.listing_date)}` : null;
  return null;
}

// Money as an answer says it: rupees and crore for India, dollars and millions for the US.
// Written out here so every answer gives a price and a size the same way. Pure.
const priceText = (v, us) => (v == null ? null : `${us ? '$' : '₹'}${num(v)}`);
const sizeText = (r) => (r.market === 'US'
  ? (r.issue_size_usd == null ? null : `$${num(r.issue_size_usd / 1e6, 1)} million`)
  : (r.issue_size_cr == null ? null : `₹${num(r.issue_size_cr)} crore`));

// A question about public issues, whatever companies it names. Such a question skips the
// holdings pre-check in qa.js: "the Jio IPO" is not a question about Reliance shares.
const IPO_WORDS = /\b(ipos?|gmp|grey[- ]market|public (issue|offer)\w*)\b/i;
const isIpoQuestion = (question) => IPO_WORDS.test(String(question || ''));

// The same lists as ipoWatch/index.js, written out because a tool's schema is built when this
// file loads and the calendar module is not loaded until a tool runs (a test keeps them equal).
const MARKETS = ['IN', 'US'];
const BOARDS = ['mainboard', 'sme'];
// In the order a reader wants them: what can be bid for now, then what is coming.
const STAGES = ['open', 'upcoming', 'closed', 'announced', 'listed', 'withdrawn'];
const NOT_YET_LISTED = ['open', 'upcoming', 'closed', 'announced'];
// What get_ipo_calendar shows when no stage is asked for: what can be bid for, and what is next.
const AHEAD = ['open', 'upcoming'];
// The stages at which an issue can carry a subscription figure or a grey market premium.
const WITH_DEMAND = ['open', 'upcoming', 'closed'];
const GAIN_ENDS = 3;   // listing gains: this many from the top, and from the bottom

/**
 * One calendar row → the card Ask sees. Money is text in the unit a reader says it in
 * ("₹271", "₹712.31 crore", "$183.3 million"), so an answer never converts and every answer
 * writes it the same way. `tone` is the issue's news tone when it has been read; `full` adds
 * what only the one-issue view needs (each date on its own, the price band), and leaves the
 * news to its own block there. `today` marks a US issue still called expected after its
 * date, and lets a date of this year go without the year. Pure.
 */
function issueCard(r, { tone = null, full = false, today = null } = {}) {
  const us = r.market === 'US';
  const returns = lean({ listing_day: r.ret_listing_day_pct, week_1: r.ret_1w_pct, month_1: r.ret_1m_pct, month_3: r.ret_3m_pct });
  return lean({
    id: `i${r.id}`, name: r.name, market: r.market, board: r.board, stage: r.stage,
    us_status: us ? r.source_status : null,          // filed | expected | priced | withdrawn, as the source states it
    spac: r.is_spac || null,
    symbol: r.symbol,
    dates: datesText(r, today),
    // The source still says "expected" and the calendar has not been refreshed since.
    listing_date_passed: Boolean(today && r.stage === 'upcoming' && r.listing_date && r.listing_date < today),
    price: priceText(r.price_high, us),
    size: sizeText(r),
    subscription: r.sub_total == null ? null
      : lean({ total_x: r.sub_total, qib_x: r.sub_qib, nii_x: r.sub_nii, retail_x: r.sub_retail, as_of: r.sub_on }),
    // Already null when the reading is stale or the issue has listed (gmpView): Ask shows
    // a premium exactly when the page does.
    gmp: r.gmp == null ? null
      : lean({ inr: r.gmp, pct_of_price: r.gmp_pct, as_of: dayOf(r.gmp_at), reading_before: r.gmp_prev }),
    listing: r.listing_price == null && r.listing_gain_pct == null ? null
      : lean({ price: r.listing_price, gain_pct: r.listing_gain_pct, price_worked_back_from_gain: r.listing_price_derived || null }),
    returns_pct: Object.keys(returns).length ? returns : null,
    news: r.stories && !full ? lean({ stories: r.stories, tone: tone && tone.label, tone_score: tone && tone.score, stories_read: tone && tone.stories }) : null,
    ...(full ? lean({
      open_date: r.open_date, close_date: r.close_date, listing_date: r.listing_date,
      first_trade_date: r.first_trade_date, status_date: r.status_date,
      price_band: r.price_low != null && r.price_low !== r.price_high ? `${priceText(r.price_low, us)} to ${priceText(r.price_high, us)}` : null,
      exchange: r.exchange, allotment_date: r.allotment_date, lot_size: r.lot_size,
      fresh_issue_cr: r.fresh_issue_cr, offer_for_sale_cr: r.ofs_cr, shares: r.shares,
    }) : {}),
  });
}

/**
 * Issues in the order a reader wants them: by stage (open first), mainboard and US before
 * SME within a stage, then the soonest date for what is coming and the most written-about,
 * latest first, for the rest. Pure.
 */
function orderIssues(rows) {
  const when = (r) => r.first_trade_date || r.listing_date || r.open_date || r.status_date || '';
  const soon = (r) => r.open_date || r.listing_date || '9';   // undated last
  return rows.slice().sort((a, b) =>
    STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage)
    || (a.board === 'sme') - (b.board === 'sme')
    || (a.stage === 'upcoming' ? soon(a).localeCompare(soon(b)) : 0)
    || (b.stories || 0) - (a.stories || 0)
    || when(b).localeCompare(when(a))
    || String(a.name).localeCompare(String(b.name)));
}

/**
 * The comparisons spelled out, each by ONE recorded figure, so "most subscribed" is read
 * from the result and not worked out — and so nothing ranks issues "overall". Listing gains
 * come with both ends and a count of how many issues gained: the best few alone would read
 * as "IPOs go up". `demand` = the issues the subscription and premium orderings read, when
 * that is more than the ones shown (bidding that has closed is still the latest figure).
 * Size is ordered within a market, never across two currencies. Pure.
 */
function orderings(rows, { top = QA.IPO_RANK_TOP, demand = rows, today = null } = {}) {
  const marks = (r) => [r.board === 'sme' ? 'SME' : null, r.stage === 'closed' ? 'bidding closed' : null].filter(Boolean);
  const label = (r) => `${r.name}${marks(r).length ? ` (${marks(r).join(', ')})` : ''}`;
  const sortedOf = (list, field) => list.filter((r) => r[field] != null).sort((a, b) => b[field] - a[field]);
  const sorted = (field) => sortedOf(rows, field);
  const line = (list, text) => (list.length ? list.map((r, i) => `${i + 1}. ${label(r)} ${text(r)}`).join('; ') : null);
  const bySize = (market, field) => line(sortedOf(rows.filter((r) => r.market === market && AHEAD.includes(r.stage)), field).slice(0, top), sizeText);
  // What comes first: an Indian issue by the day bidding opens, a US one by its expected listing.
  const next = (r) => (r.market === 'US' ? r.listing_date : r.open_date);
  const coming = rows.filter((r) => r.stage === 'upcoming' && next(r) && !(today && next(r) < today))
    .sort((a, b) => next(a).localeCompare(next(b)));
  const gains = sorted('listing_gain_pct');
  const d = (iso) => shortDay(iso, today);
  const gainText = (r) => `${r.listing_gain_pct}%, listed ${d(r.first_trade_date || r.listing_date)}`;
  const count = (test) => gains.filter((r) => test(r.listing_gain_pct)).length;
  const mid = gains.length >> 1;
  const median = gains.length % 2 ? gains[mid].listing_gain_pct : gains.length ? (gains[mid - 1].listing_gain_pct + gains[mid].listing_gain_pct) / 2 : null;
  return lean({
    by_subscription: line(sortedOf(demand, 'sub_total').slice(0, top), (r) => `${r.sub_total}x, as of ${d(r.sub_on)}`),
    by_gmp_pct: line(sortedOf(demand, 'gmp_pct').slice(0, top), (r) => `${r.gmp_pct}% of the issue price, unofficial, as of ${d(dayOf(r.gmp_at))}`),
    by_size_india: bySize('IN', 'issue_size_cr'),
    by_size_us: bySize('US', 'issue_size_usd'),
    soonest: line(coming.slice(0, top), (r) => (r.market === 'US' ? `expected to list ${d(next(r))}` : `bidding opens ${d(next(r))}`)),
    listing_gains: gains.length ? `${gains.length} with a listing result: ${count((g) => g > 0)} above the issue price, ${count((g) => g < 0)} below, ${count((g) => g === 0)} at it; median ${num(median)}%` : null,
    highest_listing_gain: line(gains.slice(0, GAIN_ENDS), gainText),
    // Lowest first. Left out when the list above already holds every issue.
    lowest_listing_gain: line(gains.slice(GAIN_ENDS).slice(-GAIN_ENDS).reverse(), gainText),
  });
}

// How many issues each market has at each stage: { IN: { upcoming: 4, listed: 44 }, … }. Pure.
function stageCounts(rows) {
  const out = {};
  for (const r of rows) {
    out[r.market] = out[r.market] || {};
    out[r.market][r.stage] = (out[r.market][r.stage] || 0) + 1;
  }
  return out;
}

// Cards are dropped from the end until the result fits (measured as runTool measures it),
// and the count of what is missing goes with it: a result cut off mid-card by runTool's
// clamp would say nothing of the rest. Pure.
function fitIssues(result, matching, maxChars = QA.MAX_TOOL_RESULT_CHARS) {
  const out = { ...result, issues: result.issues.slice() };
  const mark = () => {
    const missing = matching - out.issues.length;
    if (missing > 0) out.not_shown = `${missing} more ${missing === 1 ? 'issue matches' : 'issues match'}; narrow with market, stage or board to see them.`;
  };
  mark();
  while (out.issues.length > 1 && JSON.stringify(out).length > maxChars) {
    out.issues.pop();
    mark();
  }
  return out;
}

/**
 * The issues a name the user wrote could mean: the same name; failing that the ticker;
 * failing that a name holding it as whole words, either way round ("Jio" → "Jio Platforms").
 * More than one hit is for the caller to put back to the user. Pure given the rows.
 */
function matchIssues(rows, wanted) {
  const { nameKey } = watch();
  const { joinInitials } = require('./ipoWatch/registry');
  const key = (name) => joinInitials(nameKey(name));
  const want = key(wanted);
  if (!want) return [];
  const keyed = rows.map((r) => ({ r, key: key(r.name) }));
  const same = keyed.filter((x) => x.key === want);
  if (same.length) return same.map((x) => x.r);
  const symbol = String(wanted).trim().toUpperCase().replace(/^\$/, '');
  const bySymbol = rows.filter((r) => r.symbol && r.symbol === symbol);
  if (bySymbol.length) return bySymbol;
  if (want.length < 3) return [];
  return keyed
    .filter((x) => x.key.length >= 3 && (` ${x.key} `.includes(` ${want} `) || ` ${want} `.includes(` ${x.key} `)))
    .map((x) => x.r);
}

// What storiesFor returns → the news part of one issue's detail. Pure.
function newsBlock(news) {
  const stories = (news && news.stories) || [];
  if (!stories.length) return { stories_linked: 0 };
  const latest = stories.slice(0, QA.IPO_DETAIL_STORIES).map((s) => lean({
    title: clip(s.title, 110), source: s.source, date: s.day,
    tone: s.sentiment ? s.sentiment.label : null,
    // Linked but not read for tone: one tone for a text about several issues is about none of them.
    not_read: s.shared ? 'covers several issues' : s.passing ? 'names the issue only below the headline' : null,
  }));
  return lean({
    stories_linked: stories.length,
    tone: news.tone ? { label: news.tone.label, score: news.tone.score, stories_read: news.tone.stories } : null,
    tone_by_day: news.arc && news.arc.length ? news.arc.slice(-QA.IPO_DETAIL_DAYS) : null,
    latest,
    older_not_shown: stories.length - latest.length || null,
  });
}

const MARKET_NAMES = { IN: 'India', US: 'the US' };
const MARKET_HEADS = { IN: 'India', US: 'US' };

// One issue as a line of the no-model answer: what is on record, in the order Ask gives it. Pure.
const digestRow = (i) => [i.name, i.market === 'IN' ? i.board : null, i.dates, i.price, i.size].filter(Boolean).join(' · ');

/**
 * What a question asks of the calendar, read without a model: which market, and whether it
 * is about what is open now, about the grey market premium, about subscription, or asks
 * whether to apply. With the model off every IPO question used to get the one digest, India
 * first: "Which IPO has the highest GMP?" and "Tell me about the upcoming IPOs in the US"
 * were answered word for word alike. Pure.
 */
function ipoAsk(question) {
  const q = String(question || '');
  const us = /\b(US|U\.S\.|USA|America\w*|United States|Nasdaq|NYSE|Wall Street)\b/.test(q);
  const india = /\b(india\w*|NSE|BSE|SME|mainboard|grey[- ]market|gmp|sensex|nifty)\b/i.test(q);
  return {
    market: us && !india ? 'US' : india && !us ? 'IN' : null,
    open: /\b(open|opened|bid(?:ding)?|apply(?:ing)? (?:now|today)|right now|currently)\b/i.test(q),
    gmp: /\b(gmp|grey[- ]market|premium)\b/i.test(q),
    subscription: /\b(subscri\w+|oversubscri\w+|demand)\b/i.test(q),
    advice: /\b(worth|should|shall|good|promising|best|recommend\w*|safe|risky|apply for|invest in)\b/i.test(q),
  };
}

/**
 * The no-model answer to an IPO question, from a get_ipo_calendar result: for each market what
 * is open or coming up, one issue to a line, then the orderings. `ask` (ipoAsk) puts first
 * what the question was about: that SenIQ does not advise on applying, that nothing is open,
 * the ordering asked for. A data digest, not a reasoned answer. Pure.
 */
function ipoDigest(cal, ask = {}) {
  const lines = [];
  if (ask.advice) lines.push('SenIQ does not rate issues or say whether to apply for one. What is on record:');
  const o = cal.orderings || {};
  // The figure the question asked about leads; it is not repeated in the comparison below.
  const led = new Set();
  if (ask.gmp) { lines.push(o.by_gmp_pct ? `Grey market premium, highest first: ${o.by_gmp_pct}. It is an unofficial figure, not a forecast.` : 'No grey market premium is on record for any issue right now.'); led.add('gmp'); }
  if (ask.subscription) { lines.push(o.by_subscription ? `Most subscribed: ${o.by_subscription}.` : 'No subscription figure is on record for any issue right now.'); led.add('subscription'); }
  for (const m of cal.markets) {
    const c = cal.counts[m] || {};
    const ahead = AHEAD.filter((s) => c[s]).map((s) => `${c[s]} ${s}`);
    // Asked what is open: say outright when nothing is, before listing what is coming.
    const noneOpen = ask.open && !c.open ? ' No issue is open for bidding right now.' : '';
    lines.push(`${MARKET_HEADS[m] || m}: ${ahead.length ? ahead.join(', ') : 'nothing open or coming up'} (calendar refreshed ${shortDay(cal.refreshed[m], cal.as_of) || 'never'}).${noneOpen}`);
    for (const i of cal.issues.filter((x) => x.market === m)) lines.push(digestRow(i));
  }
  if (cal.not_shown) lines.push(cal.not_shown.replace(/;.*$/, '.'));
  const first = (ordering) => ordering.split('; ')[0].replace(/^1\. /, '');   // the rows above already list the rest
  const compare = [
    !led.has('subscription') && o.by_subscription && `Most subscribed: ${o.by_subscription}.`,
    !led.has('gmp') && o.by_gmp_pct && `Grey market premium: ${o.by_gmp_pct}.`,
    o.by_size_india && `Largest in India: ${first(o.by_size_india)}.`,
    o.by_size_us && `Largest in the US: ${first(o.by_size_us)}.`,
  ].filter(Boolean);
  if (compare.length) lines.push('', ...compare);
  // No "turn on the AI writer" line, and no notice of its own: a user cannot turn it on, and
  // the page already marks the answer as written by code and as informational.
  return lines.join('\n');
}

// ── Tool definitions (appended to Ask's tools when IPO Watch is on — keep order stable for caching) ──
const IPO_TOOLS = [
  {
    name: 'get_ipo_calendar',
    description: 'Public issues (IPOs) on SenIQ\'s IPO Watch page — India (mainboard and SME) and the US. These are companies the user does NOT hold. Each issue has its stage (announced, upcoming, open, closed = bidding over and not yet listed, listed, withdrawn), dates, price and size, and where recorded: subscription (times bid for, with its date), grey market premium (unofficial, India only, with its date), how many news stories are linked and their tone, and for listed issues the listing gain and returns since. Also counts by stage and orderings by one figure each (subscription, grey market premium, size within a market, what comes soonest). With no stage it returns the issues open for bidding and coming up; pass a stage for the others (closed, announced, listed, withdrawn). The subscription and premium orderings also read issues whose bidding has closed. price is the top of the price band. Use for "which IPOs are open / coming up", "how do they compare", "which is most subscribed", "how did recent listings do".',
    input_schema: {
      type: 'object',
      properties: {
        market: { type: 'string', enum: MARKETS, description: 'Optional: IN (India) or US. Default: both.' },
        stage: { type: 'string', enum: STAGES, description: 'Optional: one stage. Default: open and upcoming.' },
        board: { type: 'string', enum: BOARDS, description: 'Optional, India only: mainboard or sme. Default: both.' },
      },
    },
  },
  {
    name: 'get_ipo_detail',
    description: 'ONE issue from IPO Watch in full: dates, price band, lot size, issue size, the latest subscription by investor class, grey market premium readings by day (unofficial, India only, only before listing), the listing result and returns since, and the news linked to it — overall tone, tone by day, and the latest stories with outlet and date. Pass the id from get_ipo_calendar (e.g. "i12") or the company name as the user wrote it. Use for "tell me about the X IPO", "what is the news saying about X\'s IPO", "when does X list".',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'An issue id from get_ipo_calendar results, e.g. "i12".' },
        name: { type: 'string', description: 'The company name, when there is no id yet.' },
      },
    },
  },
];

const CALENDAR_NOTE = 'subscription = times the shares on offer were bid for (qib institutions, nii high-net-worth), as of its date; a daily reading, not live. gmp = grey market premium per share: unofficial, not a forecast. gain_pct and returns_pct are over the issue price. tone_score: 0 to 1, 0.5 neutral. Each ordering uses one recorded figure; none is a rating. A market in `stale` was last refreshed over a day ago.';

// How an answer from each tool is laid out, and how much it holds. Sent with the result, so
// the rule arrives with the data it is for. No figures in either: a tool result is evidence
// to the grounding check.
const CALENDAR_SHAPE = 'Answer only what was asked. Asked for one figure (most subscribed, highest premium, largest, next to open): one or two sentences from the orderings, naming the issue, the figure and its date; when several issues tie, give them as rows. Asked which issues are open or coming up, or how they compare: a short heading for each market with its count, then one issue to a line as "name · board · dates · price · size", each field as the card gives it (five lines at most, in the order given; board for India only; nothing in brackets). Only if the question asks how they compare or which is better, add one line starting "Compare:" read from the orderings, about the issues shown, saying in a few words when none of them has a subscription figure yet. Asked how listings did: the listing_gains count in one sentence, then at most three issues from each end, one to a line as "name · gain · listing date". When stale_line is present, give it as written, once, on a line of its own after the rows. Leave out: news tone, unless it is positive or negative or the question is about news; issues at a stage the question did not ask about; what a term means; how to see more.';
const DETAIL_SHAPE = 'Answer only what was asked. Asked about the issue in general: at most four short lines, each starting with its label: "Dates:" (bidding and listing), "Price and size:", "Demand:" (subscription with its date, the premium called unofficial with its date, or that none is recorded yet), "News:" (the tone and how many stories were read, and nothing more). Asked about its news: the tone and how many stories were read in one sentence, then the two latest headlines, one to a line as "outlet, date · headline". Asked for one fact (when it lists, the lot size): one sentence. When stale_line is present, give it as written, once, on a line of its own at the end. Leave out the allotment date, the lot size, the stage, the user\'s own holdings and anything not recorded, unless asked.';

// "India calendar last refreshed 9 Oct." for each market whose calendar is over a day old. Pure.
const staleLine = (markets, refreshedOn, today) => (markets.length
  ? markets.map((m) => `${MARKET_HEADS[m] || m} calendar last refreshed ${shortDay(refreshedOn[m], today) || 'at a time not on record'}.`).join(' ')
  : null);

// ── Executors ──

// One of a fixed list, or nothing; anything else is refused before a query runs.
function oneOf(raw, list, what, fold) {
  if (raw == null || String(raw).trim() === '') return null;
  const v = fold(String(raw).trim());
  if (!list.includes(v)) throw new ScopeError(`${what} must be one of ${list.join(', ')}, or left out`);
  return v;
}

// Every issue the IPO Watch page can show for these markets, each with its stage. SPACs are
// left out unless asked for, as on the page.
async function loadIssues(markets, { board = 'all', spacs = false } = {}) {
  const { listCalendar, marketDate } = watch();
  const today = marketDate();
  const lists = await Promise.all(markets.map((market) => listCalendar({ market, board, spacs, today })));
  return { today, rows: lists.flat() };
}

const IPO_EXECUTORS = {
  async get_ipo_calendar({ market, stage, board } = {}) {
    const m = oneOf(market, MARKETS, 'market', (s) => s.toUpperCase());
    const s = oneOf(stage, STAGES, 'stage', (x) => x.toLowerCase());
    const b = oneOf(board, BOARDS, 'board', (x) => x.toLowerCase());
    const markets = m ? [m] : b ? ['IN'] : MARKETS;   // a board is India's
    const { today, rows } = await loadIssues(markets, { board: b || 'all' });
    const matching = orderIssues(rows.filter((r) => (s ? r.stage === s : AHEAD.includes(r.stage))));
    const issues = await Promise.all(matching.slice(0, QA.IPO_MAX_ISSUES).map(async (r) => {
      const news = r.stories ? await arc().storiesFor(r.id) : null;   // the tone the page shows for it
      return issueCard(r, { tone: news && news.tone, today });
    }));
    const ages = await Promise.all(markets.map((x) => watch().calendarAge(x)));
    const stale = markets.filter((_, i) => ages[i].stale);
    const refreshed = Object.fromEntries(markets.map((x, i) => [x, dayOf(ages[i].updatedAt)]));
    return fitIssues({
      as_of: today,
      markets,
      showing: s || 'open and upcoming',
      counts: stageCounts(rows),
      refreshed,
      ...(stale.length ? { stale, stale_line: staleLine(stale, refreshed, today) } : {}),
      // With no stage asked for, demand is read across everything that has taken bids or is about to.
      orderings: orderings(matching, { today, demand: s ? matching : rows.filter((r) => WITH_DEMAND.includes(r.stage)) }),
      note: CALENDAR_NOTE,
      answer_shape: CALENDAR_SHAPE,
      issues,
    }, matching.length);
  },

  async get_ipo_detail({ id, name } = {}) {
    const wantId = String(id ?? '').trim().toLowerCase();
    const wantName = String(name ?? '').trim();
    if (!wantId && !wantName) throw new ScopeError('id or name is required');
    const { today, rows } = await loadIssues(MARKETS, { spacs: true });
    let r;
    if (wantId) {
      r = rows.find((x) => `i${x.id}` === wantId);
      if (!r) throw new ScopeError(`ipo_not_found: no issue "${wantId.slice(0, 24)}" is on IPO Watch. Use an id from get_ipo_calendar, or pass the company name.`);
    } else {
      const hits = matchIssues(rows, wantName);
      if (!hits.length) throw new ScopeError(`ipo_not_found: no issue named "${wantName.slice(0, 60)}" is on IPO Watch right now. Say so; do not describe it from memory. get_ipo_calendar lists what is there.`);
      if (hits.length > 1) throw new ScopeError(`ipo_ambiguous: "${wantName.slice(0, 60)}" matches ${hits.length} issues: ${hits.slice(0, 5).map((x) => `${x.name} (i${x.id}, ${x.market})`).join('; ')}. Ask which one is meant, or call again with its id.`);
      r = hits[0];
    }
    const news = await arc().storiesFor(r.id);
    // The premium by day, while the page still shows one (never after listing, never stale).
    const gmpDays = r.gmp == null ? [] : await require('../db').query(
      `SELECT observed_on::text AS day, gmp::float8 AS inr FROM ipo_gmp
        WHERE ipo_id = $1 AND source = $2 ORDER BY observed_on DESC LIMIT $3::int`,
      [r.id, r.gmp_source, QA.IPO_DETAIL_DAYS]
    );
    const age = await watch().calendarAge(r.market);
    return {
      as_of: today,
      refreshed: dayOf(age.updatedAt),
      ...(age.stale ? { stale: true, stale_line: staleLine([r.market], { [r.market]: dayOf(age.updatedAt) }, today) } : {}),
      issue: issueCard(r, { full: true, today }),
      ...(gmpDays.length > 1 ? { gmp_by_day: gmpDays } : {}),
      news: newsBlock(news),
      note: `${CALENDAR_NOTE} News tone is a reading of headlines about the issue, not a rating of the company.`,
      answer_shape: DETAIL_SHAPE,
    };
  },
};

// The answer when no model is available: the calendar as a digest. null when the calendar
// cannot be read, and the caller falls back to its portfolio summary.
async function ipoFallbackAnswer(question = '') {
  const ask = ipoAsk(question);
  try { return ipoDigest(await IPO_EXECUTORS.get_ipo_calendar(ask.market ? { market: ask.market } : {}), ask); }
  catch (err) { console.error('IPO Watch digest failed:', err.message); return null; }
}

// Appended to Ask's system prompt when IPO Watch is on. No figures in it: the prompt is
// part of the evidence the grounding check reads.
const IPO_PROMPT = `

IPO Watch (this account has the IPO Watch section):
- Public issues on SenIQ's IPO Watch page — India (mainboard and SME) and the US — are in scope although the user does not hold them. Use get_ipo_calendar for what is open, coming up, closed or recently listed, and get_ipo_detail for one issue's figures and news. If the question names no market, cover both and say which market each issue is in. An issue that is not on IPO Watch is out of scope: say it is not there, and do not describe it from memory.
- Compare, never pick. If asked which issue is promising, best, worth applying for or likely to list higher, or whether to apply for one, the FIRST sentence of the answer says that SenIQ does not rate or predict issues and does not advise on applying; then show how the issues compare on what is recorded: stage and dates, subscription, grey market premium, news tone, size. You may order them by ONE named figure, taken from the orderings in the tool result. Do not combine figures into an overall view, and do not call an issue attractive, strong, hot, safe or risky in your own words.
- Subscription is how many times the shares on offer were bid for. Give its date: it is a daily reading, not live.
- Grey market premium (GMP) is an unofficial figure from one aggregator, for Indian issues only. Each time you give one, call it unofficial and give its date. It is not a forecast: never work out an expected listing price or gain from it.
- News tone is a reading of the headlines about an issue, not a rating of the company; say how many stories it rests on. US issues have no subscription or GMP figures.
- A listing gain or a return after listing is what happened to that issue. Never present it as what another issue will do.
- If a result has a stale_line, give it once, as written, and do not say the same in your own words: that calendar is over a day old. An issue marked listing_date_passed is not "expected" or "upcoming": say its date has passed. If a result says issues were not shown, say how many in a few words.
- The user cannot apply for an issue or add it to the portfolio before it lists; the full table is on the IPO Watch page.
- End every answer that uses these tools, and no other answer, with: "Educational only, not investment advice."`;

module.exports = {
  IPO_TOOLS, IPO_EXECUTORS, IPO_PROMPT, MARKETS, BOARDS, STAGES,
  isIpoQuestion, issueCard, orderIssues, orderings, stageCounts, fitIssues, matchIssues, newsBlock, ipoDigest, ipoAsk, ipoFallbackAnswer,
  CALENDAR_SHAPE, DETAIL_SHAPE, shortDay, daySpan, datesText, staleLine,
};
