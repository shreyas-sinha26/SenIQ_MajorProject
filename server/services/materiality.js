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
 * Dedupe is by (user_id, cluster_key): the cluster groups duplicates, so the same
 * event never alerts twice.
 */

// db + portfolioService lazy-required inside the async functions so the pure
// planDeliveries / scoring helpers are importable/testable without a database.
const { MATERIALITY, ALERT_BUDGET } = require('../config');
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
            e.first_seen,
            s.ticker, avg(s.sentiment_score) AS score, max(s.confidence) AS confidence
       FROM events e
       JOIN articles a ON a.event_id = e.id
       JOIN article_sentiments s ON s.article_id = a.id
      WHERE e.relevance_tier <> 'none'
        AND e.last_seen > now() - ($1 || ' hours')::interval
      GROUP BY e.id, e.title, e.relevance_tier, e.importance, e.source_count, e.first_seen, s.ticker`,
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
    }
  }
  return { score: round(m * volumeBoost(cluster.sourceCount)), direction: dirLabel(signed), topTicker };
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
 * state = { sentTodayByUser:{uid:n}, cooldownByUser:{uid:Set<ticker>}, nowHour, budget }
 */
function planDeliveries(candidates, state) {
  const { sentTodayByUser = {}, cooldownByUser = {}, nowHour = 0, budget } = state;
  const quiet = inQuietWindow(nowHour, budget);
  const byUser = new Map();
  for (const c of candidates) {
    if (!byUser.has(c.user_id)) byUser.set(c.user_id, []);
    byUser.get(c.user_id).push(c);
  }
  for (const [uid, list] of byUser) {
    list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    let realtimeCount = sentTodayByUser[uid] || 0;
    const cooldown = new Set(cooldownByUser[uid] || []);
    for (const c of list) {
      const isTicker = c.ticker && c.ticker !== 'MARKET';
      if (quiet) c.delivery = 'digest';
      else if (isTicker && cooldown.has(c.ticker)) c.delivery = 'digest';
      else if (realtimeCount >= budget.MAX_REALTIME_PER_DAY) c.delivery = 'digest';
      else {
        c.delivery = 'realtime';
        realtimeCount++;
        if (isTicker) cooldown.add(c.ticker);
      }
    }
  }
  return candidates;
}

/**
 * Generate event-level alerts for the current ingest pass.
 * Returns the number of alert rows written.
 */
async function generateAlerts() {
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
  for (const uid of userIds) {
    const holdings = await getWeightedHoldings(uid);
    const map = {};
    for (const h of holdings) map[h.ticker] = h.exposure_pct ?? 0;
    exposureByUser[uid] = map;
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
  const existing = await query(
    'SELECT user_id, event_id FROM alerts WHERE event_id = ANY($1)',
    [eventIds]
  );
  const alreadyAlerted = new Set(existing.map((e) => `${e.user_id}|${e.event_id}`));

  const toInsert = [];
  for (const ev of clusters) {
    const srcNote = ev.sourceCount > 1 ? ` (${ev.sourceCount} sources)` : '';

    if (ev.tier === 'holding') {
      // Fire per user, scaled by THEIR exposure + the surprise vs baseline.
      for (const uid of userIds) {
        const key = `${uid}|${ev.event_id}`;
        if (alreadyAlerted.has(key)) continue;
        const { score, direction, topTicker } = holdingMateriality(ev, exposureByUser[uid], zByTicker);
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
          // Phase 9 email context (ignored by the alerts insert; used by the notifier).
          title: ev.title,
          direction,
          exposure_pct: exposureByUser[uid]?.[topTicker] ?? null,
          source_count: ev.sourceCount,
        });
        alreadyAlerted.add(key);
      }
    } else {
      // market / world: importance × volume, fired to everyone but gated harder.
      const broad = ev.importance * volumeBoost(ev.sourceCount);
      if (broad < MATERIALITY.BROAD_THRESHOLD) continue;
      const icon = ev.tier === 'world' ? '🌍' : '📊';
      const label = ev.tier === 'world' ? 'World' : 'Markets';
      for (const uid of userIds) {
        const key = `${uid}|${ev.event_id}`;
        if (alreadyAlerted.has(key)) continue;
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
          priority: broad,
          // Phase 9 email context (ignored by the alerts insert; used by the notifier).
          title: ev.title,
          direction: 'neutral',
          exposure_pct: null,
          source_count: ev.sourceCount,
        });
        alreadyAlerted.add(key);
      }
    }
  }

  if (toInsert.length === 0) return { total: 0, realtime: 0 };

  // Apply per-user budgets: only the top few push in realtime, rest are digest.
  const cd = String(ALERT_BUDGET.PER_TICKER_COOLDOWN_HOURS);
  const sentRows = await query(
    `SELECT user_id, count(*) c FROM alerts
      WHERE delivery = 'realtime' AND created_at >= date_trunc('day', now()) GROUP BY user_id`
  );
  const sentTodayByUser = Object.fromEntries(sentRows.map((r) => [r.user_id, Number(r.c)]));
  const cdRows = await query(
    `SELECT DISTINCT user_id, ticker FROM alerts
      WHERE delivery = 'realtime' AND ticker <> 'MARKET'
        AND created_at > now() - ($1 || ' hours')::interval`,
    [cd]
  );
  const cooldownByUser = {};
  for (const r of cdRows) (cooldownByUser[r.user_id] ||= new Set()).add(r.ticker);

  const nowHour = (new Date().getUTCHours() + ALERT_BUDGET.QUIET_TZ_OFFSET + 24) % 24;
  planDeliveries(toInsert, { sentTodayByUser, cooldownByUser, nowHour, budget: ALERT_BUDGET });

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

module.exports = { generateAlerts, loadRecentClusters, holdingMateriality, volumeBoost, planDeliveries, inQuietWindow, isPostWatermark };
