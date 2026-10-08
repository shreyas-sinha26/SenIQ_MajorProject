/**
 * Report insights — the parts of a report that explain, not just list (reportPdf.js draws
 * them; reportEmails.js attaches them to a report).
 *
 *   cards         — the top headlines, each with three lines written by code from the
 *                   engine's own figures: why it matters to this portfolio (exposure and
 *                   the route it takes: direct holding, same sector, or market-wide), how
 *                   it affects it (the reading, how unusual it is, the usual pattern for
 *                   that kind of event), and how sure we are (sources, classifier confidence)
 *   verdict       — one line: is there anything to check today?
 *   movers        — each holding's latest move, its share of the portfolio's move, and the
 *                   news on it, if any
 *   divergences   — price going one way while the news goes the other
 *   concentration — where the portfolio is one bet
 *   trackRecord   — how earlier readings compared with the next day's price move
 *   coverage      — how much was read, and where it was thin
 *
 * No model call anywhere. The sentences describe pressure and typical patterns; they never
 * predict a price. Everything above buildReportInsights() is pure.
 */

const { EVENT_TYPES, REPORT_EMAIL, REPORTS } = require('../config');
const { impactForEvent, holdingLink } = require('./impactScoring');
const { storyTokens, regionOf, sameStory } = require('./materiality');

const round = (n, d = 1) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pctText = (n) => `${round(n, 1)}%`;
const signedPct = (n) => `${n >= 0 ? 'up' : 'down'} ${Math.abs(round(n, 1))}%`;
function listText(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// A USD amount in the report's currency: "$2,100" or "₹2,52,400". fx = { currency, rate }
// where rate is units of that currency per dollar. null when there is no value.
function money(usd, fx = {}) {
  if (usd == null || Number.isNaN(Number(usd))) return null;
  const inr = fx.currency === 'INR' && fx.rate > 0;
  const v = Number(usd) * (inr ? fx.rate : 1);
  const rounded = Math.abs(v) >= 1000 ? Math.round(v / 100) * 100 : Math.round(v);
  return (inr ? '₹' : '$') + rounded.toLocaleString(inr ? 'en-IN' : 'en-US');
}

const TYPE_LABEL = {
  ma: 'Deal', legal: 'Legal / regulatory', disruption: 'Disruption', earnings: 'Results',
  guidance: 'Outlook', executive: 'Leadership change', insider: 'Insider activity',
  macro: 'Market', product: 'Product', rating: 'Analyst rating', other: 'News', unknown: 'News',
};
// What that kind of event usually does. Worded as a tendency, never as a forecast.
const TYPE_PATTERN = {
  ma: 'Deal news tends to move a price sharply and at once, then again as terms become clear.',
  legal: 'Legal and regulatory stories tend to play out slowly; the first headline is rarely the last.',
  disruption: 'Disruptions weigh on a price until the size of the damage is known.',
  earnings: 'Results tend to move a price most on the day and the day after.',
  guidance: 'A change in outlook tends to work through a price over days rather than hours.',
  executive: 'A leadership change adds uncertainty until the successor and their plans are known.',
  insider: 'Insider and promoter activity is a signal about confidence, not a change in the business.',
  macro: 'Market-wide news tends to move many holdings a little rather than one holding a lot.',
  product: 'Product news usually matters over months, through sales, more than on the day.',
  rating: 'An analyst rating is an opinion, not a new fact; its effect usually fades within days.',
};
// A story that is talk rather than an event is labelled as such, and says so.
const STANCE_LABEL = { commentary: 'Commentary', roundup: 'Round-up' };
const STANCE_NOTE = {
  commentary: 'This is commentary or a preview, not a reported event.',
  roundup: 'This is a round-up that names the holding among others, not a story about it.',
};
const CHANNEL_LABEL = { direct: 'Direct holding', sector: 'Same sector', macro: 'Market-wide' };
const REGION_NAME = { IN: 'India', US: 'US' };

/**
 * Rank recent events for a portfolio and keep the ones worth a card.
 * holdings = [{ticker, exposure_pct, sector, country, market_value, change_pct}].
 * Each card: { event, channel, direction, impact, strength, passed, links:[{ticker,
 * relation, exposure_pct, market_value, score, confidence}], region }.
 *
 * A story about a holding or its sector earns a card when its strength clears the bar
 * (REPORT_EMAIL.CARDS) and it touches enough of the portfolio — so a busy day shows more
 * cards and a quiet one fewer, up to `max`. If fewer than `min` clear the bar, the best of
 * the rest fill in as background. Market-wide stories take what is left: one beside
 * specific stories, two when there are none, and only when the portfolio holds something
 * in that market. The same story is carried once. Cards are ordered by impact.
 */
function pickCards(events, holdings, zByTicker = {}, opts = {}) {
  const { now = Date.now(), max = REPORT_EMAIL.CARDS.MAX, min = REPORT_EMAIL.CARDS.MIN,
    bar = REPORT_EMAIL.CARDS.BAR, minExposure = REPORT_EMAIL.CARDS.MIN_EXPOSURE_PCT } = opts;
  const scored = [];
  for (const event of events || []) {
    const { impact, exposure_pct, direction } = impactForEvent(event, holdings, zByTicker, now);
    if (!(impact > 0)) continue;
    const region = regionOf(event.title, event.source);
    let links = [];
    for (const h of holdings) {
      const link = holdingLink(event, h);
      if (!link) continue;
      // A market-wide story about one country bears on the holdings listed there.
      if (link.relation === 'macro' && REGION_NAME[region] && h.country !== region) continue;
      const own = event.tickers[h.ticker];
      links.push({
        ticker: h.ticker, relation: link.relation, exposure_pct: h.exposure_pct || 0,
        market_value: h.market_value ?? null, change_pct: h.change_pct ?? null,
        score: own ? own.score : null, confidence: own ? own.confidence : null,
      });
    }
    if (!links.length) continue;
    links = links.sort((a, b) => b.exposure_pct - a.exposure_pct);
    const channel = links.some((l) => l.relation === 'direct') ? 'direct' : links.some((l) => l.relation === 'sector') ? 'sector' : 'macro';
    // Impact per unit of (relevance-weighted) exposure: how strong the story is, whatever
    // the size of the position it lands on.
    const strength = exposure_pct > 0 ? impact / (exposure_pct / 100) : 0;
    const touched = sum(links.filter((l) => l.relation !== 'macro').map((l) => l.exposure_pct));
    const passed = channel !== 'macro' && strength >= bar && touched >= minExposure;
    scored.push({ event, channel, direction, impact, strength: round(strength, 2), passed, links, region });
  }
  scored.sort((a, b) => b.impact - a.impact);

  const kept = [];
  for (const c of scored) {
    const member = { tokens: storyTokens(c.event.title), region: c.region };
    if (kept.some((k) => sameStory(k.member, member))) continue;
    kept.push({ ...c, member });
  }
  const specificAll = kept.filter((c) => c.channel !== 'macro');
  let specific = specificAll.filter((c) => c.passed).slice(0, max);
  if (specific.length < Math.min(min, max)) {
    const fill = specificAll.filter((c) => !c.passed).slice(0, Math.min(min, max) - specific.length);
    specific = [...specific, ...fill].sort((a, b) => b.impact - a.impact);
  }
  const broadSlots = specific.length ? Math.min(1, max - specific.length) : Math.min(2, max);
  const broad = kept.filter((c) => c.channel === 'macro').slice(0, broadSlots);
  return [...specific, ...broad].map(({ member, ...c }) => c);
}

// The three lines for one card. ctx = { fx, zByTicker, sectorByTicker }. Pure.
function explainCard(card, ctx = {}) {
  const { event, channel, links, region } = card;
  const fx = ctx.fx || {};
  const share = (ls) => sum(ls.map((l) => l.exposure_pct));
  const value = (ls) => (ls.every((l) => l.market_value != null) ? money(sum(ls.map((l) => l.market_value)), fx) : null);
  const withValue = (ls) => `${pctText(share(ls))} of your portfolio${value(ls) ? ` (${value(ls)})` : ''}`;
  const names = (ls) => listText(ls.slice(0, 4).map((l) => l.ticker));
  const direct = links.filter((l) => l.relation === 'direct');
  const peers = links.filter((l) => l.relation === 'sector');
  const broad = links.filter((l) => l.relation === 'macro');

  let why;
  if (channel === 'direct') {
    why = `You hold ${names(direct)} directly: ${withValue(direct)}.`;
    if (peers.length) why += ` ${names(peers)} (${pctText(share(peers))}) ${peers.length === 1 ? 'is' : 'are'} in the same sector and can move with it.`;
  } else if (channel === 'sector') {
    const sector = (ctx.sectorByTicker || {})[peers[0].ticker];
    why = `You do not hold the company in this story. ${names(peers)}, ${withValue(peers)}, ${peers.length === 1 ? 'is' : 'are'} in the same sector${sector ? ` (${sector})` : ''}, so the link is indirect.`;
  } else {
    const where = REGION_NAME[region] ? `your ${REGION_NAME[region]}-listed holdings as a group` : 'the portfolio as a whole';
    why = `This is a market-wide story, not about a company you hold. It bears on ${where}: ${names(broad)}, ${withValue(broad)}. The link is indirect.`;
  }

  const parts = [];
  if (channel === 'direct') {
    const lead = direct[0];
    const reads = lead.score == null ? card.direction : lead.score > 0.55 ? 'positive' : lead.score < 0.45 ? 'negative' : 'mixed';
    parts.push(`Coverage of ${lead.ticker} in this story reads ${reads === 'neutral' ? 'mixed' : reads}.`);
    const z = (ctx.zByTicker || {})[lead.ticker];
    if (z != null && Math.abs(z) >= 1) parts.push(`News on ${lead.ticker} is running well ${z > 0 ? 'above' : 'below'} its own 90-day normal.`);
    else if (z != null && Math.abs(z) < 0.5) parts.push(`News on ${lead.ticker} overall is in its usual range.`);
    if (lead.change_pct != null && Math.abs(lead.change_pct) >= 0.1) parts.push(`${lead.ticker} is ${signedPct(lead.change_pct)} in the latest session.`);
  } else {
    parts.push(`The story reads ${card.direction === 'neutral' ? 'mixed' : card.direction} overall.`);
  }
  const pattern = TYPE_PATTERN[channel === 'macro' ? 'macro' : event.event_type];
  if (pattern) parts.push(pattern);

  const sources = Number(event.source_count) || 1;
  const confs = direct.map((l) => l.confidence).filter((c) => c != null);
  const conf = confs.length ? sum(confs) / confs.length : null;
  const sure = [
    sources === 1 ? 'One source so far, so treat it as unconfirmed.' : `${sources} sources carry this story.`,
    conf == null ? null : conf >= 0.8 ? 'The sentiment reading is clear-cut.' : conf >= 0.6 ? 'The sentiment reading is fairly clear.' : 'The sentiment reading is uncertain: the coverage is mixed.',
    STANCE_NOTE[event.stance] || null,
  ].filter(Boolean).join(' ');

  // Worth the reader's attention: a reported event about something they hold, read as clearly good or bad,
  // and backed by more than one headline's say-so — several sources, a reading far from
  // that holding's normal, or a heavy kind of event with a clear reading.
  const z0 = direct.length ? (ctx.zByTicker || {})[direct[0].ticker] : null;
  const heavy = (EVENT_TYPES.SEVERITY[event.event_type] ?? 0) >= 0.8;
  const reported = !event.stance || event.stance === 'event';   // not someone's view of one
  const needs_attention = reported && channel === 'direct' && card.direction !== 'neutral' &&
    (sources >= 2 || (z0 != null && Math.abs(z0) >= 1) || (heavy && conf != null && conf >= 0.6));

  return {
    needs_attention,
    event_id: event.event_id, title: event.title, source: event.source, last_seen: event.last_seen,
    type_label: STANCE_LABEL[event.stance] || TYPE_LABEL[event.event_type] || TYPE_LABEL.other,
    stance: event.stance || 'event',
    channel, channel_label: CHANNEL_LABEL[channel], direction: card.direction,
    exposure_pct: round(share(channel === 'direct' ? direct : channel === 'sector' ? peers : broad), 1),
    why, how: parts.join(' '), sure,
  };
}

// The line the report opens with, from the cards' needs_attention flags (explainCard).
// Sector and market stories, and thinly backed ones, are background.
function verdictFor(cards, kind = 'daily') {
  const when = kind === 'weekly' ? 'this week' : 'today';
  const check = (cards || []).filter((c) => c.needs_attention);
  if (!check.length) {
    return {
      level: 'calm', count: 0,
      text: `Nothing specific to your holdings needs your attention ${when}.`,
      detail: (cards || []).length
        ? 'The stories below are background: single-source, routine or indirectly linked to what you own.'
        : 'No story cleared the bar for your holdings.',
    };
  }
  return {
    level: 'check', count: check.length,
    text: `${check.length} thing${check.length === 1 ? '' : 's'} to check ${when}`,
    detail: check[0].title,
  };
}

/**
 * Each priced holding's latest move and its share of the portfolio's move, with the news
 * on that holding if there is any. Sorted by the size of the contribution.
 * directNews = { TICKER: headline } — the highest-impact recent story naming the holding.
 */
function buildMovers(holdings, directNews = {}) {
  const rows = (holdings || [])
    .filter((h) => h.change_pct != null && h.weight_pct != null)
    .map((h) => ({
      ticker: h.ticker, change_pct: round(h.change_pct, 2), weight_pct: h.weight_pct,
      contribution_pct: round((h.weight_pct * h.change_pct) / 100, 2),
      news: directNews[h.ticker] || null,
    }))
    .sort((a, b) => Math.abs(b.contribution_pct) - Math.abs(a.contribution_pct));
  return { portfolio_change_pct: rows.length ? round(sum(rows.map((r) => r.contribution_pct)), 2) : null, rows };
}

// Price and news pulling apart on one holding: a move of 1% or more against a negative or
// positive reading (by label, or by a full standard deviation from that holding's normal).
function findDivergences(holdings) {
  const out = [];
  for (const h of holdings || []) {
    if (h.change_pct == null || Math.abs(h.change_pct) < 1) continue;
    const newsDown = h.sentiment_label === 'negative' || (h.z != null && h.z <= -1);
    const newsUp = h.sentiment_label === 'positive' || (h.z != null && h.z >= 1);
    if (h.change_pct > 0 && newsDown && !newsUp) out.push({ ticker: h.ticker, text: `${h.ticker} is ${signedPct(h.change_pct)} while the news on it reads negative.` });
    else if (h.change_pct < 0 && newsUp && !newsDown) out.push({ ticker: h.ticker, text: `${h.ticker} is ${signedPct(h.change_pct)} while the news on it reads positive.` });
  }
  return out;
}

// Where the portfolio is one bet: a holding at 30% or more, or two or more holdings in one
// sector adding up to 40% or more. `split` is the share by market, always shown.
function findConcentration(holdings) {
  const hs = (holdings || []).filter((h) => h.exposure_pct > 0);
  const lines = [];
  const top = hs.slice().sort((a, b) => b.exposure_pct - a.exposure_pct)[0];
  if (top && top.exposure_pct >= 30 && hs.length > 1) lines.push(`${top.ticker} alone is ${pctText(top.exposure_pct)} of your portfolio, so it drives much of your result.`);
  const bySector = {};
  for (const h of hs) if (h.sector && h.asset_class === 'equity') (bySector[h.sector] ||= []).push(h);
  for (const [sector, group] of Object.entries(bySector)) {
    const share = sum(group.map((h) => h.exposure_pct));
    if (group.length >= 2 && share >= 40) lines.push(`${listText(group.map((h) => h.ticker))} are all ${sector}: ${pctText(share)} of your portfolio tends to move together.`);
  }
  const bucket = (h) => (h.asset_class === 'crypto' ? 'Crypto' : h.asset_class === 'commodity' ? 'Commodities'
    : h.country === 'IN' ? 'India-listed' : h.country === 'US' ? 'US-listed' : 'Other');
  const shares = {};
  for (const h of hs) shares[bucket(h)] = (shares[bucket(h)] || 0) + h.exposure_pct;
  const split = Object.entries(shares).map(([label, pct]) => ({ label, pct: round(pct, 1) })).sort((a, b) => b.pct - a.pct);
  return { lines, split };
}

/**
 * Grade earlier readings against the next day's price. rows = [{ticker, sentiment_score,
 * move_1d (fraction), first_seen}]. A day's average reading above 0.55 or below 0.45 is a
 * call; a move under 0.25% either way is "no clear move"; the rest match or miss. Pure.
 * `mine` lists the graded rows for the user's own holdings, newest first.
 */
function gradeCalls(rows, heldTickers = []) {
  const held = new Set(heldTickers);
  // One call per ticker per day: several headlines on one day share one price move, so
  // they are averaged into a single reading rather than counted as separate calls.
  const days = new Map();
  for (const r of rows || []) {
    const s = Number(r.sentiment_score);
    const m = Number(r.move_1d);
    if (r.sentiment_score == null || r.move_1d == null || Number.isNaN(s) || Number.isNaN(m)) continue;
    const day = new Date(r.first_seen).toISOString().slice(0, 10);
    const key = `${r.ticker}|${day}`;
    if (!days.has(key)) days.set(key, { ticker: r.ticker, day, scores: [], moves: [], stories: 0 });
    const d = days.get(key);
    d.scores.push(s); d.moves.push(m); d.stories++;
  }
  const graded = [];
  for (const d of days.values()) {
    const s = sum(d.scores) / d.scores.length;
    const m = sum(d.moves) / d.moves.length;
    if (s >= 0.45 && s <= 0.55) continue;
    const call = s > 0.55 ? 'positive' : 'negative';
    const result = Math.abs(m) < 0.0025 ? 'flat' : (m > 0) === (call === 'positive') ? 'matched' : 'missed';
    graded.push({ ticker: d.ticker, day: d.day, stories: d.stories, call, move_pct: round(m * 100, 2), result });
  }
  graded.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const count = (res) => graded.filter((g) => g.result === res).length;
  return {
    calls: graded.length, matched: count('matched'), missed: count('missed'), flat: count('flat'),
    mine: graded.filter((g) => held.has(g.ticker)).slice(0, 5),
  };
}

// "Read 212 articles on your holdings in the last 3 days. Thin coverage: X, Y." Pure.
function coverageNote(countsByTicker, tickers) {
  const total = sum(tickers.map((t) => countsByTicker[t] || 0));
  const thin = tickers.filter((t) => (countsByTicker[t] || 0) <= 2);
  return {
    total, thin,
    text: `SenIQ read ${total} article${total === 1 ? '' : 's'} on your holdings in the last 3 days.` +
      (thin.length ? ` Coverage was thin (2 or fewer) on ${listText(thin)}, so readings there are less reliable.` : ''),
  };
}

/**
 * Assemble every insight for one user. Read-only; prices come from the cached quote
 * service. market = 'IN' | 'US' sets the currency amounts are shown in.
 */
async function buildReportInsights(userId, { market = 'US', kind = 'daily', maxCards = REPORT_EMAIL.CARDS.MAX, now = Date.now() } = {}) {
  const { query } = require('../db');
  const { getWeightedHoldings } = require('./portfolioService');
  const { usdRates } = require('./priceService');
  const { loadRecentEvents } = require('./impactScoring');
  const { scoreTicker } = require('./sentimentScoring');

  const raw = await getWeightedHoldings(userId);
  if (!raw.length) return null;
  const tickers = raw.map((h) => h.ticker);
  const ref = Object.fromEntries((await query('SELECT ticker, sector, country FROM companies WHERE ticker = ANY($1)', [tickers])).map((r) => [r.ticker, r]));
  const zByTicker = {};
  const labelByTicker = {};
  for (const t of tickers) {
    try { const s = await scoreTicker(t); zByTicker[t] = s.baseline.z; labelByTicker[t] = s.label; }
    catch { zByTicker[t] = null; labelByTicker[t] = null; }
  }
  const holdings = raw.map((h) => ({
    ticker: h.ticker, asset_class: h.asset_class, exposure_pct: h.exposure_pct ?? 0, weight_pct: h.weight_pct,
    market_value: h.market_value, change_pct: h.change_pct,
    sector: ref[h.ticker]?.sector || null,
    country: ref[h.ticker]?.country || (['NSE', 'BSE'].includes(String(h.exchange || '').toUpperCase()) ? 'IN' : h.asset_class === 'equity' ? 'US' : 'GLOBAL'),
    z: zByTicker[h.ticker], sentiment_label: labelByTicker[h.ticker],
  }));

  let fx = { currency: 'USD', rate: 1 };
  if (market === 'IN') {
    const rate = (await usdRates(['INR'])).INR;
    if (rate) fx = { currency: 'INR', rate };
  }

  const events = await loadRecentEvents();
  const picked = pickCards(events, holdings, zByTicker, { now, max: maxCards });
  const sectorByTicker = Object.fromEntries(holdings.map((h) => [h.ticker, h.sector]));
  const cards = picked.map((c) => explainCard(c, { fx, zByTicker, sectorByTicker }));

  // What the articles behind each card say, for the written layer (cardWriter.js) only:
  // the template lines never use it and the PDF does not print it.
  if (cards.length) {
    const rows = await query(
      `SELECT event_id, summary FROM articles
        WHERE event_id = ANY($1) AND summary IS NOT NULL AND length(summary) >= 40
        ORDER BY importance DESC NULLS LAST, published_at DESC`, [cards.map((c) => c.event_id)]);
    const byEvent = {};
    for (const r of rows) {
      const list = (byEvent[r.event_id] ||= []);
      const text = String(r.summary).replace(/\s+/g, ' ').trim().slice(0, REPORTS.CARDS.MAX_SUMMARY_CHARS);
      if (list.length < REPORTS.CARDS.SUMMARIES_PER_CARD && !list.includes(text)) list.push(text);
    }
    for (const c of cards) c.summary = (byEvent[c.event_id] || []).join(' ') || null;
  }

  // The news shown beside a holding's move: the highest-impact recent story naming it.
  const directNews = {};
  const byImpact = events
    .map((e) => ({ e, impact: impactForEvent(e, holdings, zByTicker, now).impact }))
    .sort((a, b) => b.impact - a.impact);
  const usedStories = [];
  const bySize = holdings.slice().sort((a, b) => b.exposure_pct - a.exposure_pct).map((h) => h.ticker);
  for (const { e } of byImpact) {
    const member = { tokens: storyTokens(e.title), region: regionOf(e.title, e.source) };
    // One story explains one holding: the first (largest) holding it names that has none yet.
    if (usedStories.some((u) => sameStory(u, member))) continue;
    const t = bySize.find((x) => e.tickers[x] && !directNews[x]);
    if (t) { directNews[t] = e.title; usedStories.push(member); }
  }

  // Only readings whose next-day price was captured at least 20 hours after the first.
  const outcomes = await query(
    `SELECT eo.primary_ticker AS ticker, eo.sentiment_score, eo.move_1d, eo.first_seen
       FROM event_outcomes eo
      WHERE eo.move_1d IS NOT NULL AND eo.resolved_1d_at - eo.logged_at >= interval '20 hours'
        AND eo.first_seen > now() - interval '14 days'
      ORDER BY eo.first_seen DESC`);
  const counts = Object.fromEntries((await query(
    `SELECT s.ticker, count(DISTINCT a.id)::int AS n
       FROM article_sentiments s JOIN articles a ON a.id = s.article_id
      WHERE s.ticker = ANY($1) AND a.published_at > now() - interval '72 hours'
      GROUP BY s.ticker`, [tickers])).map((r) => [r.ticker, r.n]));

  const totalValue = raw.every((h) => h.market_value != null) ? sum(raw.map((h) => h.market_value)) : null;
  return {
    verdict: verdictFor(cards, kind),
    cards,
    movers: buildMovers(holdings, directNews),
    divergences: findDivergences(holdings),
    concentration: findConcentration(holdings),
    trackRecord: gradeCalls(outcomes, tickers),
    coverage: coverageNote(counts, tickers),
    portfolio_value: money(totalValue, fx),
  };
}

module.exports = {
  buildReportInsights, pickCards, explainCard, verdictFor, buildMovers, findDivergences,
  findConcentration, gradeCalls, coverageNote, money,
};
