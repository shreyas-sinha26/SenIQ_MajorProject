/**
 * Grounding contract (Engine Phase E5) — the clean structured packet the analyst voice
 * writes from. Everything Claude says must trace back to a number in here; the diff
 * ("what changed since yesterday") is the ENGINE's job, not the model's.
 *
 * The packet per user:
 *   portfolio        — top-N holdings by exposure, each with current sentiment + z-score
 *   top_events       — top-N events by per-user impact (the North Star feed)
 *   most_important   — top_events[0]: "the single most important thing for the portfolio"
 *   smart_money      — recent institutional / congress activity touching held tickers
 *   changed          — diff vs yesterday's packet: new/dropped events, impact-rank moves,
 *                      sentiment swings (computed here, deterministically)
 *
 * Pure where it can be: buildDiff() takes two packets and returns the change set, so it's
 * unit-testable without a DB. buildGroundingPacket() is the DB-backed assembler.
 */

const { REPORTS, QA } = require('../config');
const { scoreTicker } = require('./sentimentScoring');
const { getImpactFeed } = require('./impactScoring');

const round = (n, d = 3) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/**
 * Diff today's packet against yesterday's. Pure — no DB. Returns the change set the
 * brief leads with. `prev` may be null (first brief / no history) → everything is "new".
 */
function buildDiff(today, prev) {
  const todayEvents = today.top_events || [];
  const prevEvents = (prev && prev.top_events) || [];
  const prevById = new Map(prevEvents.map((e) => [e.event_id, e]));
  const todayById = new Map(todayEvents.map((e) => [e.event_id, e]));

  const new_events = todayEvents
    .filter((e) => !prevById.has(e.event_id))
    .map((e) => ({ event_id: e.event_id, title: e.title, impact_score: e.impact_score, exposure_pct: e.exposure_pct, direction: e.direction }));

  const dropped_events = prevEvents
    .filter((e) => !todayById.has(e.event_id))
    .map((e) => ({ event_id: e.event_id, title: e.title }));

  // Impact-rank moves for events present both days (by position in the ranked feed).
  const prevRank = new Map(prevEvents.map((e, i) => [e.event_id, i]));
  const rank_changes = [];
  todayEvents.forEach((e, i) => {
    if (prevRank.has(e.event_id)) {
      const from = prevRank.get(e.event_id);
      if (from !== i) rank_changes.push({ event_id: e.event_id, title: e.title, from_rank: from + 1, to_rank: i + 1 });
    }
  });

  // Sentiment swings on held tickers (label flip or acute move ≥ 0.1).
  const prevSent = new Map(((prev && prev.portfolio && prev.portfolio.top_holdings) || []).map((h) => [h.ticker, h]));
  const sentiment_swings = [];
  for (const h of today.portfolio.top_holdings || []) {
    const p = prevSent.get(h.ticker);
    if (!p) continue;
    const flipped = p.sentiment_label !== h.sentiment_label;
    const moved = p.sentiment_acute != null && h.sentiment_acute != null && Math.abs(h.sentiment_acute - p.sentiment_acute) >= 0.1;
    if (flipped || moved) {
      sentiment_swings.push({
        ticker: h.ticker,
        from_label: p.sentiment_label, to_label: h.sentiment_label,
        from_acute: p.sentiment_acute, to_acute: h.sentiment_acute,
      });
    }
  }

  return { has_prior: !!prev, new_events, dropped_events, rank_changes, sentiment_swings };
}

function clamp(text, n = REPORTS.MAX_NEWS_CHARS) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Top holdings by exposure, enriched with current sentiment + sector.
// `raw` = preloaded getWeightedHoldings() rows, so callers that already priced the
// portfolio don't fetch quotes twice.
async function topHoldings(userId, limit = REPORTS.TOP_HOLDINGS, raw = null) {
  const { query } = require('../db');
  if (!raw) raw = await require('./portfolioService').getWeightedHoldings(userId);
  const sectorByTicker = {};
  for (const r of await query('SELECT ticker, sector, name FROM companies')) {
    sectorByTicker[r.ticker] = { sector: r.sector, name: r.name };
  }
  const sorted = raw.slice().sort((a, b) => (b.exposure_pct ?? 0) - (a.exposure_pct ?? 0)).slice(0, limit);
  const out = [];
  for (const h of sorted) {
    let s = null;
    try { s = await scoreTicker(h.ticker); } catch { s = null; }
    const ref = sectorByTicker[h.ticker] || {};
    out.push({
      ticker: h.ticker,
      name: ref.name || h.company_name || h.ticker,
      sector: ref.sector || null,
      exposure_pct: round(h.exposure_pct, 1),
      sentiment_label: s ? s.label : 'neutral',
      sentiment_acute: s ? s.acute.score : null,
      z: s ? s.baseline.z : null,
    });
  }
  return out;
}

// Recent smart-money activity touching the user's holdings (light, capped).
async function smartMoneyContext(userId) {
  const { query } = require('../db');
  const congress = await query(
    `SELECT c.politician, c.transaction_type, c.ticker, c.transaction_date
       FROM congress_trades c
      WHERE c.ticker IN (SELECT ticker FROM portfolio WHERE user_id = $1)
      ORDER BY c.disclosure_date DESC NULLS LAST, c.transaction_date DESC NULLS LAST
      LIMIT 3`,
    [userId]
  );
  const institutions = await query(
    `SELECT i.name, h.ticker, h.change_type
       FROM institution_holdings h
       JOIN institution_filings f ON f.id = h.filing_id
       JOIN institutions i ON i.id = f.institution_id
      WHERE h.ticker IN (SELECT ticker FROM portfolio WHERE user_id = $1)
        AND h.change_type IN ('new','added','reduced')
      ORDER BY h.value DESC NULLS LAST
      LIMIT 3`,
    [userId]
  );
  return {
    congress: congress.map((c) => ({ politician: c.politician, action: c.transaction_type, ticker: c.ticker, date: c.transaction_date })),
    institutions: institutions.map((r) => ({ name: r.name, ticker: r.ticker, change: r.change_type })),
  };
}

/**
 * Build the full grounding packet for a user, including the diff vs their last brief.
 * `prevPacket` (yesterday's stored packet) is passed in by the caller so this stays a
 * read-only assembler.
 */
async function buildGroundingPacket(userId, prevPacket = null, now = new Date()) {
  const feed = await getImpactFeed(userId, REPORTS.TOP_EVENTS);
  const top_events = feed.map((e) => ({
    event_id: e.event_id,
    title: clamp(e.title),
    impact_score: round(Number(e.impact_score)),
    exposure_pct: round(Number(e.exposure_pct), 1),
    direction: e.direction,
    source: e.source,
    last_seen: e.published_at,
  }));

  const holdings = await topHoldings(userId);
  const smart_money = await smartMoneyContext(userId);

  const packet = {
    user_id: userId,
    date: now.toISOString().slice(0, 10),
    portfolio: { holdings_count: holdings.length, top_holdings: holdings },
    top_events,
    most_important: top_events[0] || null,
    smart_money,
  };
  packet.changed = buildDiff(packet, prevPacket);
  return packet;
}

/**
 * Extended grounding context for Q&A (E6): ALL holdings (up to a cap) + the fuller impact
 * feed + sentiment + smart-money + today's return attribution, so a question like "what's my
 * biggest risk?" sees the whole portfolio, not just the top-N the daily brief leads with.
 * Used by the deterministic (no-Claude) answer path. Read-only.
 */
async function buildQAContext(userId, raw = null) {
  const { computeAttribution } = require('./qaTools');
  if (!raw) raw = await require('./portfolioService').getWeightedHoldings(userId);
  const feed = await getImpactFeed(userId, QA.TOP_EVENTS);
  const top_events = feed.map((e) => ({
    event_id: e.event_id,
    title: clamp(e.title),
    impact_score: round(Number(e.impact_score)),
    exposure_pct: round(Number(e.exposure_pct), 1),
    direction: e.direction,
    last_seen: e.published_at,
  }));
  const holdings = await topHoldings(userId, QA.MAX_HOLDINGS, raw);
  const smart_money = await smartMoneyContext(userId);
  return {
    user_id: userId,
    date: new Date().toISOString().slice(0, 10),
    portfolio: { holdings_count: holdings.length, holdings },
    attribution: computeAttribution(raw),
    top_events,
    most_important: top_events[0] || null,
    smart_money,
  };
}

module.exports = { buildGroundingPacket, buildQAContext, buildDiff, clamp };
