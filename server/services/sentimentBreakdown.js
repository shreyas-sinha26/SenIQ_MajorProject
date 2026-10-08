/**
 * Sentiment breakdown — the Analytics page's "why is the score what it is".
 *
 * For each holding, the parts behind its sentiment score, all from the same rows and
 * maths as the engine's own score (sentimentScoring.js), so nothing here can disagree
 * with it:
 *   score      the Acute score, 0–100 (recency × source × confidence weighted, last 72h)
 *   split      how many of those articles read positive / mixed / negative
 *   confidence how sure the classifier was, on average
 *   momentum   the last 7 days against the 7 before
 *   trend      one average per day for the last 14 days
 *   baseline   the holding's own 90-day normal and how far today sits from it (z)   [Plus]
 *   drivers    the stories that moved the score most, with each one's share          [Plus]
 * plus a portfolio roll-up: the plain average, the average weighted by position size, and
 * which holdings pull it up or down.
 *
 * buildSentimentBreakdown() is pure; loadSentimentBreakdown() reads the database.
 */

const { SENTIMENT } = require('../config');
const { computeWindowedSentiment, explainSentiment, labelFor } = require('./sentimentScoring');

const HOUR_MS = 3_600_000;
const TREND_DAYS = 14;
const pts = (score) => (score == null ? null : Math.round(Number(score) * 100));
const round = (n, d = 2) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * @param holdings     [{ticker, company_name, exposure_pct, change_pct, currency}]
 * @param rowsByTicker { TICKER: [{id, event_id, title, url, source, platform, published_at, score, confidence}] }
 * @param opts         { full: include baseline + drivers (Plus and above), now }
 */
function buildSentimentBreakdown(holdings, rowsByTicker, { full = false, now = Date.now() } = {}) {
  const out = [];
  for (const h of holdings || []) {
    const rows = rowsByTicker[h.ticker] || [];
    const s = computeWindowedSentiment(rows, now);

    const split = { positive: 0, neutral: 0, negative: 0 };
    const byDay = new Map();
    let latest = null; // the newest article on this holding
    for (const r of rows) {
      const t = new Date(r.published_at).getTime();
      const score = Number(r.score);
      if (!Number.isFinite(t) || !Number.isFinite(score) || t > now + HOUR_MS) continue;
      const ageH = (now - t) / HOUR_MS;
      if (r.title && (!latest || t > latest.t)) latest = { t, title: r.title };
      if (ageH <= SENTIMENT.ACUTE_WINDOW_HOURS) split[labelFor(score)]++;
      if (ageH <= TREND_DAYS * 24) {
        const d = byDay.get(dayOf(t)) || { sum: 0, n: 0 };
        d.sum += score; d.n++;
        byDay.set(dayOf(t), d);
      }
    }
    const trend = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, d]) => ({ date, score: pts(d.sum / d.n), articles: d.n }));

    const item = {
      ticker: h.ticker,
      name: h.company_name || h.ticker,
      exposure_pct: h.exposure_pct ?? null,
      change_pct: h.change_pct ?? null,
      has_news: s.acute.count > 0,
      latest_headline: latest ? String(latest.title).slice(0, 200) : null,
      score: pts(s.acute.score),
      label: s.acute.label,
      articles: s.acute.count,
      split,
      confidence: s.acute.count ? Math.round(s.acute.confidence * 100) : null,
      momentum: { direction: s.momentum.direction, delta: s.momentum.delta == null ? null : Math.round(s.momentum.delta * 100) },
      trend,
    };
    if (full) {
      const x = explainSentiment(rows, { now, limit: 3 });
      item.baseline = s.baseline.z == null
        ? { usual: null, z: null, points: s.baseline.points }
        : { usual: pts(s.baseline.mean), z: round(s.baseline.z, 1), points: s.baseline.points };
      // In z units when there is a baseline, otherwise in score points away from neutral.
      const scale = x.basis === 'baseline' ? 1 : 100;
      item.driver_unit = x.basis === 'baseline' ? 'sigma' : 'points';
      item.drivers = x.drivers.map((d) => ({
        title: String(d.title).slice(0, 160), url: d.url, source: d.source, date: dayOf(d.published_at),
        articles: d.articles, direction: d.direction, contribution: round(d.contribution * scale, scale === 1 ? 2 : 1),
      }));
      item.other_stories = x.rest.stories;
    }
    out.push(item);
  }

  const withNews = out.filter((h) => h.has_news);
  const weight = withNews.reduce((a, h) => a + (h.exposure_pct || 0), 0);
  const count = (label) => withNews.filter((h) => h.label === label).length;
  // Pull = how far a holding drags the weighted score off neutral: (score − 50) × its share.
  const pulls = withNews
    .map((h) => ({ ticker: h.ticker, score: h.score, exposure_pct: h.exposure_pct, pull: round(((h.score - 50) * (h.exposure_pct || 0)) / (weight || 1), 1) }))
    .sort((a, b) => a.pull - b.pull);
  const portfolio = {
    score: withNews.length ? Math.round(withNews.reduce((a, h) => a + h.score, 0) / withNews.length) : null,
    weighted_score: withNews.length && weight > 0 ? Math.round(withNews.reduce((a, h) => a + h.score * (h.exposure_pct || 0), 0) / weight) : null,
    holdings: out.length, with_news: withNews.length,
    positive: count('positive'), neutral: count('neutral'), negative: count('negative'),
    biggest_drag: pulls.length && pulls[0].pull < 0 ? pulls[0] : null,
    biggest_lift: pulls.length && pulls[pulls.length - 1].pull > 0 ? pulls[pulls.length - 1] : null,
  };
  portfolio.label = portfolio.weighted_score == null ? 'neutral' : labelFor(portfolio.weighted_score / 100);

  return {
    window_hours: SENTIMENT.ACUTE_WINDOW_HOURS, baseline_days: SENTIMENT.BASELINE_DAYS,
    depth: full ? 'full' : 'basic', portfolio, holdings: out,
  };
}

async function loadSentimentBreakdown(userId, { full = false } = {}) {
  const { query } = require('../db');
  const holdings = await require('./portfolioService').getWeightedHoldings(userId);
  if (!holdings.length) return buildSentimentBreakdown([], {}, { full });
  const rows = await query(
    `SELECT s.ticker, a.id, a.event_id, a.title, a.url, a.source, a.platform, a.published_at,
            s.sentiment_score AS score, s.confidence
       FROM article_sentiments s
       JOIN articles a ON a.id = s.article_id
      WHERE s.ticker = ANY($1)
        AND a.published_at > now() - ($2 || ' days')::interval`,
    [holdings.map((h) => h.ticker), String(SENTIMENT.BASELINE_DAYS)]);
  const byTicker = {};
  for (const r of rows) (byTicker[r.ticker] ||= []).push(r);
  const sorted = holdings.slice().sort((a, b) => (b.exposure_pct ?? 0) - (a.exposure_pct ?? 0));
  return buildSentimentBreakdown(sorted, byTicker, { full });
}

module.exports = { buildSentimentBreakdown, loadSentimentBreakdown };
