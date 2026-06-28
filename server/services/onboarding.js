/**
 * New-holding onboarding (Engine Phase E4) — "adding a holding feels smart".
 *
 * On add we do three things, none of which page the user about old news:
 *   1. Silent historical backfill — compute THIS user's impact over events already
 *      stored, so the new holding instantly shows recent context in the feed (no alerts).
 *   2. A short company brief — a deterministic packet assembled from engine data:
 *      the curated company reference (sector / exchange / country / key execs), the
 *      holding's recent events + current sentiment, light smart-money context, and the
 *      holding's impact if any. No Claude call here — the packet is shaped so E5's
 *      analyst voice can later turn it into prose.
 *   3. The monitoring-since watermark (set on the portfolio row at insert time) means
 *      only post-add events can alert — see materiality.js's watermark gate.
 *
 * Everything degrades gracefully: a holding outside the curated universe still gets a
 * brief (just without sector/exec enrichment), and a missing smart-money/sentiment
 * source just leaves that section thin rather than failing the add.
 */

const { ONBOARDING } = require('../config');
const { scoreTicker } = require('./sentimentScoring');
const { recomputeImpactsForUser } = require('./impactScoring');

const round = (n, d = 3) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// Curated company reference + key execs (null-safe for non-universe holdings).
async function loadCompany(ticker) {
  const { query, queryOne } = require('../db');
  const company = await queryOne(
    `SELECT ticker, name, aliases, sector, asset_class, exchange, country
       FROM companies WHERE ticker = $1`,
    [ticker]
  );
  const executives = await query(
    'SELECT full_name, role FROM executives WHERE ticker = $1 ORDER BY full_name',
    [ticker]
  );
  return { company, executives };
}

// The holding's recent durable events (last BRIEF_EVENT_DAYS), most important first.
async function loadRecentEventsForTicker(ticker) {
  const { query } = require('../db');
  return query(
    `SELECT e.id AS event_id, e.title, e.url, e.source, e.event_type, e.relevance_tier,
            e.importance, e.source_count, e.last_seen,
            avg(s.sentiment_score) AS sentiment_score
       FROM events e
       JOIN articles a ON a.event_id = e.id
       JOIN article_sentiments s ON s.article_id = a.id AND s.ticker = $1
      WHERE e.last_seen > now() - ($2 || ' days')::interval
      GROUP BY e.id, e.title, e.url, e.source, e.event_type, e.relevance_tier,
               e.importance, e.source_count, e.last_seen
      ORDER BY e.importance DESC NULLS LAST, e.last_seen DESC
      LIMIT $3`,
    [ticker, String(ONBOARDING.BRIEF_EVENT_DAYS), ONBOARDING.BRIEF_EVENTS]
  );
}

// Light smart-money context: big funds holding it + recent congress trades in it.
async function loadSmartMoney(ticker) {
  const { query } = require('../db');
  const limit = ONBOARDING.BRIEF_SMART_MONEY;
  const institutions = await query(
    `SELECT i.name, h.pct_of_portfolio, h.change_type
       FROM institution_holdings h
       JOIN institution_filings f ON f.id = h.filing_id
       JOIN institutions i ON i.id = f.institution_id
      WHERE h.ticker = $1
      ORDER BY h.value DESC NULLS LAST
      LIMIT $2`,
    [ticker, limit]
  );
  const congress = await query(
    `SELECT politician, chamber, party, transaction_type, transaction_date
       FROM congress_trades
      WHERE ticker = $1
      ORDER BY disclosure_date DESC NULLS LAST, transaction_date DESC NULLS LAST
      LIMIT $2`,
    [ticker, limit]
  );
  return { institutions, congress };
}

// This holding's current per-user impact row (if the backfill produced one).
async function loadHoldingImpact(userId, ticker) {
  const { queryOne } = require('../db');
  return queryOne(
    `SELECT e.id AS event_id, e.title, i.impact_score, i.exposure_pct, i.direction
       FROM event_portfolio_impact i
       JOIN events e ON e.id = i.event_id
       JOIN articles a ON a.event_id = e.id
       JOIN article_sentiments s ON s.article_id = a.id AND s.ticker = $2
      WHERE i.user_id = $1
      ORDER BY i.impact_score DESC
      LIMIT 1`,
    [userId, ticker]
  );
}

/**
 * Build the deterministic company brief packet for a held ticker.
 * Pure-ish: only reads (no writes), safe to call standalone for a GET endpoint too.
 */
async function buildCompanyBrief(userId, ticker, holding = {}) {
  const [{ company, executives }, events, sentimentRaw, smartMoney, impact] = await Promise.all([
    loadCompany(ticker),
    loadRecentEventsForTicker(ticker),
    scoreTicker(ticker).catch(() => null),
    loadSmartMoney(ticker).catch(() => ({ institutions: [], congress: [] })),
    loadHoldingImpact(userId, ticker).catch(() => null),
  ]);

  const sentiment = sentimentRaw
    ? {
        label: sentimentRaw.label,
        acute: sentimentRaw.acute.score,
        momentum: sentimentRaw.momentum.direction,
        baseline_z: sentimentRaw.baseline.z,
        magnitude: sentimentRaw.magnitude,
        points: sentimentRaw.baseline.points,
      }
    : null;

  return {
    ticker,
    in_universe: !!company,
    company: {
      name: company?.name || holding.company_name || ticker,
      sector: company?.sector || null,
      asset_class: company?.asset_class || holding.asset_class || null,
      exchange: company?.exchange || holding.exchange || null,
      country: company?.country || null,
      aliases: company?.aliases || [],
      executives: executives.map((e) => ({ name: e.full_name, role: e.role })),
    },
    sentiment,
    recent_events: events.map((e) => ({
      event_id: e.event_id,
      title: e.title,
      url: e.url,
      source: e.source,
      type: e.event_type,
      tier: e.relevance_tier,
      importance: round(Number(e.importance)),
      source_count: e.source_count,
      sentiment_score: round(Number(e.sentiment_score)),
      last_seen: e.last_seen,
    })),
    impact: impact
      ? { top_event: impact.title, impact_score: impact.impact_score, exposure_pct: impact.exposure_pct, direction: impact.direction }
      : null,
    smart_money: {
      institutions: smartMoney.institutions.map((r) => ({ name: r.name, pct_of_portfolio: r.pct_of_portfolio, change_type: r.change_type })),
      congress: smartMoney.congress.map((r) => ({ politician: r.politician, chamber: r.chamber, party: r.party, transaction: r.transaction_type, date: r.transaction_date })),
    },
    monitoring_since: holding.monitoring_since || null,
    note: 'Now monitoring from here on — older items below are recent context only and were not alerted.',
  };
}

/**
 * Full on-add flow: silent backfill (impact only, no alerts), then build the brief.
 * Best-effort — callers wrap this so a brief failure never blocks the add itself.
 */
async function onboardHolding(userId, ticker, holding = {}) {
  let backfilled = 0;
  try { backfilled = await recomputeImpactsForUser(userId); }
  catch (err) { console.error('onboardHolding backfill error:', err.message); }
  const brief = await buildCompanyBrief(userId, ticker, holding);
  return { brief, backfilled };
}

module.exports = { onboardHolding, buildCompanyBrief };
