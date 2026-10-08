/**
 * News relevance + de-spam (Phase 3.5).
 *
 * Two jobs, run on every ingested article BEFORE it reaches the feed:
 *
 *  1. classifyArticle() — grade the article into the only three buckets a user
 *     cares about and score how important it is:
 *       - 'holding' : mentions something the user base tracks (always relevant)
 *       - 'market'  : broad market-moving news (rates, inflation, crash…)        ┐ apply
 *       - 'world'   : major world affairs that move markets (war, sanctions…)    ┘ to all
 *       - 'none'    : noise → flagged is_relevant=false, kept in DB, hidden from feed
 *     importance = keyword-tier weight × source credibility. Market/world must
 *     clear RELEVANT_THRESHOLD ("balanced"); a holding match is always relevant.
 *
 *  2. clusterKey() — give every near-duplicate of one real event the SAME key, so
 *     the feed shows one card per event (with a source count) instead of the same
 *     story from ET + Mint + Moneycontrol + Reuters, and alerts fire once per event.
 *
 * Pure functions (no DB) so the grading is testable offline.
 */

const crypto = require('crypto');
const { NEWS_RELEVANCE } = require('../config');
const { sourceWeight } = require('./sentimentScoring');

// Common words that carry no event identity — dropped before clustering so two
// outlets phrasing the same story differently still collide.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
  'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'will', 'would',
  'this', 'that', 'these', 'those', 'it', 'its', 'has', 'have', 'had', 'after',
  'over', 'amid', 'into', 'up', 'down', 'new', 'says', 'said', 'report', 'reports',
  'update', 'live', 'breaking', 'news', 'today', 'latest', 'how', 'why', 'what',
  'amp', 'vs', 'per', 'cent', 'percent', 'rs', 'crore', 'lakh', 'inc', 'ltd',
]);

// Crude suffix stemmer so "announces"/"announced", "share"/"shares" collide.
function stem(w) {
  w = w.replace(/'s$/, '');
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function salientTokens(title = '') {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Stable key shared by duplicates of one event. Built from the article's most
 * salient title tokens (sorted so word order doesn't matter), the primary subject
 * (a matched ticker, else the tier), and a time bucket so the same headline
 * recurring weeks later is a new event — not a duplicate of the old one.
 */
function clusterKey(title, primaryRef, publishedAt) {
  const tokens = [...new Set(salientTokens(title))].sort().slice(0, NEWS_RELEVANCE.CLUSTER_TOKENS);
  const t = new Date(publishedAt).getTime();
  const bucket = Number.isFinite(t)
    ? Math.floor(t / (NEWS_RELEVANCE.CLUSTER_WINDOW_HOURS * 3_600_000))
    : 0;
  const sig = `${primaryRef || 'gen'}|${bucket}|${tokens.join('-')}`;
  return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 16);
}

// Highest keyword tier the text hits for a given dictionary, or null.
function keywordTier(text, dict) {
  if (dict.high.some((k) => text.includes(k))) return 'high';
  if (dict.med.some((k) => text.includes(k))) return 'med';
  return null;
}

/**
 * Grade one article. `matched` is the ticker-matcher output (may include __MARKET__).
 * `opts.aboutMarket`: the story names tracked companies but is about none of them — a
 * roundup ("Stocks to watch: TCS, Paytm…") or a broad-market story (subjectTickers). A
 * holder still wants to see it, so it stays in the feed as a market story even when the
 * headline has no market keyword.
 * Returns { tier, importance, isRelevant, primaryRef } — primaryRef seeds clustering.
 */
function classifyArticle(article, matched = [], opts = {}) {
  const srcW = sourceWeight(article.source, article.platform);
  const heldTickers = matched.filter((t) => t && t !== '__MARKET__');

  // 1) Direct holding match — the user owns it, so it's always relevant.
  if (heldTickers.length > 0) {
    const importance = Math.min(1, NEWS_RELEVANCE.HOLDING_BASE * Math.max(srcW, 0.5));
    return { tier: 'holding', importance: round(importance), isRelevant: true, primaryRef: heldTickers[0] };
  }

  // Tier is decided by the HEADLINE, not the body: a stocks-highs story whose
  // summary happens to mention "trade war" is a markets story, not world news.
  const title = (article.title || '').toLowerCase();

  // 2) Major world affairs (checked before market: war/sanctions outrank "economy").
  const worldT = keywordTier(title, NEWS_RELEVANCE.WORLD_KEYWORDS);
  // 3) Broad market-moving news: a title keyword, or a genuinely macro-sourced
  //    article (GDELT). A bare __MARKET__ tag from a summary match does NOT qualify
  //    — that's how generic filler used to reach everyone.
  const isMacro = article.platform === 'macro';
  const marketT = keywordTier(title, NEWS_RELEVANCE.MARKET_KEYWORDS);

  if (worldT) {
    const importance = NEWS_RELEVANCE.TIER_WEIGHT[worldT] * srcW;
    return verdict('world', importance, srcW);
  }
  if (marketT || isMacro || opts.aboutMarket) {
    const tier = marketT || 'med';
    const importance = NEWS_RELEVANCE.TIER_WEIGHT[tier] * srcW;
    return verdict('market', importance, srcW);
  }

  // 4) Nothing the user cares about → noise.
  return { tier: 'none', importance: 0, isRelevant: false, primaryRef: null };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BROAD_MARKET_RE = new RegExp(
  `\\b(?:${NEWS_RELEVANCE.BROAD_MARKET_TERMS.map(escapeRe).join('|')}|nifty(?!\\s+(?:${NEWS_RELEVANCE.NIFTY_SECTORS.join('|')})\\b))\\b`);

/**
 * Which of the companies a story names it is ABOUT. The sentiment reading is one tone for
 * the whole text, so it is stored only against these; the rest are passing mentions.
 *   - a roundup headline (market wrap, gainers and losers, stocks to watch…) is about none
 *     of the companies it lists;
 *   - a broad-market headline (Sensex, Wall Street…) is about only the companies the
 *     headline itself names, not ones that appear in the summary.
 * `matched` is the resolver's output, `inHeadline` the tickers it finds in the title alone.
 * Returns `matched` without the passing mentions (order kept, __MARKET__ kept).
 */
function subjectTickers(title, matched = [], inHeadline = []) {
  if (isRoundup(title, inHeadline)) return matched.filter((x) => x === '__MARKET__');
  const head = new Set(inHeadline);
  if (BROAD_MARKET_RE.test(String(title || '').toLowerCase())) return matched.filter((x) => x === '__MARKET__' || head.has(x));
  return matched;
}

// A headline that lists movers rather than reporting on one company.
function isRoundup(title, inHeadline = []) {
  const t = String(title || '').toLowerCase();
  return NEWS_RELEVANCE.ROUNDUP_PHRASES.some((p) => t.includes(p))
    || (new Set(inHeadline).size >= 2 && NEWS_RELEVANCE.ROUNDUP_PHRASES_MULTI.some((p) => t.includes(p)));
}

function verdict(tier, importance, _srcW) {
  const isRelevant = importance >= NEWS_RELEVANCE.RELEVANT_THRESHOLD;
  return {
    tier: isRelevant ? tier : 'none',
    importance: round(importance),
    isRelevant,
    primaryRef: tier, // market/world cluster by tier (+ title tokens + time)
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

// Jaccard similarity of two stemmed token sets.
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function timeBucket(publishedAt) {
  const t = new Date(publishedAt).getTime();
  return Number.isFinite(t) ? Math.floor(t / (NEWS_RELEVANCE.CLUSTER_WINDOW_HOURS * 3_600_000)) : 0;
}

/**
 * Assign a cluster_key to every article in one ingest batch. Starts from each
 * article's exact-token key (stable across runs for verbatim/syndicated copy),
 * then greedily merges articles in the same time window whose stemmed headlines
 * are ≥ CLUSTER_SIM similar (union-find) — this is what collapses the same story
 * arriving from GDELT + four RSS feeds in one run into a single event.
 *
 * @param {Array<{title:string, relevance:{primaryRef:string|null}, published_at:any}>} items
 * @returns {string[]} cluster_key per item (index-aligned)
 */
function assignClusters(items) {
  const base = items.map((it) => clusterKey(it.title, it.relevance?.primaryRef, it.published_at));
  const sets = items.map((it) => new Set(salientTokens(it.title)));
  const buckets = items.map((it) => timeBucket(it.published_at));
  const refs = items.map((it) => it.relevance?.primaryRef || null);

  const parent = items.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i, j) => { parent[find(i)] = find(j); };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (buckets[i] !== buckets[j] || refs[i] !== refs[j]) continue;
      if (jaccard(sets[i], sets[j]) >= NEWS_RELEVANCE.CLUSTER_SIM) union(i, j);
    }
  }
  // All members of a group share the root's base key (deterministic representative).
  return items.map((_, i) => base[find(i)]);
}

module.exports = { classifyArticle, subjectTickers, isRoundup, clusterKey, assignClusters, salientTokens, jaccard };
