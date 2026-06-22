/**
 * Ingestion orchestrator (Phase 2b). Runs every enabled source in parallel,
 * normalizes them into one article shape, and dedupes. Sources are flag-gated in
 * config.FEATURES; each source already degrades to [] on error, so a single dead
 * feed never breaks the run. If *everything* comes back empty (offline, no keys),
 * fall back to the demo set so the app stays demonstrable.
 *
 * Returns RAW articles (no sentiment / ticker matching) — classification is a
 * separate step, so the live path can use the cheap lexicon while the batch cron
 * uses FinBERT (the decided model split).
 *
 * Article shape:
 *   { external_id, title, summary, source, url, image_url, published_at, platform }
 */

const { FEATURES } = require('../../config');
const { fetchFinnhub } = require('./finnhub');
const { fetchGdelt } = require('./gdelt');
const { fetchRss } = require('./rss');
const { fetchReddit } = require('./reddit');
const { fetchX } = require('./x');
const { getDemoNews } = require('./demo');

function dedupe(articles) {
  const byId = new Set();
  const byUrl = new Set();
  const out = [];
  for (const a of articles) {
    if (!a || !a.title) continue;
    if (a.external_id && byId.has(a.external_id)) continue;
    const urlKey = a.url && a.url !== '#' ? a.url : null;
    if (urlKey && byUrl.has(urlKey)) continue;
    if (a.external_id) byId.add(a.external_id);
    if (urlKey) byUrl.add(urlKey);
    out.push(a);
  }
  return out;
}

async function gatherArticles(tickers = []) {
  const jobs = [{ name: 'finnhub', run: () => fetchFinnhub(tickers) }];
  if (FEATURES.MACRO_INGEST) jobs.push({ name: 'gdelt', run: () => fetchGdelt(tickers) });
  if (FEATURES.RSS_INGEST) jobs.push({ name: 'rss', run: () => fetchRss() });
  if (FEATURES.REDDIT_INGEST) jobs.push({ name: 'reddit', run: () => fetchReddit() });
  if (FEATURES.X_INGEST) jobs.push({ name: 'x', run: () => fetchX() });

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const counts = {};
  let all = [];
  settled.forEach((r, i) => {
    const arts = r.status === 'fulfilled' ? r.value : [];
    counts[jobs[i].name] = arts.length;
    all = all.concat(arts);
  });

  let articles = dedupe(all);
  if (articles.length === 0) {
    articles = getDemoNews();
    counts.demo = articles.length;
  }
  return { articles, counts };
}

module.exports = { gatherArticles, dedupe };
