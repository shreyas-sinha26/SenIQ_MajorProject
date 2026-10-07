/**
 * Materiality alerting (Phase 3.5 — pulled forward from Phase 7).
 *
 * Replaces alertEngine.js's per-article threshold/keyword rules, which spammed:
 * every duplicate article fired its own alert, and one more bad headline on an
 * already-negative stock paged the user again. Here an alert fires on an EVENT
 * (a cluster of duplicate articles), at most once per user, scored by how much it
 * actually matters:
 *
 *   holding events:  Σ_heldTickers( exposure × magnitude × confidence × z_surprise ) × volume
 *   market/world:    importance × volume     (fires to everyone, gated harder)
 *
 *   - exposure   : the user's % weight in the affected holding (North Star reuse)
 *   - magnitude  : |score - 0.5| × 2  (how extreme)
 *   - z_surprise : swing vs the asset's 90-day baseline — a +2.5σ move is news, the
 *                  5th bad article on a chronically-negative name is not (kills spam)
 *   - volume     : how many distinct sources covered the event (confirmation)
 *
 *   - event type : an earnings miss, lawsuit or takeover outranks an opinion piece
 *                  (config.EVENT_TYPES.SEVERITY)
 *
 * Dedupe is by (user_id, cluster_key): the cluster groups duplicates, so the same
 * event never alerts twice.
 *
 * Market/world news is handled as STORIES, not events. One rate decision arrives as a
 * dozen differently-worded headlines that the duplicate clustering cannot merge; each
 * used to alert on its own. Related headlines from the same market are now grouped, a
 * user gets ONE alert per story per day, and it pushes in real time only when the story
 * is confirmed by several reports and the user actually has money in that market.
 */

// db + portfolioService lazy-required inside the async functions so the pure
// planDeliveries / scoring helpers are importable/testable without a database.
const { MATERIALITY, ALERT_BUDGET, EVENT_TYPES } = require('../config');
const { scoreTicker } = require('./sentimentScoring');

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function volumeBoost(sourceCount) {
  return 1 + MATERIALITY.VOLUME_BOOST * Math.log2(Math.max(1, sourceCount));
}

function zBoost(z) {
  if (z == null) return 1;
  return 1 + MATERIALITY.Z_BOOST * Math.min(Math.abs(z), 3);
}

function dirLabel(signed) {
  if (signed > 0.02) return 'positive';
  if (signed < -0.02) return 'negative';
  return 'neutral';
}

// Load recent durable events with their per-ticker sentiment (averaged over the
// event's articles). Returns event objects the alert logic scores.
async function loadRecentClusters() {
  const { query } = require('../db');
  const rows = await query(
    `SELECT e.id AS event_id, e.title, e.relevance_tier AS tier, e.importance, e.source_count,
            e.first_seen, e.event_type, e.source,
            s.ticker, avg(s.sentiment_score) AS score, max(s.confidence) AS confidence
       FROM events e
       JOIN articles a ON a.event_id = e.id
       JOIN article_sentiments s ON s.article_id = a.id
      WHERE e.relevance_tier <> 'none'
        AND e.last_seen > now() - ($1 || ' hours')::interval
      GROUP BY e.id, e.title, e.relevance_tier, e.importance, e.source_count, e.first_seen, e.event_type, e.source, s.ticker`,
    [String(MATERIALITY.LOOKBACK_HOURS)]
  );

  const events = new Map();
  for (const r of rows) {
    let c = events.get(r.event_id);
    if (!c) {
      c = {
        event_id: r.event_id,
        title: r.title,
        tier: r.tier,
        importance: Number(r.importance) || 0,
        sourceCount: Number(r.source_count) || 1,
        firstSeen: r.first_seen,
        eventType: r.event_type || 'unknown',
        source: r.source || '',
        tickers: {},
      };
      events.set(r.event_id, c);
    }
    if (r.ticker && r.ticker !== '__MARKET__') {
      c.tickers[r.ticker] = { score: Number(r.score), confidence: Number(r.confidence) || 0 };
    }
  }
  return [...events.values()];
}

// Per-user materiality for a holding event.
function holdingMateriality(cluster, exposureByTicker, zByTicker) {
  let m = 0;
  let signed = 0;
  let topTicker = null;
  let topContribution = 0;
  let topConfidence = 0;
  for (const [ticker, s] of Object.entries(cluster.tickers)) {
    const exp = exposureByTicker[ticker];
    if (exp == null) continue; // user doesn't hold it
    if ((s.confidence || 0) < MATERIALITY.MIN_CONFIDENCE) continue;
    const mag = Math.abs(s.score - 0.5) * 2;
    const w = exp / 100;
    const contribution = w * mag * Math.max(s.confidence, MATERIALITY.MIN_CONFIDENCE) * zBoost(zByTicker[ticker]);
    m += contribution;
    signed += (s.score - 0.5) * w;
    if (contribution > topContribution) {
      topContribution = contribution;
      topTicker = ticker;
      topConfidence = s.confidence || 0;
    }
  }
  return {
    score: round(m * volumeBoost(cluster.sourceCount) * typeFactor(cluster.eventType)),
    direction: dirLabel(signed), topTicker, topConfidence,
  };
}

// Earnings, legal action, M&A or a CEO change matter more than commentary.
function typeFactor(eventType) {
  const sev = EVENT_TYPES.SEVERITY[eventType] ?? EVENT_TYPES.SEVERITY.unknown;
  return MATERIALITY.TYPE_BASE + sev;
}

// ─── Market/world stories ────────────────────────────────────────────────────
// Words too common in market headlines to say what a story is about.
const STORY_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'had', 'will',
  'not', 'but', 'its', 'into', 'over', 'amid', 'after', 'before', 'more', 'than', 'what', 'why', 'how',
  'who', 'when', 'where', 'next', 'new', 'now', 'says', 'said', 'say', 'see', 'seen', 'sees', 'expert',
  'market', 'stock', 'share', 'investor', 'trade', 'trading', 'today', 'live', 'update', 'news', 'report',
  'outcome', 'impact', 'meeting', 'meet', 'week', 'month', 'year', 'day', 'top', 'key', 'big', 'can',
  'could', 'may', 'should', 'would', 'here', 'check', 'list', 'means', 'mean', 'another', 'all', 'out',
  'nifty', 'sensex', 'index', 'indice', 'point', 'pts', 'bps', 'cent', 'percent', 'crore', 'lakh',
  'rise', 'fall', 'gain', 'drop', 'slip', 'jump', 'surge', 'high', 'low', 'higher', 'lower', 'end', 'open', 'close',
]);
// Crude stemmer: "hike" / "hikes" / "hiked" / "hiking" must all collide ("hik").
function stemWord(w) {
  if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

// Key words of a headline: lowercase, stemmed, no numbers, no market filler.
function storyTokens(title = '') {
  const out = new Set();
  for (const raw of String(title).toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
    if (raw.length < 3) continue;
    const t = stemWord(raw);
    if (t.length >= 3 && !STORY_STOP.has(t) && !STORY_STOP.has(raw)) out.add(t);
  }
  return out;
}

// Which market a broad headline is about. Coarse on purpose: it decides whose
// portfolio the story concerns and stops a Fed story merging with an RBI one.
const IN_SOURCE = /economictimes|livemint|moneycontrol|business-standard|financialexpress|cnbctv18|ndtv|thehindu|zeebiz|businesstoday/i;
const IN_WORDS = /\b(rbi|sebi|rupee|sensex|nifty|gst|india|indian|dalal street|mpc)\b/i;
const US_WORDS = /\b(fed|fomc|federal reserve|wall street|nasdaq|dow|s&p 500|treasury|us market|u\.s\.)\b/i;
function regionOf(title = '', source = '') {
  if (US_WORDS.test(title)) return 'US';
  if (IN_WORDS.test(title) || IN_SOURCE.test(source)) return 'IN';
  return 'GLOBAL';
}

function sameStory(a, b) {
  if (a.region !== b.region) return false;
  let shared = 0;
  for (const t of a.tokens) if (b.tokens.has(t) && ++shared >= MATERIALITY.STORY_SHARED_TOKENS) return true;
  return false;
}

/**
 * Group broad events into stories. Greedy: the most important headline leads; a
 * later one joins the first story it shares enough key words with (any member), so a
 * story can chain "RBI hikes rates" → "rate hike impact on banks". Pure.
 * story = { lead, events, region, importance, coverage, members:[{tokens, region}] }
 */
function groupStories(events) {
  const sorted = events.slice().sort((a, b) =>
    (b.importance - a.importance) || (b.sourceCount - a.sourceCount) ||
    (new Date(a.firstSeen || 0) - new Date(b.firstSeen || 0)));
  const stories = [];
  for (const ev of sorted) {
    const member = { tokens: storyTokens(ev.title), region: regionOf(ev.title, ev.source) };
    const home = stories.find((st) => st.members.some((m) => sameStory(m, member)));
    if (home) {
      home.events.push(ev);
      home.members.push(member);
      home.coverage += ev.sourceCount || 1;
    } else {
      stories.push({ lead: ev, events: [ev], region: member.region, importance: ev.importance, coverage: ev.sourceCount || 1, members: [member] });
    }
  }
  return stories;
}

// % of a portfolio (by exposure) sitting in each market. Crypto and commodities are
// GLOBAL: they belong to no single country's market story.
function regionExposure(holdings, countryByTicker = {}) {
  const out = { IN: 0, US: 0, GLOBAL: 0 };
  for (const h of holdings) {
    const ex = String(h.exchange || '').toUpperCase();
    const region = h.asset_class && h.asset_class !== 'equity' ? 'GLOBAL'
      : countryByTicker[h.ticker] === 'IN' || ex === 'NSE' || ex === 'BSE' ? 'IN'
      : countryByTicker[h.ticker] === 'US' || ['US', 'NASDAQ', 'NYSE', ''].includes(ex) ? 'US'
      : 'GLOBAL';
    out[region] += h.exposure_pct ?? 0;
  }
  return out;
}

/**
 * Score one story for one user. `share` = % of their portfolio in the story's market
 * (a GLOBAL story concerns everyone). Returns null when the story is not alert-worthy
 * at all; otherwise its priority and whether it may push in real time. Pure.
 */
function scoreStory(story, share) {
  const strength = story.importance * volumeBoost(story.coverage);
  if (strength < MATERIALITY.BROAD_THRESHOLD) return null;
  const concerns = story.region === 'GLOBAL' ? 100 : share;
  return {
    priority: round(strength * (0.5 + Math.min(concerns, 100) / 200)),
    realtimeEligible: story.coverage >= MATERIALITY.BROAD_REALTIME_MIN_COVERAGE
      && concerns >= MATERIALITY.BROAD_MIN_REGION_EXPOSURE,
  };
}

/**
 * Monitoring-since watermark gate (Engine Phase E4). An event may alert a holding only
 * if it was first seen at/after the user started monitoring it — so a freshly-added
 * holding never pings about old news (the news still shows in the feed + brief). A null
 * watermark (no record) means "no gate" → allow. Pure + unit-tested.
 */
function isPostWatermark(eventFirstSeen, watermark) {
  if (!watermark) return true;
  if (!eventFirstSeen) return true; // unknown event age → don't suppress
  return new Date(eventFirstSeen).getTime() >= new Date(watermark).getTime();
}

function inQuietWindow(hour, b) {
  if (!b.QUIET_HOURS_ENABLED) return false;
  const { QUIET_START: s, QUIET_END: e } = b;
  return s <= e ? hour >= s && hour < e : hour >= s || hour < e; // handles overnight wrap
}

/**
 * Decide realtime vs digest for each candidate alert, per user, under the budget.
 * Pure (state passed in) so it's unit-testable. Mutates+returns candidates with
 * `.delivery` set. Highest-priority candidates claim the scarce realtime slots first;
 * everything else is recorded as 'digest' (nothing is dropped).
 *
 * state = { sentTodayByUser:{uid:n}, sentBroadTodayByUser:{uid:n},
 *           cooldownByUser:{uid:Set<ticker>}, nowHour, budget }
 * A candidate with realtimeEligible === false is always digest (recorded, never pushed).
 * Market/world alerts (ticker 'MARKET') also have their own smaller daily cap, so a
 * busy macro day cannot use up the slots meant for the user's own holdings.
 */
function planDeliveries(candidates, state) {
  const { sentTodayByUser = {}, sentBroadTodayByUser = {}, cooldownByUser = {}, nowHour = 0, budget } = state;
  const quiet = inQuietWindow(nowHour, budget);
  const byUser = new Map();
  for (const c of candidates) {
    if (!byUser.has(c.user_id)) byUser.set(c.user_id, []);
    byUser.get(c.user_id).push(c);
  }
  for (const [uid, list] of byUser) {
    list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    let realtimeCount = sentTodayByUser[uid] || 0;
    let broadCount = sentBroadTodayByUser[uid] || 0;
    const broadCap = budget.MAX_BROAD_REALTIME_PER_DAY ?? Infinity;
    const cooldown = new Set(cooldownByUser[uid] || []);
    for (const c of list) {
      const isTicker = c.ticker && c.ticker !== 'MARKET';
      const isBroad = c.ticker === 'MARKET';
      if (quiet) c.delivery = 'digest';
      else if (c.realtimeEligible === false) c.delivery = 'digest';
      else if (isTicker && cooldown.has(c.ticker)) c.delivery = 'digest';
      else if (realtimeCount >= budget.MAX_REALTIME_PER_DAY) c.delivery = 'digest';
      else if (isBroad && broadCount >= broadCap) c.delivery = 'digest';
      else {
        c.delivery = 'realtime';
        realtimeCount++;
        if (isBroad) broadCount++;
        if (isTicker) cooldown.add(c.ticker);
      }
    }
  }
  return candidates;
}

/**
 * Generate event-level alerts for the current ingest pass.
 * Returns { total, realtime } for the rows written.
 *
 * opts.dryRun          — plan and return the candidates (with .delivery) without writing
 *                        or emailing; used to replay a day when tuning thresholds.
 * opts.ignoreExisting  — with dryRun: pretend no alerts exist yet (a fresh day).
 */
async function generateAlerts(opts = {}) {
  const { query, execute } = require('../db');
  const { getWeightedHoldings } = require('./portfolioService');
  const clusters = await loadRecentClusters();
  if (clusters.length === 0) return { total: 0, realtime: 0 };

  const userRows = await query('SELECT DISTINCT user_id FROM portfolio');
  if (userRows.length === 0) return { total: 0, realtime: 0 };
  const userIds = userRows.map((u) => u.user_id);

  // z-surprise per held ticker (computed once for the run).
  const heldTickers = await query('SELECT DISTINCT ticker FROM portfolio');
  const zByTicker = {};
  for (const { ticker } of heldTickers) {
    try {
      zByTicker[ticker] = (await scoreTicker(ticker)).baseline.z;
    } catch {
      zByTicker[ticker] = null;
    }
  }

  // Exposure map per user (once).
  const exposureByUser = {};
  const regionByUser = {};
  const countryByTicker = Object.fromEntries(
    (await query('SELECT ticker, country FROM companies')).map((r) => [r.ticker, r.country]));
  for (const uid of userIds) {
    const holdings = await getWeightedHoldings(uid);
    const map = {};
    for (const h of holdings) map[h.ticker] = h.exposure_pct ?? 0;
    exposureByUser[uid] = map;
    regionByUser[uid] = regionExposure(holdings, countryByTicker);
  }

  // Monitoring-since watermarks (E4): an event alerts a holding only if it post-dates
  // when the user started monitoring it; broad alerts gate on the user's EARLIEST
  // watermark (don't blast a brand-new user with events that predate their account).
  const watermarkByUserTicker = {};
  const minWatermarkByUser = {};
  for (const r of await query('SELECT user_id, ticker, monitoring_since FROM portfolio')) {
    (watermarkByUserTicker[r.user_id] ||= {})[r.ticker] = r.monitoring_since;
    const t = new Date(r.monitoring_since).getTime();
    if (minWatermarkByUser[r.user_id] == null || t < minWatermarkByUser[r.user_id]) {
      minWatermarkByUser[r.user_id] = t;
    }
  }

  // Pre-load existing (user, event) alerts so we never double-fire an event.
  const eventIds = clusters.map((c) => c.event_id);
  const existing = opts.ignoreExisting ? [] : await query(
    'SELECT user_id, event_id FROM alerts WHERE event_id = ANY($1)',
    [eventIds]
  );
  const alreadyAlerted = new Set(existing.map((e) => `${e.user_id}|${e.event_id}`));

  // Market/world stories each user was already told about in the last day — a new
  // headline on the same story must not alert again.
  const toldByUser = {};
  if (!opts.ignoreExisting) {
    for (const r of await query(
      `SELECT a.user_id, e.title, e.source FROM alerts a JOIN events e ON e.id = a.event_id
        WHERE a.alert_type IN ('market_event', 'world_event') AND a.created_at > now() - interval '24 hours'`)) {
      (toldByUser[r.user_id] ||= []).push({ tokens: storyTokens(r.title), region: regionOf(r.title, r.source) });
    }
  }

  const toInsert = [];
  for (const ev of clusters) {
    const srcNote = ev.sourceCount > 1 ? ` (${ev.sourceCount} sources)` : '';

    if (ev.tier === 'holding') {
      // Fire per user, scaled by THEIR exposure + the surprise vs baseline.
      for (const uid of userIds) {
        const key = `${uid}|${ev.event_id}`;
        if (alreadyAlerted.has(key)) continue;
        const { score, direction, topTicker, topConfidence } = holdingMateriality(ev, exposureByUser[uid], zByTicker);
        if (score < MATERIALITY.HOLDING_THRESHOLD || !topTicker) continue;
        // E4: skip old news for a freshly-added holding (still visible in the feed).
        if (!isPostWatermark(ev.firstSeen, watermarkByUserTicker[uid]?.[topTicker])) continue;
        const icon = direction === 'negative' ? '⚠️' : direction === 'positive' ? '🚀' : '📰';
        toInsert.push({
          user_id: uid,
          ticker: topTicker,
          event_id: ev.event_id,
          alert_type: `holding_${direction}`,
          label: direction,
          score: ev.tickers[topTicker]?.score ?? 0.5,
          message: `${icon} ${topTicker} — ${ev.title}${srcNote}`,
          priority: score,
          realtimeEligible: topConfidence >= MATERIALITY.REALTIME_MIN_CONFIDENCE,
          // Phase 9 email context (ignored by the alerts insert; used by the notifier).
          title: ev.title,
          direction,
          exposure_pct: exposureByUser[uid]?.[topTicker] ?? null,
          source_count: ev.sourceCount,
        });
        alreadyAlerted.add(key);
      }
    }
  }

  // Market / world: one alert per STORY per user, scored for that user.
  const stories = groupStories(clusters.filter((c) => c.tier !== 'holding'));
  for (const story of stories) {
    const ev = story.lead;
    const icon = ev.tier === 'world' ? '🌍' : '📊';
    const label = ev.tier === 'world' ? 'World' : 'Markets';
    const srcNote = story.coverage > 1 ? ` (${story.coverage} reports)` : '';
    for (const uid of userIds) {
      if (story.events.some((e) => alreadyAlerted.has(`${uid}|${e.event_id}`))) continue;
      if ((toldByUser[uid] || []).some((told) => story.members.some((m) => sameStory(told, m)))) continue;
      const scored = scoreStory(story, regionByUser[uid]?.[story.region] ?? 0);
      if (!scored) continue;
      // E4: don't blast a brand-new user with market/world events that predate them.
      if (!isPostWatermark(ev.firstSeen, minWatermarkByUser[uid] != null ? new Date(minWatermarkByUser[uid]) : null)) continue;
      toInsert.push({
        user_id: uid,
        ticker: 'MARKET',
        event_id: ev.event_id,
        alert_type: ev.tier === 'world' ? 'world_event' : 'market_event',
        label: 'neutral',
        score: 0.5,
        message: `${icon} ${label}: ${ev.title}${srcNote}`,
        priority: scored.priority,
        realtimeEligible: scored.realtimeEligible,
        // Phase 9 email context (ignored by the alerts insert; used by the notifier).
        title: ev.title,
        direction: 'neutral',
        exposure_pct: null,
        source_count: story.coverage,
      });
      alreadyAlerted.add(`${uid}|${ev.event_id}`);
      (toldByUser[uid] ||= []).push(...story.members);
    }
  }

  if (toInsert.length === 0) return { total: 0, realtime: 0 };

  // Apply per-user budgets: only the top few push in realtime, rest are digest.
  const cd = String(ALERT_BUDGET.PER_TICKER_COOLDOWN_HOURS);
  const sentRows = opts.ignoreExisting ? [] : await query(
    `SELECT user_id, count(*) c, count(*) FILTER (WHERE ticker = 'MARKET') broad FROM alerts
      WHERE delivery = 'realtime' AND created_at >= date_trunc('day', now()) GROUP BY user_id`
  );
  const sentTodayByUser = Object.fromEntries(sentRows.map((r) => [r.user_id, Number(r.c)]));
  const sentBroadTodayByUser = Object.fromEntries(sentRows.map((r) => [r.user_id, Number(r.broad)]));
  const cdRows = opts.ignoreExisting ? [] : await query(
    `SELECT DISTINCT user_id, ticker FROM alerts
      WHERE delivery = 'realtime' AND ticker <> 'MARKET'
        AND created_at > now() - ($1 || ' hours')::interval`,
    [cd]
  );
  const cooldownByUser = {};
  for (const r of cdRows) (cooldownByUser[r.user_id] ||= new Set()).add(r.ticker);

  const nowHour = (new Date().getUTCHours() + ALERT_BUDGET.QUIET_TZ_OFFSET + 24) % 24;
  planDeliveries(toInsert, { sentTodayByUser, sentBroadTodayByUser, cooldownByUser, nowHour, budget: ALERT_BUDGET });
  if (opts.dryRun) return { total: toInsert.length, realtime: toInsert.filter((a) => a.delivery === 'realtime').length, candidates: toInsert };

  let realtime = 0;
  const emailable = [];
  for (const a of toInsert) {
    if (a.delivery === 'realtime') { realtime++; emailable.push(a); }
    await execute(
      `INSERT INTO alerts (user_id, ticker, event_id, alert_type, sentiment_label, sentiment_score, message, delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.user_id, a.ticker, a.event_id, a.alert_type, a.label, a.score, a.message, a.delivery]
    );
  }

  // Phase 9 — email delivery of the just-created realtime alerts (Plus/Pro; Free stays
  // in-app). Fire-and-forget: alert generation never waits on email, and a delivery
  // failure is logged inside the notifier, never thrown back into the pipeline.
  if (emailable.length) {
    const { deliverAlertEmails } = require('./alertNotifier');
    deliverAlertEmails(emailable).catch((err) => console.error('Alert email dispatch error:', err.message));
  }

  return { total: toInsert.length, realtime };
}

/**
 * Delivery for an alert raised outside the news pipeline (smart money). These are rare
 * and discrete so they skip the scoring, but they still share the user's daily
 * real-time limit: once it is spent they are recorded as digest.
 */
async function deliveryForDiscreteAlert(userId) {
  const { queryOne } = require('../db');
  const row = await queryOne(
    `SELECT count(*)::int AS n FROM alerts
      WHERE user_id = $1 AND delivery = 'realtime' AND created_at >= date_trunc('day', now())`, [userId]);
  return row.n < ALERT_BUDGET.MAX_REALTIME_PER_DAY ? 'realtime' : 'digest';
}

module.exports = {
  generateAlerts, loadRecentClusters, holdingMateriality, volumeBoost, planDeliveries, inQuietWindow, isPostWatermark,
  typeFactor, storyTokens, regionOf, sameStory, groupStories, regionExposure, scoreStory, deliveryForDiscreteAlert,
};
