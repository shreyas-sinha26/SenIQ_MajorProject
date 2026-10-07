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

// Rows → scored points with their age and source weight; unparseable rows are dropped.
// `row` keeps the original so explainSentiment can report title/source/url.
function cleanRows(rows, now) {
  return (rows || [])
    .map((r) => {
      const t = new Date(r.published_at).getTime();
      return Number.isFinite(t)
        ? {
            score: Number(r.score),
            confidence: Number(r.confidence) || 0,
            ageHours: (now - t) / HOUR_MS,
            ageDays: (now - t) / DAY_MS,
            srcW: sourceWeight(r.source, r.platform),
            row: r,
          }
        : null;
    })
    .filter((r) => r && Number.isFinite(r.score) && r.ageHours >= -1); // tolerate slight clock skew
}

// An article's weight in the Acute score: recency × source credibility × confidence.
function acuteWeight(r) {
  return decayWeight(r.ageHours) * r.srcW * Math.max(r.confidence, 0.15);
}

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

  const cleaned = cleanRows(rows, now);
  if (cleaned.length === 0) return empty;

  // ── Acute: decay × confidence × source-credibility weighted average ──
  let wSum = 0;
  let wScore = 0;
  let acuteCount = 0;
  for (const r of cleaned) {
    if (r.ageHours > SENTIMENT.ACUTE_WINDOW_HOURS) continue;
    const w = acuteWeight(r);
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
 * Provenance for the sentiment numbers: which stories produced the Acute score and z-score.
 * Pure — same rows and weights as computeWindowedSentiment, so the two cannot disagree.
 *
 * The split is exact, not a heuristic. With wᵢ the acute weight, W = Σwᵢ, μ/σ the baseline:
 *   acute − 0.5 = Σ wᵢ(sᵢ − 0.5) / W          (each term = that article's pull off neutral)
 *   z           = Σ wᵢ(sᵢ − μ) / (W·σ)        (each term = that article's share of the z-score)
 * Articles of one story (event_id) are summed into one driver, which keeps the sums intact.
 *
 * @param rows  scoreTicker-style rows plus { id, event_id, title, source, url }
 * @returns { acute, baseline, basis:'baseline'|'neutral', drivers:[…], rest:{stories, contribution} }
 *          `contribution` is in z units when basis is 'baseline', else in acute-score points.
 */
function explainSentiment(rows, { now = Date.now(), limit = 5 } = {}) {
  const summary = computeWindowedSentiment(rows, now);
  const cleaned = cleanRows(rows, now);
  const acute = cleaned.filter((r) => r.ageHours <= SENTIMENT.ACUTE_WINDOW_HOURS).map((r) => ({ ...r, w: acuteWeight(r) }));
  const W = acute.reduce((a, r) => a + r.w, 0);
  const out = { acute: summary.acute, baseline: summary.baseline, basis: 'neutral', drivers: [], rest: { stories: 0, contribution: 0 } };
  if (W <= 0) return out;

  // Unrounded baseline, recomputed so the terms add up to the unrounded z.
  const base = cleaned.filter((r) => r.ageDays <= SENTIMENT.BASELINE_DAYS).map((r) => r.score);
  const mu = mean(base);
  const sigma = stddev(base, mu);
  const useBaseline = summary.baseline.z != null;
  out.basis = useBaseline ? 'baseline' : 'neutral';
  const ref = useBaseline ? mu : 0.5;
  const scale = useBaseline ? W * sigma : W;

  const byStory = new Map();
  acute.forEach((r, i) => {
    const key = r.row.event_id != null ? `e${r.row.event_id}` : r.row.id != null ? `a${r.row.id}` : `row${i}`;
    let g = byStory.get(key);
    if (!g) byStory.set(key, (g = { contribution: 0, w: 0, wScore: 0, articles: 0, lead: r }));
    g.contribution += (r.w * (r.score - ref)) / scale;
    g.w += r.w;
    g.wScore += r.w * r.score;
    g.articles++;
    if (r.w > g.lead.w) g.lead = r; // the story is shown by its heaviest article
  });

  const ranked = [...byStory.values()].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const n = Math.max(1, limit);
  out.drivers = ranked.slice(0, n).map((g) => ({
    title: g.lead.row.title || '',
    source: g.lead.row.source || '',
    url: g.lead.row.url || '',
    published_at: g.lead.row.published_at,
    articles: g.articles,
    sentiment_score: round(g.wScore / g.w),
    weight_pct: round((g.w / W) * 100, 1),
    contribution: round(g.contribution, 3),
    direction: g.contribution > 0 ? 'up' : g.contribution < 0 ? 'down' : 'flat',
  }));
  const rest = ranked.slice(n);
  out.rest = { stories: rest.length, contribution: round(rest.reduce((a, g) => a + g.contribution, 0), 3) };
  return out;
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

module.exports = { computeWindowedSentiment, explainSentiment, scoreTicker, sourceWeight, decayWeight, labelFor };
