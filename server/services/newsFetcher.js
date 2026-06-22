/**
 * News Fetcher — the low-latency (lexicon) enrichment path over the multi-source
 * ingestion orchestrator. Used by the live /api/news routes where speed matters;
 * the batch cron uses the same raw articles but classifies with FinBERT.
 *
 * Phase 2: raw fetching moved into services/ingest/* (Finnhub + GDELT + RSS +
 * Reddit, X stubbed). This module just attaches ticker matches + lexicon sentiment.
 */

const { analyzeSentiment } = require('./sentiment');
const { matchTickers } = require('./tickerMatcher');
const { gatherArticles } = require('./ingest');

// Attach matchedTickers + lexicon sentiment to raw articles. Macro-platform
// articles always carry the __MARKET__ tag so they reach every portfolio.
function enrichWithLexicon(articles) {
  return articles.map((article) => {
    const matched = matchTickers(article.title, article.summary);
    if (article.platform === 'macro' && !matched.includes('__MARKET__')) matched.push('__MARKET__');
    const sentiment = analyzeSentiment(`${article.title} ${article.summary}`);
    return { ...article, matchedTickers: matched, sentiment };
  });
}

// Back-compat signature (apiKey is now read from env inside the orchestrator).
async function fetchNewsForTickers(tickers /* , apiKey */) {
  const { articles } = await gatherArticles(tickers);
  return enrichWithLexicon(articles);
}

module.exports = { fetchNewsForTickers, enrichWithLexicon };
