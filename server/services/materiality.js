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

const { query, execute } = require('../db');
const { MATERIALITY } = require('../config');
const { getWeightedHoldings } = require('./portfolioService');
const { scoreTicker } = require('./sentimentScoring');
const { sourceWeight } = require('./sentimentScoring');

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

// Group recent relevant articles into events keyed by cluster_key.
async function loadRecentClusters() {
  const rows = await query(
    `SELECT a.id AS article_id, a.title, a.url, a.source, a.platform, a.published_at,
            a.cluster_key, a.relevance_tier, a.importance,
            s.ticker, s.sentiment_score AS score, s.confidence
       FROM articles a
       JOIN article_sentiments s ON s.article_id = a.id
      WHERE a.is_relevant = true
        AND a.cluster_key IS NOT NULL
        AND a.published_at > now() - ($1 || ' hours')::interval`,
    [String(MATERIALITY.LOOKBACK_HOURS)]
  );

  const clusters = new Map();
  for (const r of rows) {
    let c = clusters.get(r.cluster_key);
    if (!c) {
      c = {
        cluster_key: r.cluster_key,
        tier: r.relevance_tier,
        importance: Number(r.importance) || 0,
        articleIds: new Set(),
        rep: r,           // representative article (best source / latest)
        repWeight: sourceWeight(r.source, r.platform),
        tickers: {},      // ticker -> { sumScore, sumConf, n }
      };
      clusters.set(r.cluster_key, c);
    }
    c.articleIds.add(r.article_id);
    c.importance = Math.max(c.importance, Number(r.importance) || 0);

    // Best representative = highest source credibility, tie-break on recency.
    const w = sourceWeight(r.source, r.platform);
    if (w > c.repWeight || (w === c.repWeight && new Date(r.published_at) > new Date(c.rep.published_at))) {
      c.rep = r;
      c.repWeight = w;
    }

    if (r.ticker && r.ticker !== '__MARKET__') {
      const t = (c.tickers[r.ticker] ||= { sumScore: 0, sumConf: 0, n: 0 });
      t.sumScore += Number(r.score);
      t.sumConf += Number(r.confidence) || 0;
      t.n += 1;
    }
  }

  return [...clusters.values()].map((c) => ({
    ...c,
    sourceCount: c.articleIds.size,
    tickers: Object.fromEntries(
      Object.entries(c.tickers).map(([k, v]) => [k, { score: v.sumScore / v.n, confidence: v.sumConf / v.n }])
    ),
  }));
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
 * Generate event-level alerts for the current ingest pass.
 * Returns the number of alert rows written.
 */
async function generateAlerts() {
  const clusters = await loadRecentClusters();
  if (clusters.length === 0) return 0;

  const userRows = await query('SELECT DISTINCT user_id FROM portfolio');
  if (userRows.length === 0) return 0;
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

  // Pre-load existing (user, cluster) alerts so we never double-fire an event.
  const clusterKeys = clusters.map((c) => c.cluster_key);
  const existing = await query(
    'SELECT user_id, cluster_key FROM alerts WHERE cluster_key = ANY($1)',
    [clusterKeys]
  );
  const alreadyAlerted = new Set(existing.map((e) => `${e.user_id}|${e.cluster_key}`));

  const toInsert = [];
  for (const cluster of clusters) {
    const title = cluster.rep.title;
    const srcNote = cluster.sourceCount > 1 ? ` (${cluster.sourceCount} sources)` : '';

    if (cluster.tier === 'holding') {
      // Fire per user, scaled by THEIR exposure + the surprise vs baseline.
      for (const uid of userIds) {
        const key = `${uid}|${cluster.cluster_key}`;
        if (alreadyAlerted.has(key)) continue;
        const { score, direction, topTicker } = holdingMateriality(cluster, exposureByUser[uid], zByTicker);
        if (score < MATERIALITY.HOLDING_THRESHOLD || !topTicker) continue;
        const icon = direction === 'negative' ? '⚠️' : direction === 'positive' ? '🚀' : '📰';
        toInsert.push({
          user_id: uid,
          ticker: topTicker,
          cluster_key: cluster.cluster_key,
          alert_type: `holding_${direction}`,
          label: direction,
          score: cluster.tickers[topTicker]?.score ?? 0.5,
          message: `${icon} ${topTicker} — ${title}${srcNote}`,
          article_id: cluster.rep.article_id,
        });
        alreadyAlerted.add(key);
      }
    } else {
      // market / world: importance × volume, fired to everyone but gated harder.
      const broad = cluster.importance * volumeBoost(cluster.sourceCount);
      if (broad < MATERIALITY.BROAD_THRESHOLD) continue;
      const icon = cluster.tier === 'world' ? '🌍' : '📊';
      const label = cluster.tier === 'world' ? 'World' : 'Markets';
      for (const uid of userIds) {
        const key = `${uid}|${cluster.cluster_key}`;
        if (alreadyAlerted.has(key)) continue;
        toInsert.push({
          user_id: uid,
          ticker: 'MARKET',
          cluster_key: cluster.cluster_key,
          alert_type: cluster.tier === 'world' ? 'world_event' : 'market_event',
          label: 'neutral',
          score: 0.5,
          message: `${icon} ${label}: ${title}${srcNote}`,
          article_id: cluster.rep.article_id,
        });
        alreadyAlerted.add(key);
      }
    }
  }

  for (const a of toInsert) {
    await execute(
      `INSERT INTO alerts (user_id, ticker, article_id, alert_type, sentiment_label, sentiment_score, message, cluster_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.user_id, a.ticker, a.article_id, a.alert_type, a.label, a.score, a.message, a.cluster_key]
    );
  }
  return toInsert.length;
}

module.exports = { generateAlerts, loadRecentClusters, holdingMateriality, volumeBoost };
