/**
 * Finnhub company-news ingestion (Phase 1 source, normalized into the Phase 2
 * article shape). US-centric and free-tier-thin for NSE/BSE names — GDELT + RSS
 * cover the India gap. No key → returns [] (the orchestrator falls back to demo).
 *
 * Every story carries `feeds`: the ticker whose company news it came from. The entity
 * resolver tags a US listed name only on a story from its own feed.
 */

const { US_NEWS } = require('../../config');
const { clampText } = require('./util');

// One ticker's company news for the last 7 days, newest first. `status` is the HTTP status,
// 0 when the request itself failed.
async function fetchOne(ticker, apiKey, fetchImpl = fetch) {
  try {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
    const from = weekAgo.toISOString().split('T')[0];
    const to = today.toISOString().split('T')[0];
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${apiKey}`;
    const res = await fetchImpl(url);
    if (!res.ok) return { status: res.status, articles: [] };
    const data = await res.json();
    const articles = (Array.isArray(data) ? data : []).slice(0, US_NEWS.STORIES_PER_NAME).map((a) => ({
      external_id: `finnhub_${a.id}`,
      title: clampText(a.headline || '', 300),
      summary: clampText(a.summary || ''),
      source: a.source || 'Finnhub',
      url: a.url || '',
      image_url: a.image || '',
      published_at: new Date(a.datetime * 1000).toISOString(),
      platform: 'news',
      feeds: [ticker],
    }));
    return { status: res.status, articles };
  } catch {
    return { status: 0, articles: [] };
  }
}

async function fetchFinnhub(tickers = []) {
  const apiKey = process.env.FINNHUB_API_KEY || '';
  if (!apiKey) return [];
  const out = [];
  for (const t of tickers) out.push(...(await fetchOne(t, apiKey)).articles);
  return out;
}

/**
 * The rotation: company news for names nobody holds, one call each, `gapMs` apart so the
 * minute's limit is left for quotes. A refusal for the rate limit (429), or a request that
 * fails outright, ends the batch: the names not reached are not `checked`, so the next run
 * starts with them. Any other answer counts as checked, so one ticker Finnhub does not know
 * cannot hold up the queue. Every story is marked `rotationOnly` (the pipeline drops such a
 * story when it names no company).
 * @returns { articles, checked, stopped } — `stopped` is null, 'rate_limit' or 'unreachable'.
 */
async function fetchRotation(tickers = [], { gapMs = US_NEWS.CALL_GAP_MS, fetchImpl = fetch, apiKey = process.env.FINNHUB_API_KEY || '' } = {}) {
  const out = { articles: [], checked: [], stopped: null };
  if (!apiKey) return out;
  for (const [i, t] of tickers.entries()) {
    if (i && gapMs) await new Promise((r) => setTimeout(r, gapMs));
    const { status, articles } = await fetchOne(t, apiKey, fetchImpl);
    if (status === 429 || status === 0) { out.stopped = status === 429 ? 'rate_limit' : 'unreachable'; break; }
    out.checked.push(t);
    for (const a of articles) out.articles.push({ ...a, rotationOnly: true });
  }
  return out;
}

module.exports = { fetchFinnhub, fetchRotation };
