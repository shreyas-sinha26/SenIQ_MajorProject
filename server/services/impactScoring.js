/**
 * Portfolio Impact Scoring (Phase 2e + E2 6-factor) — the North Star.
 *
 * The differentiator is NOT "Tesla sentiment is negative" but exposure-weighted
 * impact on the user's OWN portfolio: "this event affects 18% of your exposure /
 * today's most important event for you." Core unit = event → portfolio impact.
 *
 *   impact(holding) = exposure × relevance × severity × novelty × confidence × recency × stance
 *
 *   exposure  : the holding's % weight (portfolioService)               0..1
 *   relevance : 1.0 direct hold · SECTOR_RELEVANCE sector · MACRO_BROAD_FACTOR market-wide
 *               (a market-wide story reaches only the holdings listed in its market, and
 *               counts at macro severity whatever its own event type)
 *   severity  : event-type weight × sentiment magnitude (|score-0.5|×2) 0..1 (the core)
 *   novelty   : z-surprise vs the asset's 90-day baseline   (mult ~0.8..1.2; null→1.0)
 *   confidence: classifier/source confidence                (mult CONFIDENCE_FLOOR..1)
 *   recency   : time decay on the event's last_seen          (mult RECENCY_FLOOR..1)
 *   stance    : a reported event 1.0 · commentary / preview 0.6 · round-up 0.4
 *
 * Recomputed each cron pass; results land in event_portfolio_impact and drive the
 * per-user ranked feed (GET /api/news/impact).
 */

// db + portfolioService are lazy-required inside the async functions so the pure
// scoring math (impactForEvent + factors) stays importable/testable without a database.
const { IMPACT, EVENT_TYPES, SENTIMENT, MATERIALITY } = require('../config');
const { scoreTicker } = require('./sentimentScoring');
const { regionOf, storyTokens, feedTokens, HOLDING_TOPICS, sameStory } = require('./materiality');
const { classifyStance } = require('./eventTyping');

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

// Pull recent durable events with per-ticker sentiment + type/sectors for scoring.
async function loadRecentEvents() {
  const { query } = require('../db');
  const rows = await query(
    `SELECT e.id AS event_id, e.title, e.url, e.source, e.relevance_tier, e.event_type,
            e.sectors, e.last_seen, e.source_count, e.importance, e.first_seen,
            s.ticker, avg(s.sentiment_score) AS score, max(s.confidence) AS confidence,
            bool_or(a.platform = 'macro') AS is_macro
       FROM events e
       JOIN articles a ON a.event_id = e.id
       JOIN article_sentiments s ON s.article_id = a.id
      WHERE e.last_seen > now() - ($1 || ' hours')::interval
      GROUP BY e.id, e.title, e.url, e.source, e.relevance_tier, e.event_type, e.sectors, e.last_seen, e.source_count, e.importance, e.first_seen, s.ticker`,
    [String(IMPACT.EVENT_WINDOW_HOURS)]
  );

  // "Tata Motors says…" is the company speaking; "Hunter Biden says…" is a view.
  const isCompany = await companyNamer();
  const events = new Map();
  for (const r of rows) {
    let ev = events.get(r.event_id);
    if (!ev) {
      ev = {
        event_id: r.event_id,
        title: r.title,
        url: r.url,
        source: r.source,
        event_type: r.event_type,
        sectors: r.sectors || [],
        source_count: r.source_count,
        importance: Number(r.importance) || 0,
        first_seen: r.first_seen,
        region: regionOf(r.title, r.source),   // which market a broad story is about
        stance: classifyStance(r.title, isCompany),
        last_seen: r.last_seen,
        published_at: r.last_seen,
        tickers: {},
        isMacro: r.relevance_tier === 'market' || r.relevance_tier === 'world',
      };
      events.set(r.event_id, ev);
    }
    if (r.is_macro) ev.isMacro = true;
    if (r.ticker === '__MARKET__') {
      ev.isMacro = true;
      ev.macroScore = Number(r.score);
    } else if (r.ticker) {
      ev.tickers[r.ticker] = { score: Number(r.score), confidence: Number(r.confidence) };
    }
  }
  return tagMarketStories([...events.values()]);
}

// → (text) => does it name a tracked company or one of its executives? Never throws.
async function companyNamer() {
  try {
    const index = await require('./entityResolver').loadIndex();
    return (text) => index.resolve(String(text), '').tickers.length > 0;
  } catch {
    return () => false;
  }
}

// Group the market-wide events into stories and stamp each with its story's coverage, so a
// story many outlets are writing about counts for more than a lone headline. The grouping
// is the feed's own (collapseStories): each headline joins the story whose lead it matches,
// so what is scored as one story is what is shown as one story. Pure.
function tagMarketStories(events) {
  const broad = events
    .filter((e) => e.isMacro && Object.keys(e.tickers).length === 0)
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (Number(b.source_count) || 1) - (Number(a.source_count) || 1) ||
      new Date(a.first_seen || 0) - new Date(b.first_seen || 0));
  const stories = []; // { member, events }
  for (const ev of broad) {
    const member = { tokens: feedTokens(ev.title), region: ev.region || regionOf(ev.title, ev.source) };
    const home = stories.find((st) => sameStory(st.member, member, { anchors: true }));
    if (home) home.events.push(ev); else stories.push({ member, events: [ev] });
  }
  for (const story of stories) {
    const coverage = story.events.reduce((a, e) => a + (Number(e.source_count) || 1), 0);
    for (const ev of story.events) { ev.story_coverage = coverage; ev.story_headlines = story.events.length; }
  }
  return events;
}

// The relevance multiplier for a market story of a given coverage (see IMPACT in config).
function coverageMult(coverage) {
  const c = Math.max(1, Number(coverage) || 1);
  return Math.min(IMPACT.MACRO_COVERAGE_MAX, 1 + IMPACT.MACRO_COVERAGE_GAIN * Math.log2(c));
}

function dirLabel(signed) {
  if (signed > 0.02) return 'positive';
  if (signed < -0.02) return 'negative';
  return 'neutral';
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function avgScore(event) { return avg(Object.values(event.tickers).map((t) => t.score)); }
function avgConf(event) { return avg(Object.values(event.tickers).map((t) => t.confidence)); }

// ── the six factors ──
function noveltyMult(z) {
  if (z == null) return 1.0; // unknown surprise → neutral
  return IMPACT.NOVELTY_BASE + IMPACT.NOVELTY_GAIN * (Math.min(Math.abs(z), 3) / 3);
}
function confidenceMult(conf) {
  return IMPACT.CONFIDENCE_FLOOR + (1 - IMPACT.CONFIDENCE_FLOOR) * Math.min(1, Math.max(0, conf || 0));
}
function recencyMult(lastSeen, now) {
  const ageH = (now - new Date(lastSeen).getTime()) / 3_600_000;
  const decay = Math.pow(0.5, Math.max(0, ageH) / SENTIMENT.HALF_LIFE_HOURS);
  return IMPACT.RECENCY_FLOOR + (1 - IMPACT.RECENCY_FLOOR) * decay;
}

// Which market a holding belongs to, for matching market-wide stories: 'IN' | 'US' for
// stocks, 'GLOBAL' for crypto and commodities (they follow no single country's story).
function holdingRegion(h, country) {
  if (h.asset_class && h.asset_class !== 'equity') return 'GLOBAL';
  const ex = String(h.exchange || '').toUpperCase();
  if (country === 'IN' || ex === 'NSE' || ex === 'BSE') return 'IN';
  return country && country !== 'US' ? 'GLOBAL' : 'US';
}

// How an event reaches one holding — its strongest connection: the holding is named in
// it, shares a sector with it, or the story is market-wide. null = no connection. Pure.
// A market-wide story about one country (event.region 'IN' | 'US') reaches only holdings
// in that market; a holding with no region given is treated as reachable.
function holdingLink(event, h) {
  if (event.tickers[h.ticker]) return { relation: 'direct', relevance: 1.0 };
  if (h.sector && (event.sectors || []).includes(h.sector)) return { relation: 'sector', relevance: IMPACT.SECTOR_RELEVANCE };
  if (event.isMacro) {
    const market = event.region === 'IN' || event.region === 'US' ? event.region : null;
    const where = h.region || h.country || null;
    if (market && where && where !== market) return null;
    return { relation: 'macro', relevance: IMPACT.MACRO_BROAD_FACTOR * coverageMult(event.story_coverage) };
  }
  return null;
}

/**
 * One user's impact for one event. `holdings` = [{ticker, exposure_pct, sector, region}].
 * Each holding is scored by its strongest connection to the event:
 * direct ticker > sector match > macro-broad. Pure (now injectable for tests).
 */
function impactForEvent(event, holdings, zByTicker, now = Date.now()) {
  const severity = EVENT_TYPES.SEVERITY[event.event_type] ?? EVENT_TYPES.SEVERITY.other;
  const eventScore = event.macroScore != null ? event.macroScore : (avgScore(event) ?? 0.5);
  const eventConf = avgConf(event) ?? 0.5;
  const recency = recencyMult(event.last_seen, now);
  const stance = IMPACT.STANCE_FACTOR[event.stance] ?? 1;   // an event counts in full, talk about one for less

  let impact = 0;
  let exposure = 0;
  let signed = 0;

  for (const h of holdings) {
    const link = holdingLink(event, h);
    if (!link) continue;                             // event doesn't touch this holding
    const { relevance } = link;
    const direct = link.relation === 'direct';
    const score = direct ? event.tickers[h.ticker].score : eventScore;
    const conf = direct ? event.tickers[h.ticker].confidence : eventConf;
    const z = direct ? zByTicker[h.ticker] : null;

    const magnitude = Math.abs(score - 0.5) * 2;
    // A story that reaches this holding only as market news counts as market news: an IPO
    // approval is a "legal" event for that company, not for everything else listed nearby.
    const sev = link.relation === 'macro' ? Math.min(severity, EVENT_TYPES.SEVERITY.macro) : severity;
    const severityCore = sev * magnitude;            // "how big" = type × sentiment
    const w = (h.exposure_pct || 0) / 100;
    const contribution = w * relevance * severityCore * noveltyMult(z) * confidenceMult(conf) * recency * stance;
    impact += contribution;
    exposure += (h.exposure_pct || 0) * relevance;
    signed += (score - 0.5) * w * relevance;
  }

  return { impact: round(impact), exposure_pct: round(Math.min(100, exposure), 1), direction: dirLabel(signed) };
}

// ticker → { sector, country } from the company reference.
async function companyRef(query) {
  const ref = {};
  for (const r of await query('SELECT ticker, sector, country FROM companies')) ref[r.ticker] = r;
  return ref;
}
// Weighted holdings → what impactForEvent scores against.
function scoringHoldings(raw, ref) {
  return raw.map((h) => ({
    ticker: h.ticker, exposure_pct: h.exposure_pct ?? 0,
    sector: ref[h.ticker]?.sector || null,
    region: holdingRegion(h, ref[h.ticker]?.country),
  }));
}
// An event scored this pass that no longer touches the user (a holding sold, or a market
// story that turned out not to concern their market) must not keep its old row.
async function dropStaleImpacts(execute, userId, scoredEventIds, keptEventIds) {
  if (!scoredEventIds.length) return;
  await execute(
    'DELETE FROM event_portfolio_impact WHERE user_id = $1 AND event_id = ANY($2) AND NOT (event_id = ANY($3))',
    [userId, scoredEventIds, keptEventIds]);
}

async function recomputeImpacts() {
  const { query, execute } = require('../db');
  const { getWeightedHoldings } = require('./portfolioService');
  const events = await loadRecentEvents();
  const userRows = await query('SELECT DISTINCT user_id FROM portfolio');

  // Baseline z per distinct held ticker, computed once for the whole run.
  const heldTickers = await query('SELECT DISTINCT ticker FROM portfolio');
  const zByTicker = {};
  for (const { ticker } of heldTickers) {
    try {
      const s = await scoreTicker(ticker);
      zByTicker[ticker] = s.baseline.z;
    } catch {
      zByTicker[ticker] = null;
    }
  }

  // ticker → sector and country, so a holding can match a sector-wide or market-wide event.
  const ref = await companyRef(query);

  const now = Date.now();
  const eventIds = events.map((e) => e.event_id);
  let written = 0;
  for (const { user_id } of userRows) {
    const raw = await getWeightedHoldings(user_id);
    if (raw.length === 0) continue;
    const holdings = scoringHoldings(raw, ref);
    const kept = [];

    for (const event of events) {
      const { impact, exposure_pct, direction } = impactForEvent(event, holdings, zByTicker, now);
      if (impact <= 0 || exposure_pct <= 0) continue;
      kept.push(event.event_id);
      await execute(
        `INSERT INTO event_portfolio_impact (user_id, event_id, impact_score, exposure_pct, direction)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, event_id)
         DO UPDATE SET impact_score = EXCLUDED.impact_score,
                       exposure_pct = EXCLUDED.exposure_pct,
                       direction    = EXCLUDED.direction,
                       computed_at  = now()`,
        [user_id, event.event_id, impact, exposure_pct, direction]
      );
      written++;
    }
    await dropStaleImpacts(execute, user_id, eventIds, kept);
  }

  // Prune impacts for events that have aged out of the 72h feed window. (Events live
  // 7 days for clustering, but the impact feed is "today's most important" — without
  // this, an out-of-window event keeps a stale score it's no longer being recomputed on.)
  await execute(
    `DELETE FROM event_portfolio_impact
      WHERE event_id IN (SELECT id FROM events WHERE last_seen <= now() - ($1 || ' hours')::interval)`,
    [String(IMPACT.EVENT_WINDOW_HOURS)]
  );

  return written;
}

/**
 * Silent historical backfill for ONE user (Engine Phase E4) — run on add.
 * Computes this user's impact over events already stored (the 72h window), so a newly
 * added holding gets instant context in the feed/brief WITHOUT touching alerts or other
 * users. Returns the number of impact rows written for the user.
 */
async function recomputeImpactsForUser(userId) {
  const { query, execute } = require('../db');
  const { getWeightedHoldings } = require('./portfolioService');
  const raw = await getWeightedHoldings(userId);
  if (raw.length === 0) return 0;

  const events = await loadRecentEvents();
  if (events.length === 0) return 0;

  const ref = await companyRef(query);

  const zByTicker = {};
  for (const h of raw) {
    try { zByTicker[h.ticker] = (await scoreTicker(h.ticker)).baseline.z; }
    catch { zByTicker[h.ticker] = null; }
  }

  const holdings = scoringHoldings(raw, ref);
  const now = Date.now();
  const kept = [];
  let written = 0;
  for (const event of events) {
    const { impact, exposure_pct, direction } = impactForEvent(event, holdings, zByTicker, now);
    if (impact <= 0 || exposure_pct <= 0) continue;
    kept.push(event.event_id);
    await execute(
      `INSERT INTO event_portfolio_impact (user_id, event_id, impact_score, exposure_pct, direction)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, event_id)
       DO UPDATE SET impact_score = EXCLUDED.impact_score,
                     exposure_pct = EXCLUDED.exposure_pct,
                     direction    = EXCLUDED.direction,
                     computed_at  = now()`,
      [userId, event.event_id, impact, exposure_pct, direction]
    );
    written++;
  }
  await dropStaleImpacts(execute, userId, events.map((e) => e.event_id), kept);
  return written;
}

/**
 * Collapse a ranked list so one story appears once. Rows must be ordered best first; the
 * best row of a story stays, counts the rest in `related` and carries the first few of them
 * in `related_items` so a reader can still open them. Two rows are one story when
 * their headlines share enough key words within one market (materiality.sameStory) — and,
 * for stories about a holding, when they are about the same holding, so "TCS results" and
 * "Infosys results" stay apart. Pure.
 */
const RELATED_SHOWN = 6;
function collapseStories(rows, limit = rows.length) {
  const items = rows.map((row) => {
    const broad = !!row.relevance_tier && row.relevance_tier !== 'holding';
    return {
      broad, ticker: row.primary_ticker || null,
      member: { tokens: broad ? feedTokens(row.title) : storyTokens(row.title), region: regionOf(row.title, row.source) },
    };
  });
  // Each headline joins the first (best-ranked) story whose LEAD it matches. Matching the
  // lead only, not any member, keeps neighbouring stories apart: "RBI hikes rates" and
  // "Sensex tanks" stay two stories even though "RBI presser: Sensex down" touches both.
  const out = []; // { item, row }
  rows.forEach((row, i) => {
    const it = items[i];
    const home = out.find(({ item }) => {
      if (item.broad !== it.broad || (!it.broad && item.ticker !== it.ticker)) return false;
      // Two headlines on one holding always share its name, so that word proves nothing:
      // they need one more shared key word than market headlines do.
      // A shared topic word (results, dividend, …) is enough by itself.
      const rule = it.broad ? { anchors: true } : { anchors: HOLDING_TOPICS, minShared: MATERIALITY.STORY_SHARED_TOKENS + 1 };
      return sameStory(item.member, it.member, rule);
    });
    if (home) {
      home.row.related++;
      // The folded headlines stay readable: the first few travel with the row.
      if (home.row.related_items.length < RELATED_SHOWN) home.row.related_items.push({ title: row.title, url: row.url || null, source: row.source || null });
      return;
    }
    out.push({ item: it, row: { ...row, related: 0, related_items: [] } });
  });
  return out.slice(0, limit).map((o) => o.row);
}

// How many ranked rows are read before folding them into stories. Fixed, not tied to how
// many the caller wants, so the same headlines are grouped the same way for every caller.
const FEED_POOL = 200;

// Ranked feed for a user, one row per story; the first row is "today's most important
// event". `related` = how many other headlines on the same story were folded into the row.
async function getImpactFeed(userId, limit = 20) {
  const { query } = require('../db');
  const rows = await query(
    `SELECT i.impact_score, i.exposure_pct, i.direction, i.computed_at,
            e.id AS event_id, e.title, e.url, e.source, e.last_seen AS published_at,
            e.relevance_tier, e.primary_ticker
       FROM event_portfolio_impact i
       JOIN events e ON e.id = i.event_id
      WHERE i.user_id = $1
      ORDER BY i.impact_score DESC, e.last_seen DESC
      LIMIT $2`,
    [userId, FEED_POOL]
  );
  const isCompany = await companyNamer();
  return collapseStories(rows, limit).map((r) => ({ ...r, stance: classifyStance(r.title, isCompany) }));
}

module.exports = { recomputeImpacts, recomputeImpactsForUser, getImpactFeed, collapseStories, companyNamer, tagMarketStories, coverageMult, impactForEvent, holdingLink, holdingRegion, loadRecentEvents, noveltyMult, confidenceMult, recencyMult };
