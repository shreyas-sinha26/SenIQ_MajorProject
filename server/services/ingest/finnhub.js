/**
 * Finnhub company-news ingestion (Phase 1 source, normalized into the Phase 2
 * article shape). US-centric and free-tier-thin for NSE/BSE names — GDELT + RSS
 * cover the India gap. No key → returns [] (the orchestrator falls back to demo).
 *
 * Every story carries `feeds`: the ticker whose company news it came from. The entity
 * resolver tags a US listed name only on a story from its own feed.
 *
 * Every call goes through the Finnhub gate (services/finnhubGate.js), which spaces a run's
 * calls and keeps them inside the minute's limit.
 */

const { US_NEWS } = require('../../config');
const { clampText } = require('./util');
const finnhubGate = require('../finnhubGate');

// One ticker's company news for the last 7 days, newest first. `status` is the HTTP status,
// 0 when the request itself failed; `held` is set when the gate did not send it.
async function fetchOne(ticker, purpose, gate) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
  const from = weekAgo.toISOString().split('T')[0];
  const to = today.toISOString().split('T')[0];
  const { ok, status, data, held } = await gate.get('/company-news', { symbol: ticker, from, to }, { purpose });
  if (!ok) return { status, held, articles: [] };
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
  return { status, held, articles };
}

/**
 * One list of tickers, one call each, in order. A refusal for the rate limit (429), a
 * request that fails outright, or a call the gate did not send ends the list: the names not
 * reached are not `checked`, so the next run starts with them. Any other answer counts as
 * checked, so one ticker Finnhub does not know cannot hold up the queue. Nothing is retried.
 * @returns { articles, checked, stopped } — `stopped` is null, 'rate_limit', 'unreachable'
 *   or 'not_sent' (null too when there is no key: nothing was asked).
 */
async function fetchList(tickers, purpose, gate) {
  const out = { articles: [], checked: [], stopped: null };
  for (const t of tickers) {
    const { status, held, articles } = await fetchOne(t, purpose, gate);
    if (held) { out.stopped = held === 'no_key' ? null : 'not_sent'; break; }
    if (status === 429 || status === 0) { out.stopped = status === 429 ? 'rate_limit' : 'unreachable'; break; }
    out.checked.push(t);
    out.articles.push(...articles);
  }
  return out;
}

/**
 * A run's company news, in a fixed order: the held tickers, then IPO Watch's, then the
 * rotation's names (the US shares nobody holds; each of their stories is marked
 * `rotationOnly`, and the pipeline drops such a story when it names no company). Whatever
 * stops one list stops the run: the lists after it are not asked for.
 * @returns { articles, checked: { held, ipo, rotation }, stopped }
 */
async function fetchRun({ held = [], ipo = [], rotation = [], purpose = 'held' } = {}, { gate = finnhubGate } = {}) {
  const out = { articles: [], checked: { held: [], ipo: [], rotation: [] }, stopped: null };
  for (const [list, tickers, as] of [['held', held, purpose], ['ipo', ipo, 'ipo'], ['rotation', rotation, 'rotation']]) {
    const r = await fetchList(tickers, as, gate);
    out.checked[list] = r.checked;
    out.articles.push(...(list === 'rotation' ? r.articles.map((a) => ({ ...a, rotationOnly: true })) : r.articles));
    if (r.stopped) { out.stopped = r.stopped; break; }
  }
  return out;
}

// The rotation alone (scripts/us_news.js `try`). @returns { articles, checked, stopped }
async function fetchRotation(tickers = [], opts = {}) {
  const r = await fetchRun({ rotation: tickers }, opts);
  return { articles: r.articles, checked: r.checked.rotation, stopped: r.stopped };
}

module.exports = { fetchRun, fetchRotation };
