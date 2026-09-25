/**
 * Sentiment Scoring v2 — windowed aggregation (Phase 2a + 2c).
 *
 * The per-text classifier lives in sentiment.js (lexicon) / finbertClassifier.js.
 * This module turns a ticker's *history* of per-article scores into the three
 * layers SenIQ reports on, off the same data:
 *   - acute:    last 24-72h, exponential time-decay (~7-day half-life) → drives alerts
 *   - momentum: 7d vs 7-14d trend (improving / rolling over)
 *   - baseline: today vs the asset's own 90-day mean/σ → "+2.3σ above baseline"
 *
 * A flat 90-day average dilutes today's signal (news impact is realized in 1-3 days
 * and reverts within ~2 weeks), so the headline decays fast while the 90-day window
 * only feeds the z-score baseline. Pure functions here — no DB — so the math is
 * testable offline; scoreTicker() is the DB-backed convenience wrapper.
 */

const { SENTIMENT, SOURCE_WEIGHTS } = require('../config');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function labelFor(score) {
  if (score > 0.6) return 'positive';
  if (score < 0.4) return 'negative';
  return 'neutral';
}

// Credibility weight for a source: a named source wins, else the platform default.
function sourceWeight(source = '', platform = 'news') {
  const s = String(source).toLowerCase();
  for (const [name, w] of Object.entries(SOURCE_WEIGHTS.bySource)) {
    if (s.includes(name)) return w;
  }
  return SOURCE_WEIGHTS.byPlatform[platform] ?? 0.5;
}

// Exponential time decay: 1.0 now, 0.5 at one half-life, etc.
function decayWeight(ageHours) {
  return Math.pow(0.5, ageHours / SENTIMENT.HALF_LIFE_HOURS);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function stddev(xs, mu) {
  if (xs.length < 2) return 0;
  const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/**
 * @param {Array<{score:number, confidence:number, published_at:string|number|Date, source?:string, platform?:string}>} rows
 *        A ticker's article scores over (up to) the baseline window.
 * @param {number} [now] epoch ms (injectable for tests)
 */
function computeWindowedSentiment(rows, now = Date.now()) {
  const empty = {
    acute: { score: 0.5, label: 'neutral', confidence: 0, count: 0 },
    momentum: { delta: null, direction: 'flat' },
    baseline: { mean: null, std: null, z: null, points: 0 },
    magnitude: 0,
    label: 'neutral',
  };
  if (!rows || rows.length === 0) return empty;

  const cleaned = rows
    .map((r) => {
      const t = new Date(r.published_at).getTime();
      return Number.isFinite(t)
        ? {
            score: Number(r.score),
            confidence: Number(r.confidence) || 0,
            ageHours: (now - t) / HOUR_MS,
            ageDays: (now - t) / DAY_MS,
            srcW: sourceWeight(r.source, r.platform),
          }
        : null;
    })
    .filter((r) => r && Number.isFinite(r.score) && r.ageHours >= -1); // tolerate slight clock skew
  if (cleaned.length === 0) return empty;

  // ── Acute: decay × confidence × source-credibility weighted average ──
  let wSum = 0;
  let wScore = 0;
  let acuteCount = 0;
  for (const r of cleaned) {
    if (r.ageHours > SENTIMENT.ACUTE_WINDOW_HOURS) continue;
    const w = decayWeight(r.ageHours) * r.srcW * Math.max(r.confidence, 0.15);
    wSum += w;
    wScore += w * r.score;
    acuteCount++;
  }
  const acuteScore = wSum > 0 ? wScore / wSum : 0.5;
  // Confidence reflects how much weighted evidence backs the acute score.
  const acuteConfidence = Math.min(1, wSum);

  // ── Baseline: the asset's own 90-day distribution (unweighted) ──
  const baseScores = cleaned.filter((r) => r.ageDays <= SENTIMENT.BASELINE_DAYS).map((r) => r.score);
  const mu = mean(baseScores);
  const sigma = mu == null ? 0 : stddev(baseScores, mu);
  const z =
    baseScores.length >= SENTIMENT.MIN_BASELINE_POINTS && sigma > 1e-6
      ? (acuteScore - mu) / sigma
      : null;

  // ── Momentum: recent leg vs prior leg ──
  const recent = mean(cleaned.filter((r) => r.ageDays <= SENTIMENT.MOMENTUM_RECENT_DAYS).map((r) => r.score));
  const prior = mean(
    cleaned
      .filter((r) => r.ageDays > SENTIMENT.MOMENTUM_RECENT_DAYS && r.ageDays <= SENTIMENT.MOMENTUM_PRIOR_DAYS)
      .map((r) => r.score)
  );
  let delta = null;
  let direction = 'flat';
  if (recent != null && prior != null) {
    delta = recent - prior;
    direction = delta > 0.03 ? 'improving' : delta < -0.03 ? 'declining' : 'flat';
  }

  return {
    acute: { score: round(acuteScore), label: labelFor(acuteScore), confidence: round(acuteConfidence), count: acuteCount },
    momentum: { delta: round(delta, 3), direction },
    baseline: { mean: round(mu), std: round(sigma), z: round(z), points: baseScores.length },
    magnitude: round(Math.abs(acuteScore - 0.5) * 2),
    label: labelFor(acuteScore),
  };
}

/**
 * DB-backed: pull a ticker's scored articles over the baseline window and score them.
 * Lazy-requires db so the pure math above stays importable without a database.
 */
async function scoreTicker(ticker) {
  const { query } = require('../db');
  const rows = await query(
    `SELECT s.sentiment_score AS score, s.confidence, a.published_at, a.source, a.platform
       FROM article_sentiments s
       JOIN articles a ON a.id = s.article_id
      WHERE s.ticker = $1
        AND a.published_at > now() - ($2 || ' days')::interval`,
    [ticker, String(SENTIMENT.BASELINE_DAYS)]
  );
  return computeWindowedSentiment(rows);
}

module.exports = { computeWindowedSentiment, scoreTicker, sourceWeight, decayWeight, labelFor };
