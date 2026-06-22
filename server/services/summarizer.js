/**
 * Article Summarizer Service
 * Extractive summarization for financial news — picks key sentences.
 */

/**
 * Summarize a single article (extractive — returns key sentences)
 */
function summarizeArticle(title, content) {
  if (!content || content.length < 50) return title;
  const sentences = content.match(/[^.!?]+[.!?]+/g) || [content];
  if (sentences.length <= 2) return content;
  // Score sentences by keyword density
  const keywords = ['revenue', 'profit', 'growth', 'decline', 'beat', 'miss',
    'upgrade', 'downgrade', 'earnings', 'forecast', 'target', 'price',
    'shares', 'stock', 'market', 'analyst', 'billion', 'million', 'percent'];
  const scored = sentences.map(s => ({
    text: s.trim(),
    score: keywords.filter(k => s.toLowerCase().includes(k)).length
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map(s => s.text).join(' ');
}

/**
 * Generate a digest summary from multiple articles for a ticker
 */
function generateDigest(articles, ticker) {
  if (!articles || articles.length === 0) return `No recent news for ${ticker}.`;
  const positiveCount = articles.filter(a => a.sentiment?.label === 'positive').length;
  const negativeCount = articles.filter(a => a.sentiment?.label === 'negative').length;
  const neutralCount = articles.length - positiveCount - negativeCount;

  let overallTone;
  if (positiveCount > negativeCount * 2) overallTone = 'bullish';
  else if (negativeCount > positiveCount * 2) overallTone = 'bearish';
  else if (positiveCount > negativeCount) overallTone = 'slightly positive';
  else if (negativeCount > positiveCount) overallTone = 'slightly negative';
  else overallTone = 'mixed';

  const topHeadlines = articles.slice(0, 3).map(a => `• ${a.title}`).join('\n');
  return `${ticker} sentiment is ${overallTone} based on ${articles.length} articles ` +
    `(${positiveCount} positive, ${negativeCount} negative, ${neutralCount} neutral).\n\n` +
    `Key headlines:\n${topHeadlines}`;
}

/**
 * Generate a portfolio-wide digest
 */
function generatePortfolioDigest(tickerArticlesMap) {
  const summaries = [];
  for (const [ticker, articles] of Object.entries(tickerArticlesMap)) {
    if (articles.length === 0) continue;
    const avgScore = articles.reduce((s, a) => s + (a.sentiment?.score || 0.5), 0) / articles.length;
    let emoji, tone;
    if (avgScore > 0.65) { emoji = '🟢'; tone = 'Bullish'; }
    else if (avgScore < 0.35) { emoji = '🔴'; tone = 'Bearish'; }
    else { emoji = '🟡'; tone = 'Neutral'; }
    summaries.push(`${emoji} ${ticker}: ${tone} (${articles.length} articles)`);
  }
  if (summaries.length === 0) return 'No recent news for your portfolio.';
  return `Portfolio Digest:\n${summaries.join('\n')}`;
}

module.exports = { summarizeArticle, generateDigest, generatePortfolioDigest };
