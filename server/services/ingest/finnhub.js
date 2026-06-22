/**
 * Finnhub company-news ingestion (Phase 1 source, normalized into the Phase 2
 * article shape). US-centric and free-tier-thin for NSE/BSE names — GDELT + RSS
 * cover the India gap. No key → returns [] (the orchestrator falls back to demo).
 */

const { clampText } = require('./util');

async function fetchOne(ticker, apiKey) {
  try {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
    const from = weekAgo.toISOString().split('T')[0];
    const to = today.toISOString().split('T')[0];
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.slice(0, 10).map((a) => ({
      external_id: `finnhub_${a.id}`,
      title: clampText(a.headline || '', 300),
      summary: clampText(a.summary || ''),
      source: a.source || 'Finnhub',
      url: a.url || '',
      image_url: a.image || '',
      published_at: new Date(a.datetime * 1000).toISOString(),
      platform: 'news',
    }));
  } catch {
    return [];
  }
}

async function fetchFinnhub(tickers = []) {
  const apiKey = process.env.FINNHUB_API_KEY || '';
  if (!apiKey) return [];
  const out = [];
  for (const t of tickers) out.push(...(await fetchOne(t, apiKey)));
  return out;
}

module.exports = { fetchFinnhub };
