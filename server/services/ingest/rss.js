/**
 * RSS ingestion (Phase 2b) — Indian financial feeds (Economic Times / LiveMint /
 * Moneycontrol / Business Standard) for ticker-level India news Finnhub misses.
 * Dependency-free: a small, forgiving <item> parser (these feeds are plain RSS 2.0).
 * Any feed that errors or times out is simply skipped.
 */

const { INGEST } = require('../../config');
const { hashId, stripHtml, clampText, fetchWithTimeout } = require('./util');

function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  return m ? stripHtml(m[1]) : '';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'rss';
  }
}

function parseItems(xml, feedUrl) {
  const items = [];
  const re = /<item[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    const title = tag(block, 'title');
    const link = tag(block, 'link');
    if (!title || !link) continue;
    const desc = tag(block, 'description');
    const pub = tag(block, 'pubDate');
    const ts = pub ? new Date(pub) : new Date();
    items.push({
      external_id: hashId('rss', link),
      title: clampText(title, 300),
      summary: clampText(desc),
      source: hostOf(link) || hostOf(feedUrl),
      url: link,
      image_url: '',
      published_at: (Number.isFinite(ts.getTime()) ? ts : new Date()).toISOString(),
      platform: 'news',
    });
  }
  return items;
}

async function fetchFeed(feedUrl) {
  try {
    const res = await fetchWithTimeout(feedUrl, { headers: { 'User-Agent': 'seniq/0.1' } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseItems(xml, feedUrl);
  } catch {
    return [];
  }
}

async function fetchRss() {
  const results = await Promise.allSettled(INGEST.RSS_FEEDS.map(fetchFeed));
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

module.exports = { fetchRss, parseItems };
