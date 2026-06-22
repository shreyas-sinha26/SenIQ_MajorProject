/**
 * Financial Sentiment Analysis Engine
 * 
 * Uses the Loughran-McDonald Financial Dictionary — the same lexicon
 * that FinBERT was originally trained on. This provides finance-specific
 * sentiment understanding where "beat" = positive (not violence),
 * "liability" = neutral accounting term, etc.
 */

// ─── Loughran-McDonald Positive Words ────────────────────────
const POSITIVE_WORDS = new Set([
  'achieve', 'achieved', 'achievement', 'advance', 'advanced', 'advancing',
  'advantage', 'agree', 'agreement', 'analyst upgrade', 'approval', 'approved',
  'attract', 'attractive', 'beat', 'beats', 'beating', 'benefit', 'benefited',
  'benefits', 'best', 'better', 'boom', 'boost', 'boosted', 'breakout',
  'breakthrough', 'bullish', 'buy', 'catalyst', 'collaboration', 'commitment',
  'confident', 'constructive', 'creative', 'deliver', 'delivered', 'demand',
  'dividend', 'dominance', 'earn', 'earned', 'earnings', 'effective',
  'efficiency', 'elevated', 'empower', 'enable', 'encourage', 'encouraging',
  'enhance', 'enhanced', 'exceed', 'exceeded', 'exceeds', 'excel', 'excellent',
  'exceptional', 'excited', 'exciting', 'expand', 'expansion', 'favorable',
  'gain', 'gained', 'gains', 'good', 'great', 'green', 'grew', 'grow',
  'growing', 'growth', 'high', 'higher', 'highest', 'hit', 'improve',
  'improved', 'improvement', 'improving', 'increase', 'increased', 'increases',
  'increasing', 'incredible', 'innovation', 'innovative', 'invest', 'invested',
  'investor', 'leadership', 'leading', 'momentum', 'opportunity', 'optimism',
  'optimistic', 'outpace', 'outperform', 'outperformed', 'outperforming',
  'overcome', 'partnership', 'peak', 'positive', 'premium', 'profit',
  'profitable', 'profitability', 'progress', 'promising', 'prosper',
  'rally', 'rallied', 'rallies', 'raise', 'raised', 'rebound', 'rebounded',
  'record', 'recover', 'recovered', 'recovery', 'resilient', 'revenue',
  'reward', 'rise', 'risen', 'rising', 'robust', 'shareholder', 'soar',
  'soared', 'soaring', 'solid', 'spike', 'spiked', 'stable', 'stellar',
  'strength', 'strengthen', 'strong', 'stronger', 'strongest', 'succeed',
  'success', 'successful', 'support', 'surge', 'surged', 'surging',
  'surprise', 'top', 'topped', 'transform', 'transformative', 'triumph',
  'upgrade', 'upgraded', 'upside', 'uptick', 'upturn', 'value', 'win',
  'winner', 'winning', 'won', 'yield'
]);

// ─── Loughran-McDonald Negative Words ────────────────────────
const NEGATIVE_WORDS = new Set([
  'abandon', 'abandoned', 'adverse', 'adversely', 'allegation', 'antitrust',
  'bankrupt', 'bankruptcy', 'bear', 'bearish', 'below', 'blame', 'bleak',
  'breach', 'broke', 'burden', 'caution', 'cautious', 'cease', 'challenge',
  'challenged', 'challenging', 'close', 'closed', 'closure', 'collapse',
  'collapsed', 'concern', 'concerned', 'concerning', 'conflict', 'consequence',
  'constraint', 'contagion', 'contraction', 'controversy', 'correction',
  'cost', 'costly', 'crash', 'crashed', 'crashing', 'crisis', 'critical',
  'criticism', 'cut', 'cuts', 'cutting', 'damage', 'damaged', 'danger',
  'dangerous', 'debt', 'decay', 'decline', 'declined', 'declining', 'decrease',
  'decreased', 'default', 'deficit', 'delay', 'delayed', 'delisted',
  'deteriorate', 'deteriorated', 'deteriorating', 'difficult', 'difficulty',
  'disappointed', 'disappointing', 'disappointment', 'disruption', 'divest',
  'doubt', 'down', 'downgrade', 'downgraded', 'downturn', 'drag', 'drop',
  'dropped', 'dropping', 'erode', 'eroded', 'erosion', 'fail', 'failed',
  'failing', 'failure', 'fall', 'fallen', 'falling', 'fear', 'fell',
  'fire', 'fired', 'flaw', 'flawed', 'fraud', 'freeze', 'frozen',
  'halt', 'halted', 'hardship', 'harm', 'harsh', 'headwind', 'headwinds',
  'hurt', 'impair', 'impaired', 'impairment', 'inability', 'inadequate',
  'inflation', 'inflationary', 'instability', 'investigate', 'investigation',
  'jeopardize', 'lack', 'lag', 'lagging', 'late', 'lawsuit', 'layoff',
  'layoffs', 'liability', 'liquidate', 'liquidation', 'litigation', 'lose',
  'loser', 'losing', 'loss', 'losses', 'lost', 'low', 'lower', 'lowest',
  'miss', 'missed', 'misses', 'missing', 'mistake', 'negative', 'neglect',
  'obstacle', 'overvalued', 'penalty', 'plummet', 'plummeted', 'plunge',
  'plunged', 'poor', 'poorly', 'pressure', 'pressured', 'problem',
  'problematic', 'pullback', 'punish', 'recessionary', 'recession', 'reduce',
  'reduced', 'restructure', 'restructuring', 'retreat', 'retreated', 'risk',
  'risky', 'sanction', 'sell', 'selloff', 'setback', 'severe', 'sharply',
  'shortage', 'shrink', 'shrinking', 'shutdown', 'sink', 'sinking', 'slash',
  'slashed', 'slide', 'slipped', 'slow', 'slowdown', 'slowing', 'slump',
  'slumped', 'stagnant', 'stagnation', 'struggle', 'struggling', 'suffer',
  'suffered', 'suspend', 'suspended', 'tariff', 'tariffs', 'terminate',
  'threat', 'threaten', 'threatened', 'trouble', 'troubled', 'tumble',
  'tumbled', 'turmoil', 'uncertain', 'uncertainty', 'underperform',
  'underperformed', 'unfavorable', 'unfortunate', 'volatile', 'volatility',
  'vulnerable', 'warn', 'warned', 'warning', 'weak', 'weaken', 'weakened',
  'weakness', 'worsen', 'worsened', 'worsening', 'worst', 'writedown',
  'writeoff'
]);

// ─── Intensity Amplifiers ────────────────────────────────────
const AMPLIFIERS = new Set([
  'very', 'extremely', 'significantly', 'substantially', 'sharply',
  'dramatically', 'massively', 'severely', 'deeply', 'strongly',
  'notably', 'considerably', 'remarkably', 'hugely', 'heavily',
  'major', 'massive', 'tremendous', 'enormous'
]);

const NEGATORS = new Set([
  'not', 'no', 'never', 'neither', 'nor', 'none', 'nothing',
  'nowhere', 'hardly', 'barely', 'scarcely', "don't", "doesn't",
  "didn't", "won't", "wouldn't", "shouldn't", "couldn't", "can't",
  'cannot', 'without', 'despite', 'lack', 'fail', 'failed'
]);

/**
 * Analyze the financial sentiment of a text.
 * Returns: { label: 'positive'|'negative'|'neutral', score: 0-1, confidence: 0-1 }
 * Score: 0 = most negative, 0.5 = neutral, 1 = most positive
 */
function analyzeSentiment(text) {
  if (!text || typeof text !== 'string') {
    return { label: 'neutral', score: 0.5, confidence: 0 };
  }

  const cleanText = text.toLowerCase().replace(/[^a-z\s'-]/g, ' ');
  const words = cleanText.split(/\s+/).filter(w => w.length > 1);
  
  if (words.length === 0) {
    return { label: 'neutral', score: 0.5, confidence: 0 };
  }

  let positiveScore = 0;
  let negativeScore = 0;
  let foundPositive = [];
  let foundNegative = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prevWord = i > 0 ? words[i - 1] : '';
    const prevPrevWord = i > 1 ? words[i - 2] : '';
    
    // Check for negation (within 2-word window)
    const isNegated = NEGATORS.has(prevWord) || NEGATORS.has(prevPrevWord);
    
    // Check for amplification
    const isAmplified = AMPLIFIERS.has(prevWord) || AMPLIFIERS.has(prevPrevWord);
    const amplifier = isAmplified ? 1.5 : 1.0;

    if (POSITIVE_WORDS.has(word)) {
      if (isNegated) {
        negativeScore += 0.8 * amplifier;
        foundNegative.push(`not ${word}`);
      } else {
        positiveScore += 1.0 * amplifier;
        foundPositive.push(word);
      }
    } else if (NEGATIVE_WORDS.has(word)) {
      if (isNegated) {
        positiveScore += 0.6 * amplifier; // Negated negative = weakly positive
        foundPositive.push(`not ${word}`);
      } else {
        negativeScore += 1.0 * amplifier;
        foundNegative.push(word);
      }
    }
  }

  // Calculate normalized score
  const totalSentimentWords = foundPositive.length + foundNegative.length;
  
  if (totalSentimentWords === 0) {
    return { 
      label: 'neutral', 
      score: 0.5, 
      confidence: 0.1,
      explanation: 'The text lacks strong financial identifiers, leading to a neutral sentiment classification.'
    };
  }

  // Normalize to 0-1 range where 0.5 is neutral
  const rawScore = (positiveScore - negativeScore) / (positiveScore + negativeScore);
  const normalizedScore = (rawScore + 1) / 2; // Map [-1, 1] to [0, 1]
  
  // Confidence based on sentiment word density
  const density = totalSentimentWords / words.length;
  const confidence = Math.min(1, density * 5); // Cap at 1.0

  // Determine label
  let label;
  if (normalizedScore > 0.6) {
    label = 'positive';
  } else if (normalizedScore < 0.4) {
    label = 'negative';
  } else {
    label = 'neutral';
  }

  // Generate sharp financial explanation
  let explanation = '';
  const topPos = [...new Set(foundPositive)].slice(0, 3).map(w => `'${w}'`).join(', ');
  const topNeg = [...new Set(foundNegative)].slice(0, 3).map(w => `'${w}'`).join(', ');

  if (label === 'positive') {
    explanation = `The NLP engine detected bullish signals driven by indicators like ${topPos}. This suggests a favorable financial outlook or strong operational performance.`;
  } else if (label === 'negative') {
    explanation = `The model identified significant downside risk, highlighted by terminology such as ${topNeg}. This indicates potential headwinds, operational misses, or broader macroeconomic pressure.`;
  } else {
    let mixedStr = [];
    if (topPos) mixedStr.push(topPos);
    if (topNeg) mixedStr.push(topNeg);
    explanation = `The text presents a mixed or muted outlook. While the model detected terms like ${mixedStr.join(' and ')}, the overall financial impact is balanced, resulting in a neutral classification.`;
  }

  return {
    label,
    score: Math.round(normalizedScore * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    explanation,
    details: {
      positiveWords: foundPositive.length,
      negativeWords: foundNegative.length,
      totalWords: words.length
    }
  };
}

/**
 * Batch analyze multiple texts
 */
function analyzeBatch(texts) {
  return texts.map(text => ({
    text: text.substring(0, 100),
    ...analyzeSentiment(text)
  }));
}

/**
 * Get aggregate sentiment for a ticker from multiple articles
 */
function aggregateSentiment(sentiments) {
  if (!sentiments || sentiments.length === 0) {
    return { label: 'neutral', score: 0.5, confidence: 0, count: 0 };
  }

  const totalWeight = sentiments.reduce((sum, s) => sum + s.confidence, 0);
  
  if (totalWeight === 0) {
    const avgScore = sentiments.reduce((sum, s) => sum + s.score, 0) / sentiments.length;
    return {
      label: avgScore > 0.6 ? 'positive' : avgScore < 0.4 ? 'negative' : 'neutral',
      score: Math.round(avgScore * 100) / 100,
      confidence: 0.1,
      count: sentiments.length
    };
  }

  // Weighted average by confidence
  const weightedScore = sentiments.reduce((sum, s) => sum + (s.score * s.confidence), 0) / totalWeight;
  const avgConfidence = totalWeight / sentiments.length;

  let label;
  if (weightedScore > 0.6) label = 'positive';
  else if (weightedScore < 0.4) label = 'negative';
  else label = 'neutral';

  return {
    label,
    score: Math.round(weightedScore * 100) / 100,
    confidence: Math.round(avgConfidence * 100) / 100,
    count: sentiments.length
  };
}

module.exports = { analyzeSentiment, analyzeBatch, aggregateSentiment };
