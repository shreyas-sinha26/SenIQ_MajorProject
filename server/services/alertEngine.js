/**
 * Alert Engine Service
 * Decides when to alert users based on sentiment thresholds and rules.
 */

const ALERT_RULES = {
  INSTANT_NEGATIVE_THRESHOLD: 0.25,  // score < 0.25 = strongly negative
  INSTANT_POSITIVE_THRESHOLD: 0.85,  // score > 0.85 = strongly positive
  MARKET_WIDE_KEYWORDS: ['crash', 'crisis', 'recession', 'rate hike', 'rate cut'],
  DIGEST_INTERVAL_HOURS: 1,
};

/**
 * Evaluate whether an article should trigger an alert
 * @returns {{ shouldAlert: boolean, alertType: string, urgency: string, message: string }}
 */
function evaluateAlert(article, ticker, sentiment) {
  const { score, label, confidence } = sentiment;

  // Rule 1: Strong negative sentiment — instant alert
  if (score < ALERT_RULES.INSTANT_NEGATIVE_THRESHOLD && confidence > 0.3) {
    return {
      shouldAlert: true,
      alertType: 'sentiment_negative',
      urgency: 'high',
      message: `⚠️ ${ticker} — Strong negative sentiment detected (${Math.round(score * 100)}%): ${article.title}`
    };
  }

  // Rule 2: Strong positive sentiment — instant alert
  if (score > ALERT_RULES.INSTANT_POSITIVE_THRESHOLD && confidence > 0.3) {
    return {
      shouldAlert: true,
      alertType: 'sentiment_positive',
      urgency: 'medium',
      message: `🚀 ${ticker} — Strong positive signal (${Math.round(score * 100)}%): ${article.title}`
    };
  }

  // Rule 3: Market-wide event
  const titleLower = article.title.toLowerCase();
  const isMarketEvent = ALERT_RULES.MARKET_WIDE_KEYWORDS.some(kw => titleLower.includes(kw));
  if (isMarketEvent) {
    return {
      shouldAlert: true,
      alertType: 'market_event',
      urgency: 'high',
      message: `📊 Market Alert: ${article.title}`
    };
  }

  // Rule 4: Moderate sentiment — include in digest, no instant alert
  if (label !== 'neutral') {
    return {
      shouldAlert: false,
      alertType: 'digest',
      urgency: 'low',
      message: `${label === 'positive' ? '📈' : '📉'} ${ticker}: ${article.title}`
    };
  }

  return { shouldAlert: false, alertType: 'none', urgency: 'none', message: '' };
}

/**
 * Process a batch of enriched articles and generate alerts
 */
function processAlerts(enrichedArticles, userPortfolios) {
  const alerts = [];

  for (const article of enrichedArticles) {
    for (const ticker of article.matchedTickers) {
      if (ticker === '__MARKET__') {
        // Market alerts go to all users
        const uniqueUsers = [...new Set(userPortfolios.map(p => p.user_id))];
        for (const userId of uniqueUsers) {
          const evaluation = evaluateAlert(article, 'MARKET', article.sentiment);
          if (evaluation.shouldAlert) {
            alerts.push({ user_id: userId, ticker: 'MARKET', article, ...evaluation });
          }
        }
      } else {
        // Ticker-specific alerts go to holding users
        const holdingUsers = userPortfolios
          .filter(p => p.ticker === ticker)
          .map(p => p.user_id);

        for (const userId of holdingUsers) {
          const evaluation = evaluateAlert(article, ticker, article.sentiment);
          if (evaluation.shouldAlert) {
            alerts.push({ user_id: userId, ticker, article, ...evaluation });
          }
        }
      }
    }
  }

  return alerts;
}

module.exports = { evaluateAlert, processAlerts, ALERT_RULES };
