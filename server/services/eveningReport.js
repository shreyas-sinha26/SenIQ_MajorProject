/**
 * The end-of-day report (Pro) — what a user's markets did today and what came in about
 * their holdings. Sent at REPORT_EMAIL.EVENING on the user's own clock, every day.
 *
 * One of three things happens (decideOutcome):
 *   full   — at least one of their markets completed a session in the last day (crypto
 *            trades every day): the day's move, what drove it, the headlines.
 *   closed — nothing traded, but there are new stories about their holdings: a shorter
 *            report that says the markets were shut and lists them. No moves are shown —
 *            the last ones belong to an earlier day.
 *   skip   — nothing traded and nothing new: no report.
 *
 * "Today's move" is each holding's last COMPLETED session (marketSessions.js), which for an
 * Indian user holding US stocks is the New York session that closed overnight. Written by
 * code throughout — no model call.
 */

const MARKET_LABEL = { IN: 'India', US: 'United States', COMMODITY: 'Commodities', CRYPTO: 'Crypto' };
const DAY = 24 * 3600 * 1000;

const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const signed = (n, d = 2) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}%`;

/**
 * Pure: what the sessions add up to for this portfolio.
 * sessions = { TICKER: { market, session | null } } (marketSessions.sessionsFor).
 * → { traded, changeByTicker, markets: [{ market, label, date, fresh, inProgress }] }
 * changeByTicker: a completed session in the last day → its move; an older one → null (no
 * move to show today); no session data → absent (the ordinary quote is used).
 */
function planEvening(holdings, sessions, now = Date.now()) {
  const changeByTicker = {};
  const byMarket = new Map();
  let traded = false;
  for (const h of holdings || []) {
    const entry = (sessions || {})[h.ticker];
    if (!entry) continue;
    if (entry.market === 'CRYPTO') {
      traded = true;
      if (!byMarket.has('CRYPTO')) byMarket.set('CRYPTO', { market: 'CRYPTO', label: MARKET_LABEL.CRYPTO, date: null, fresh: true, inProgress: false });
      continue;
    }
    const s = entry.session;
    if (!s) continue;
    const fresh = s.endedAt <= now && now - s.endedAt <= DAY;
    changeByTicker[h.ticker] = fresh ? s.changePct : null;
    if (fresh) traded = true;
    const seen = byMarket.get(entry.market);
    if (!seen || s.date > seen.date) {
      byMarket.set(entry.market, { market: entry.market, label: MARKET_LABEL[entry.market] || entry.market, date: s.date, fresh, inProgress: !!s.inProgress });
    }
  }
  const order = ['IN', 'US', 'COMMODITY', 'CRYPTO'];
  const markets = [...byMarket.values()].sort((a, b) => order.indexOf(a.market) - order.indexOf(b.market));
  return { traded, changeByTicker, markets };
}

// Pure: which of the three reports this is.
function decideOutcome(traded, newStories) {
  if (traded) return 'full';
  return newStories > 0 ? 'closed' : 'skip';
}

// Pure: the headline and the paragraph under it.
function writeEvening(plan, insights, outcome) {
  const cards = (insights && insights.cards) || [];
  const stories = cards.length
    ? `${cards.length} new stor${cards.length === 1 ? 'y' : 'ies'} about your holdings ${cards.length === 1 ? 'is' : 'are'} set out below.`
    : 'No new story about your holdings cleared the bar today.';
  const dated = plan.markets.filter((m) => m.date);

  if (outcome === 'closed') {
    const last = dated.map((m) => `${m.label} last traded on ${longDate(m.date)}`).join('; ');
    return {
      headline: 'Markets were closed today',
      narrative: `None of the markets you hold traded today, so there is no move to report${last ? ` (${last})` : ''}. News kept coming: ${stories}`,
    };
  }

  const movers = (insights && insights.movers) || { rows: [], portfolio_change_pct: null };
  const move = movers.portfolio_change_pct;
  const headline = move == null ? 'End of day for your portfolio'
    : Math.abs(move) < 0.05 ? 'Your portfolio was flat in the latest session'
      : `Your portfolio ${move > 0 ? 'rose' : 'fell'} ${Math.abs(move).toFixed(2)}% in the latest session`;

  const parts = [];
  const sessionLines = dated.map((m) => (m.fresh
    ? `${m.label}: the session of ${longDate(m.date)}${m.inProgress ? ' (today\'s session is still open and is not counted)' : ''}`
    : `${m.label}: closed today, last traded on ${longDate(m.date)}`));
  if (plan.markets.some((m) => m.market === 'CRYPTO')) sessionLines.push('Crypto: the last 24 hours');
  if (sessionLines.length) parts.push(`This covers ${sessionLines.join('; ')}.`);
  const top = movers.rows.filter((r) => Math.abs(r.contribution_pct) >= 0.01).slice(0, 2);
  if (top.length) {
    parts.push(`The biggest pull${top.length > 1 ? 's were' : ' was'} ${top.map((r) =>
      `${r.ticker} ${signed(r.change_pct)} (${signed(r.contribution_pct)} of the portfolio)`).join(' and ')}.`);
  }
  parts.push(stories);
  return { headline, narrative: parts.join(' ') };
}

/**
 * Build tonight's report for one user. → { outcome: 'skip' } or the object
 * reportPdf.buildReportPdf draws (with outcome 'full' | 'closed').
 * deps for tests: { now, sessionsFn, holdingsFn, insightsFn, packetFn }.
 */
async function buildEveningReport(user, { dateLabel, market, marketLabel }, deps = {}) {
  const now = deps.now != null ? deps.now : Date.now();
  const holdingsFn = deps.holdingsFn || ((id) => require('./portfolioService').getWeightedHoldings(id));
  const sessionsFn = deps.sessionsFn || ((hs, o) => require('./marketSessions').sessionsFor(hs, o));
  const insightsFn = deps.insightsFn || ((id, o) => require('./reportInsights').buildReportInsights(id, o));
  const packetFn = deps.packetFn || ((id) => require('./grounding').buildGroundingPacket(id, null, new Date(now)));

  const holdings = await holdingsFn(user.id);
  const plan = planEvening(holdings, await sessionsFn(holdings, { now }), now);
  const insights = await insightsFn(user.id, { market, kind: 'evening', now, changeByTicker: plan.changeByTicker, since: now - DAY });
  const outcome = decideOutcome(plan.traded, ((insights && insights.cards) || []).length);
  if (outcome === 'skip') return { outcome };

  const packet = (await packetFn(user.id)) || {};
  const { headline, narrative } = writeEvening(plan, insights, outcome);
  return {
    kind: 'evening', outcome, name: user.name, dateLabel, marketLabel,
    headline, narrative, writer: 'deterministic',
    // The PDF prints `note` as its Summary (prose is kept for model-written text).
    note: `${headline}. ${narrative}`,
    events: packet.top_events || [], moreEvents: 0,
    holdings: (packet.portfolio && packet.portfolio.top_holdings) || [],
    changed: null, smartMoney: packet.smart_money || null,
    sessions: plan.markets,
    // On a closed day the last moves belong to an earlier date, so they are left out.
    insights: outcome === 'closed' && insights ? { ...insights, movers: { portfolio_change_pct: null, rows: [] }, divergences: [] } : insights,
  };
}

module.exports = { planEvening, decideOutcome, writeEvening, buildEveningReport, MARKET_LABEL };
