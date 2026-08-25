const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

async function explainForPortfolio(text, sentiment, matchedTickers, portfolioTickers) {
  const relevantOwned = matchedTickers.filter(t => t !== '__MARKET__' && portfolioTickers.includes(t));
  const otherMatched = matchedTickers.filter(t => t !== '__MARKET__' && !portfolioTickers.includes(t));

  const portfolioLine = portfolioTickers.length > 0
    ? `Investor's portfolio: ${portfolioTickers.join(', ')}.`
    : 'No portfolio holdings provided.';

  const relevanceLine = relevantOwned.length > 0
    ? `This news directly affects held positions: ${relevantOwned.join(', ')}.`
    : otherMatched.length > 0
      ? `This news mentions ${otherMatched.join(', ')} which are not in the portfolio.`
      : 'No specific portfolio holdings mentioned in this news.';

  const prompt = `You are a concise financial analyst. A retail investor wants to understand what a piece of news means for their portfolio.

${portfolioLine}
${relevanceLine}
Sentiment detected: ${sentiment.label} (confidence ${Math.round(sentiment.confidence * 100)}%)

News text: "${text.substring(0, 600)}"

In 2-3 sentences, explain what this means for the investor's portfolio. Be specific about affected stocks and why. Skip generic disclaimers.`;

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 180 }
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = await response.json();
  return data.response?.trim() || null;
}

/**
 * Generic single-shot completion against the same local Ollama instance. Used as the
 * middle fallback tier (Claude → Ollama → template) for prose that isn't the news
 * explainer above. Throws if Ollama is unreachable/errors so callers can fall through
 * to their deterministic template.
 */
async function generate(prompt, { numPredict = 300, temperature = 0.3, timeoutMs = 30000 } = {}) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature, num_predict: numPredict }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = await response.json();
  return data.response?.trim() || null;
}

module.exports = { explainForPortfolio, generate, OLLAMA_MODEL };
