/**
 * Ask reads what the app's other pages show (plan step P4, slice 3): a fund's holdings and
 * how they changed (Institutions), a politician's trades (Congress), Indian investors and
 * deals (the India side of both), and the user's own alerts and daily brief.
 *
 * The rule: Ask can read whatever the pages show this user, and nothing more, with what
 * they hold or follow first. The pages already work that way — "mine" by default (held
 * tickers and followed funds, politicians and investors), the whole list on request — so a
 * tool widens only when the question names a fund, a politician or an investor, or asks
 * about the whole market. None of them takes a ticker: smart money on one stock stays with
 * holdings (get_smart_money).
 *
 * Every function here returns a result, or { error } for the caller to hand the model as a
 * readable refusal. The pages' plan limit carries over: a plan that sees a teaser of smart
 * money on the pages sees the same two rows here.
 */

const { QA, TIERS, INDIA_SMART_MONEY, FEATURES } = require('../config');
const { INDIA_INVESTORS, INVESTOR_BY_SLUG } = require('../data/indiaInvestors');

const TEASER_ROWS = 2;   // what a teaser plan sees on the smart-money pages (routes/smartMoney.js)
const num = (v) => (v == null ? null : Number(v));
const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const polKey = (name) => String(name).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
const unescape = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
const rowCap = (ctx, n) => (TIERS[ctx.tier] && TIERS[ctx.tier].smartMoney === 'teaser' ? Math.min(n, TEASER_ROWS) : n);
const teaserNote = (ctx) => (TIERS[ctx.tier] && TIERS[ctx.tier].smartMoney === 'teaser' ? { plan_limit: `This plan shows the first ${TEASER_ROWS} rows; the full list is on Plus and Pro.` } : {});

const LAG_NOTE = 'Disclosed with a legal lag: a 13F is filed up to 45 days after the quarter ends, a congressional trade up to 45 days after it is made. Give each row its own dates, and repeat each action or change as written.';
const INDIA_NOTE = 'Bulk and block deals are published by NSE the same evening, with the client named as the exchange reports it. Insider trades are SEBI disclosures by promoters, directors and key managers, usually within two trading days. India has no congressional-trade disclosures.';

// ── Pure ──

// The funds on the Institutions page, as seeded by migration 0004 (name, manager's surname).
// Kept here only so a question can be recognised without a database; a fund added by a
// later migration belongs in this list too (test/pageTools.test.js reads the migrations).
const TRACKED_FUNDS = [
  ['Berkshire Hathaway', 'Buffett'], ['Bridgewater', 'Dalio'], ['Renaissance Technologies', 'Simons'], ['Citadel', 'Griffin'],
  ['Pershing Square', 'Ackman'], ['Scion', 'Burry'], ['ARK Invest', 'Cathie Wood'], ['Tiger Global', 'Coleman'],
  ['Appaloosa', 'Tepper'], ['Two Sigma', null],
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ACTORS = new RegExp(`(^|[^A-Za-z0-9])(${[
  ...TRACKED_FUNDS.flat().filter(Boolean), 'ARK',
  ...INDIA_INVESTORS.flatMap((i) => [i.name.replace(/\s*\(.*\)$/, ''), ...i.match]),
].map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'i');
const ACTIVITY = /\b(hold\w*|own\w*|positions?|stakes?|13f|filings?|bought|buy\w*|sold|sell\w*|deals?|trad\w+|add\w*|trimm?\w*|exit\w*|portfolio|invest\w*|pick\w*|bets?)\b/i;
const PAGE_WORDS = /\b(13f|congress\w*|senators?|politicians?|lawmakers?|bulk deals?|block deals?|insider (trad\w+|buy\w*|sell\w*|deals?)|promoters?)\b/i;

/**
 * A question for one of the pages read here, although it names a company the user does
 * not hold: "What does Berkshire Hathaway hold?" is about the fund's filing, not about
 * BRK.B shares, and "Has Goldman Sachs done any bulk deals?" is about the investor. A fund
 * or an investor named beside what it did, or the Congress and deal pages named outright.
 * A question that asks what to do ("Should I buy Goldman Sachs?") is about the share. Pure.
 */
function isPageQuestion(question) {
  const q = String(question || '');
  if (require('./stockSnapshot').asksForAdvice(q)) return false;
  return PAGE_WORDS.test(q) || (ACTORS.test(q) && ACTIVITY.test(q));
}

/**
 * Which of `items` a typed name means. `namesOf(item)` gives every way it is written. An
 * exact name, then a lone name that contains the typed words or is contained in them;
 * several are handed back. Pure. → { item } | { matches: [...] } | { none: true }
 */
function pickNamed(typed, items, namesOf) {
  const q = key(typed);
  if (!q) return { none: true };
  const names = (it) => namesOf(it).map(key).filter(Boolean);
  const exact = items.filter((it) => names(it).includes(q));
  if (exact.length === 1) return { item: exact[0] };
  const loose = items.filter((it) => names(it).some((n) => ` ${n} `.includes(` ${q} `) || ` ${q} `.includes(` ${n} `)));
  if (loose.length === 1) return { item: loose[0] };
  return loose.length ? { matches: loose.slice(0, QA.PAGE_MATCHES) } : { none: true };
}

const tally = (rows, field) => rows.reduce((acc, r) => { const k = r[field] || 'unknown'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});

// One 13F position as Ask shows it. `total` = the filing's value, for the position's share. Pure.
function holdingRow(h, total, heldSet) {
  const value = num(h.value);
  return {
    issuer: unescape(h.issuer_name),
    ticker: h.ticker || null,
    value_usd: value,
    pct_of_fund: total > 0 && value != null ? round((value / total) * 100) : null,
    change: h.change_type === 'baseline' ? 'no earlier quarter to compare' : h.change_type,
    ...(h.ticker && heldSet.has(h.ticker) ? { held_by_user: true } : {}),
  };
}

// A congressional trade as Ask shows it. Pure.
function congressRow(t, heldSet) {
  return {
    politician: t.politician, chamber: t.chamber, ...(t.party ? { party: t.party } : {}),
    ticker: t.ticker || null, asset: t.ticker ? undefined : t.asset_description || null,
    action: t.transaction_type, amount: t.amount_range || null,
    traded: t.transaction_date, disclosed: t.disclosure_date,
    ...(t.ticker && heldSet.has(t.ticker) ? { held_by_user: true } : {}),
  };
}

// An NSE bulk or block deal, and an insider trade, as Ask shows them. Pure.
function dealRow(d, heldSet) {
  const investor = d.investor_slug && Object.hasOwn(INVESTOR_BY_SLUG, d.investor_slug) ? INVESTOR_BY_SLUG[d.investor_slug].name : null;
  return {
    client: d.client_name, ...(investor ? { investor } : {}), deal: d.deal_type, action: d.side,
    ticker: d.ticker, company: d.security_name || null,
    shares: num(d.quantity), price_inr: num(d.price), value_inr: d.value == null ? null : Math.round(Number(d.value)),
    traded: d.deal_date,
    ...(heldSet.has(d.ticker) ? { held_by_user: true } : {}),
  };
}
function insiderRow(t, heldSet) {
  return {
    person: t.person, category: t.category, how: t.mode, action: t.side, ticker: t.ticker, company: t.company || null,
    shares: num(t.quantity), value_inr: t.value == null ? null : Math.round(Number(t.value)),
    traded: t.trade_from, disclosed: t.disclosed_at,
    ...(heldSet.has(t.ticker) ? { held_by_user: true } : {}),
  };
}

// An alert as Ask shows it. The leading emoji is the page's decoration, not part of the text. Pure.
function alertRow(a) {
  return {
    when: new Date(a.created_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    type: a.alert_type, ticker: a.ticker === 'MARKET' ? null : a.ticker, sentiment: a.sentiment_label || null,
    message: String(a.message || '').replace(/^[^\p{L}\p{N}"'(]+/u, '').slice(0, QA.PAGE_ALERT_CHARS),
    read: !!a.read, sent: a.delivery || null,
  };
}

// The latest daily brief as Ask shows it. Pure.
function briefCard(b) {
  if (!b) return { brief: null, brief_note: 'No daily brief has been written for this account yet. It is written each morning; the AI Workspace page shows it.' };
  const text = String(b.narrative || '');
  return {
    brief: {
      date: b.brief_date, headline: b.headline || null,
      written_by: b.writer === 'claude' ? 'the AI writer' : 'code, from the day\'s figures',
      text: text.length > QA.PAGE_BRIEF_CHARS ? `${text.slice(0, QA.PAGE_BRIEF_CHARS)}… [cut]` : text,
    },
  };
}

// ── The four reads ──

// Institutions: the tracked funds, or one fund's latest filing and how it changed.
async function fundHoldings({ fund } = {}, ctx) {
  const { query, queryOne } = require('../db');
  const funds = await query(
    `SELECT i.id, i.name, i.slug, i.manager, f.id AS filing_id, f.period_of_report::text AS period_of_report,
            f.filed_at::text AS filed_at, f.holdings_count, f.total_value, (fe.id IS NOT NULL) AS following
       FROM institutions i
       LEFT JOIN LATERAL (SELECT * FROM institution_filings WHERE institution_id = i.id
                           ORDER BY period_of_report DESC NULLS LAST, id DESC LIMIT 1) f ON true
       LEFT JOIN followed_entities fe ON fe.user_id = $1 AND fe.entity_type = 'institution' AND fe.entity_ref = i.slug
      ORDER BY (fe.id IS NOT NULL) DESC, f.total_value DESC NULLS LAST, i.name`,
    [ctx.userId]
  );
  const card = (f) => ({ fund: f.name, manager: f.manager || null, quarter_end: f.period_of_report, filed: f.filed_at ? f.filed_at.slice(0, 10) : null,
    positions: f.holdings_count, total_value_usd: num(f.total_value), ...(f.following ? { followed_by_user: true } : {}) });

  if (!String(fund || '').trim()) {
    return { kind: 'fund_holdings', funds: funds.slice(0, rowCap(ctx, funds.length)).map(card), ...teaserNote(ctx),
      note: `These are the funds SenIQ tracks, the ones the user follows first. Pass a fund's name for its holdings. ${LAG_NOTE}` };
  }
  const found = pickNamed(fund, funds, (f) => [f.name, f.slug, f.manager]);
  if (found.none) return { error: `not_found: SenIQ tracks no fund called "${String(fund).slice(0, 60)}". It tracks: ${funds.map((f) => f.name).join(', ')}. Say so; do not describe that fund's holdings from memory.` };
  if (found.matches) return { kind: 'fund_holdings', matches: found.matches.map((f) => ({ fund: f.name, manager: f.manager })), note: 'Several tracked funds match. Ask the user which one they mean.' };
  const f = found.item;
  if (!f.filing_id) return { kind: 'fund_holdings', ...card(f), holdings: [], note: 'SenIQ has no filing stored for this fund yet.' };

  const total = num(f.total_value) || 0;
  const top = await query(
    `SELECT ticker, issuer_name, value, change_type FROM institution_holdings WHERE filing_id = $1 ORDER BY value DESC LIMIT $2`,
    [f.filing_id, rowCap(ctx, QA.PAGE_FUND_TOP)]);
  const counts = await query('SELECT change_type, count(*)::int AS n FROM institution_holdings WHERE filing_id = $1 GROUP BY 1', [f.filing_id]);
  const biggest = async (type) => (await query(
    `SELECT ticker, issuer_name, value, change_type FROM institution_holdings WHERE filing_id = $1 AND change_type = $2 ORDER BY value DESC LIMIT $3`,
    [f.filing_id, type, rowCap(ctx, QA.PAGE_FUND_CHANGES)])).map((h) => holdingRow(h, total, ctx.heldSet));
  const changes = Object.fromEntries(counts.map((c) => [c.change_type, c.n]));
  const compared = !(changes.baseline > 0 && Object.keys(changes).length === 1);
  const prior = await queryOne('SELECT count(*)::int AS n FROM institution_filings WHERE institution_id = $1', [f.id]);
  return {
    kind: 'fund_holdings', ...card(f),
    top_holdings: top.map((h) => holdingRow(h, total, ctx.heldSet)),
    ...(compared ? {
      changes_vs_prior_quarter: { new: changes.new || 0, added: changes.added || 0, reduced: changes.reduced || 0, unchanged: changes.unchanged || 0 },
      largest_new: await biggest('new'), largest_added: await biggest('added'), largest_reduced: await biggest('reduced'),
    } : { changes_note: 'This is the first quarter SenIQ has for the fund, so there is no earlier one to compare.' }),
    filings_stored: prior.n,
    ...teaserNote(ctx),
    note: `Top positions by value in the latest 13F, of ${f.holdings_count} in all. A 13F lists US-listed long positions only: no shorts, no cash, and a position sold out completely does not appear, so exits are not shown. ${LAG_NOTE}`,
  };
}

// Congress: one politician's trades, or the user's (held tickers and followed politicians), or everyone's.
async function politicianTrades({ politician, scope } = {}, ctx) {
  const { query } = require('../db');
  // Sample rows stand in only while there are no real disclosures; never mix the two.
  const live = (await query('SELECT count(*)::int AS n FROM congress_trades WHERE is_sample = false'))[0].n > 0;
  const recent = await query(
    `SELECT politician, chamber, party, ticker, asset_description, transaction_type, transaction_date::text AS transaction_date,
            disclosure_date::text AS disclosure_date, amount_range
       FROM congress_trades WHERE is_sample = $1
      ORDER BY disclosure_date DESC NULLS LAST, id DESC LIMIT 400`, [!live]);
  const sample = live ? {} : { sample_data: 'These are SAMPLE rows, not real disclosures: no live source is connected. Say so.' };
  const out = (rows, extra) => {
    const shown = rows.slice(0, rowCap(ctx, QA.PAGE_ROWS)).map((t) => congressRow(t, ctx.heldSet));
    return { kind: 'politician_trades', ...extra, trades_found: rows.length, summary: tally(rows.map((t) => ({ action: t.transaction_type })), 'action'),
      trades: shown, ...(rows.length > shown.length ? { not_shown: rows.length - shown.length } : {}), ...sample, ...teaserNote(ctx), note: LAG_NOTE };
  };

  if (String(politician || '').trim()) {
    const people = [...new Map(recent.map((t) => [polKey(t.politician), { name: t.politician, chamber: t.chamber, party: t.party }])).values()];
    const found = pickNamed(politician, people, (p) => [p.name, ...p.name.split(/\s+/).slice(-1)]);
    if (found.none) return { error: `not_found: none of the ${people.length} politicians in SenIQ's recent disclosures is called "${String(politician).slice(0, 60)}". Say so; do not describe their trades from memory.` };
    if (found.matches) return { kind: 'politician_trades', matches: found.matches, note: 'Several politicians match. Ask the user which one they mean.' };
    return out(recent.filter((t) => polKey(t.politician) === polKey(found.item.name)), { politician: found.item.name, chamber: found.item.chamber, party: found.item.party });
  }
  if (scope === 'all') return out(recent, { scope: 'all of Congress, newest disclosures first' });
  const followed = new Set((await query(`SELECT entity_ref FROM followed_entities WHERE user_id = $1 AND entity_type = 'politician'`, [ctx.userId])).map((r) => r.entity_ref));
  const mine = recent.filter((t) => (t.ticker && ctx.heldSet.has(t.ticker)) || followed.has(polKey(t.politician)));
  return out(mine, { scope: 'trades in the user\'s holdings, and by the politicians they follow', politicians_followed: followed.size });
}

// India: one curated investor's deals, or the user's (held Indian stocks and followed investors), or the whole market's.
async function indiaDeals({ investor, scope } = {}, ctx) {
  if (!FEATURES.INDIA_SMART_MONEY) return { kind: 'india_deals', available: false, note: 'The India side of the Institutions and Congress pages is not switched on for this installation, so there is nothing to read. Say so.' };
  const { query } = require('../db');
  const deals = await query(
    `SELECT deal_type, deal_date::text AS deal_date, ticker, security_name, client_name, investor_slug, side, quantity, price, value
       FROM india_deals ORDER BY deal_date DESC, value DESC, id DESC LIMIT $1`, [INDIA_SMART_MONEY.LIST_WINDOW]);
  const cut = (rows, n = QA.PAGE_ROWS) => rows.slice(0, rowCap(ctx, n));
  const left = (rows, shown) => (rows.length > shown.length ? { not_shown: rows.length - shown.length } : {});

  if (String(investor || '').trim()) {
    const found = pickNamed(investor, INDIA_INVESTORS, (i) => [i.name, i.slug, ...i.match]);
    if (found.none) return { error: `not_found: "${String(investor).slice(0, 60)}" is not one of the Indian investors SenIQ follows deals for. They are: ${INDIA_INVESTORS.map((i) => i.name).join(', ')}. Say so; do not describe that investor's deals from memory.` };
    if (found.matches) return { kind: 'india_deals', matches: found.matches.map((i) => ({ investor: i.name, kind: i.kind })), note: 'Several investors match. Ask the user which one they mean.' };
    const rows = deals.filter((d) => d.investor_slug === found.item.slug);
    const shown = cut(rows);
    return { kind: 'india_deals', investor: found.item.name, investor_kind: found.item.kind, deals_found: rows.length,
      deals: shown.map((d) => dealRow(d, ctx.heldSet)), ...left(rows, shown), ...teaserNote(ctx),
      note: `A deal is this investor's when the client name NSE reports contains its name; a deal under another name is not attributed. Looked at the newest ${deals.length} stored deals. ${INDIA_NOTE}` };
  }

  const insiders = await query(
    `SELECT ticker, company, person, category, mode, side, quantity, value, trade_from::text AS trade_from, disclosed_at::text AS disclosed_at
       FROM india_insider_trades ORDER BY disclosed_at DESC NULLS LAST, value DESC NULLS LAST, id DESC LIMIT $1`, [INDIA_SMART_MONEY.LIST_WINDOW]);
  let myDeals = deals;
  let myInsiders = insiders;
  let label = 'the whole market, newest first and largest first within a day';
  if (scope !== 'all') {
    const heldIn = new Set((await query(
      `SELECT DISTINCT p.ticker FROM portfolio p LEFT JOIN companies c ON c.ticker = p.ticker
        WHERE p.user_id = $1 AND (upper(coalesce(p.exchange, '')) IN ('NSE', 'BSE') OR (coalesce(p.exchange, '') = '' AND c.country = 'IN'))`, [ctx.userId])).map((r) => r.ticker));
    const followed = new Set((await query(`SELECT entity_ref FROM followed_entities WHERE user_id = $1 AND entity_type = 'in_investor'`, [ctx.userId])).map((r) => r.entity_ref));
    myDeals = deals.filter((d) => heldIn.has(d.ticker) || (d.investor_slug && followed.has(d.investor_slug)));
    myInsiders = insiders.filter((t) => heldIn.has(t.ticker));
    label = 'deals and insider trades in the user\'s Indian holdings, and deals by the investors they follow';
  }
  const half = Math.ceil(QA.PAGE_ROWS / 2);
  const shownDeals = cut(myDeals, half);
  const shownInsiders = cut(myInsiders, half);
  return {
    kind: 'india_deals', scope: label,
    deals_found: myDeals.length, deals: shownDeals.map((d) => dealRow(d, ctx.heldSet)),
    ...(myDeals.length > shownDeals.length ? { deals_not_shown: myDeals.length - shownDeals.length } : {}),
    insider_trades_found: myInsiders.length, insider_trades: shownInsiders.map((t) => insiderRow(t, ctx.heldSet)),
    ...(myInsiders.length > shownInsiders.length ? { insider_trades_not_shown: myInsiders.length - shownInsiders.length } : {}),
    ...teaserNote(ctx), note: INDIA_NOTE,
  };
}

// The user's own alerts and latest daily brief. Reads what is stored; it never writes a brief.
async function alertsAndBrief({ what } = {}, ctx) {
  const { query, queryOne } = require('../db');
  const out = { kind: 'alerts_and_brief' };
  if (what !== 'brief') {
    const rows = await query(
      `SELECT ticker, alert_type, sentiment_label, message, read, delivery, created_at
         FROM alerts WHERE user_id = $1 AND dismissed = false ORDER BY created_at DESC LIMIT $2`, [ctx.userId, what === 'alerts' ? QA.PAGE_ALERTS : QA.PAGE_ALERTS_WITH_BRIEF]);
    const c = await queryOne(
      `SELECT count(*) FILTER (WHERE NOT read AND NOT dismissed)::int AS unread,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week FROM alerts WHERE user_id = $1`, [ctx.userId]);
    Object.assign(out, { alerts_unread: c.unread, alerts_last_7_days: c.week, alerts: rows.map(alertRow),
      alerts_note: `The newest ${rows.length} alerts not dismissed, newest first. An alert is what SenIQ flagged for this user when it was created; it is not a current reading.` });
  }
  if (what !== 'alerts') {
    Object.assign(out, briefCard(await queryOne(
      `SELECT brief_date::text AS brief_date, headline, narrative, writer FROM daily_briefs WHERE user_id = $1 ORDER BY brief_date DESC LIMIT 1`, [ctx.userId])));
  }
  return out;
}

module.exports = { isPageQuestion, TRACKED_FUNDS, pickNamed, holdingRow, congressRow, dealRow, insiderRow, alertRow, briefCard, fundHoldings, politicianTrades, indiaDeals, alertsAndBrief };
