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
const { fetchFinnhub, fetchRotation } = require('./finnhub');
const { fetchGdelt } = require('./gdelt');
const { fetchRss } = require('./rss');
const { fetchReddit } = require('./reddit');
const { fetchX } = require('./x');
const { getDemoNews } = require('./demo');

// The first copy of a story is kept. A later copy adds the feeds it came from, and a story
// is `rotationOnly` only while every copy of it is.
function dedupe(articles) {
  const byId = new Map();
  const byUrl = new Map();
  const out = [];
  for (const a of articles) {
    if (!a || !a.title) continue;
    const urlKey = a.url && a.url !== '#' ? a.url : null;
    const kept = (a.external_id && byId.get(a.external_id)) || (urlKey && byUrl.get(urlKey));
    if (kept) {
      if (a.feeds && a.feeds.length) kept.feeds = [...new Set([...(kept.feeds || []), ...a.feeds])];
      if (kept.rotationOnly && !a.rotationOnly) delete kept.rotationOnly;
      continue;
    }
    const copy = { ...a };
    if (a.external_id) byId.set(a.external_id, copy);
    if (urlKey) byUrl.set(urlKey, copy);
    out.push(copy);
  }
  return out;
}

// `alsoCompanyNews`: tickers nobody holds whose company news is wanted all the same (IPO
// Watch's newly filed and priced issues). They go to the per-ticker source only.
// `rotation`: this run's batch of the US shares nobody holds (usNews.js). Fetched after the
// others from the same source, one at a time, so the two never call it at once.
// Returns { articles, counts, rotation: { checked, stopped } }.
async function gatherArticles(tickers = [], alsoCompanyNews = [], rotation = []) {
  let rotated = { checked: [], stopped: null };
  const jobs = [{
    name: 'finnhub',
    run: async () => {
      const own = await fetchFinnhub([...new Set([...tickers, ...alsoCompanyNews])]);
      if (!rotation.length) return own;
      const r = await fetchRotation(rotation);
      rotated = { checked: r.checked, stopped: r.stopped };
      return [...own, ...r.articles];
    },
  }];
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
  return { articles, counts, rotation: rotated };
}

module.exports = { gatherArticles, dedupe };
