/**
 * Job Scheduler — the batch pipeline (Phase 2):
 *   gather (multi-source) → classify (FinBERT batch, lexicon fallback) → match →
 *   persist → alerts → recompute portfolio impact.
 *
 * Model split: this batch pass classifies with FinBERT when enabled (deterministic
 * scores that feed the z-score baseline); the live /api/news routes use the cheap
 * lexicon. The flat sentiment_snapshots write is gone — decay/momentum/z-score are
 * computed on read from article_sentiments (sentimentScoring.js).
 */

const cron = require('node-cron');
const { query, queryOne, execute } = require('./db');
const { FEATURES, SMART_MONEY } = require('./config');
const { gatherArticles } = require('./services/ingest');
const { matchTickers } = require('./services/tickerMatcher');
const { analyzeSentiment } = require('./services/sentiment');
const { classifyBatch, isEnabled: finbertEnabled } = require('./services/finbertClassifier');
const { classifyArticle, assignClusters } = require('./services/newsRelevance');
const { generateAlerts } = require('./services/materiality');
const { recomputeImpacts } = require('./services/impactScoring');
const { pollSmartMoney } = require('./services/smartMoney');
const { captureException } = require('./observability');

let isRunning = false;

// Choose FinBERT (batch) when available, else the lexicon, for every article.
async function classifyArticles(articles) {
  const texts = articles.map((a) => `${a.title} ${a.summary || ''}`.trim());
  let finbert = null;
  if (finbertEnabled()) finbert = await classifyBatch(texts);

  const enriched = articles.map((a, i) => {
    const matched = matchTickers(a.title, a.summary);
    if (a.platform === 'macro' && !matched.includes('__MARKET__')) matched.push('__MARKET__');

    let sentiment;
    if (finbert && finbert[i]) {
      sentiment = finbert[i];
    } else {
      const s = analyzeSentiment(texts[i]);
      sentiment = { label: s.label, score: s.score, confidence: s.confidence, model: 'lexicon' };
    }

    // Phase 3.5: grade relevance (holding / market / world / none).
    const rel = classifyArticle(a, matched);
    return { ...a, matchedTickers: matched, sentiment, relevance: rel };
  });

  // Cluster duplicates across the whole batch (stemmed-headline similarity) so the
  // same story from GDELT + multiple RSS feeds shares one cluster_key → one feed
  // card, one alert.
  const keys = assignClusters(enriched);
  return enriched.map((a, i) => ({ ...a, cluster_key: keys[i] }));
}

async function runNewsPipeline() {
  if (isRunning) return;
  isRunning = true;

  try {
    console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Running news pipeline...`);

    const allHoldings = await query('SELECT DISTINCT ticker FROM portfolio');
    const tickers = allHoldings.map((h) => h.ticker);
    if (tickers.length === 0) {
      console.log('   No portfolios to monitor.');
      return;
    }

    // 1. Gather raw articles from every enabled source.
    const { articles: raw, counts } = await gatherArticles(tickers);
    console.log(`   📰 Fetched ${raw.length} articles ${JSON.stringify(counts)}`);

    // 2. Classify + ticker-match.
    const articles = await classifyArticles(raw);
    const model = finbertEnabled() ? 'finbert' : 'lexicon';

    // 3. Persist new articles (+ relevance/cluster grade) + their per-ticker sentiment.
    let newArticles = 0;
    let relevantCount = 0;
    for (const a of articles) {
      const inserted = await queryOne(
        `INSERT INTO articles (external_id, title, summary, source, url, image_url, published_at, platform,
                               cluster_key, relevance_tier, importance, is_relevant)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (external_id) DO NOTHING
         RETURNING id`,
        [a.external_id, a.title, a.summary || '', a.source, a.url, a.image_url, a.published_at, a.platform || 'news',
         a.cluster_key, a.relevance.tier, a.relevance.importance, a.relevance.isRelevant]
      );
      if (!inserted) continue;
      newArticles++;
      if (a.relevance.isRelevant) relevantCount++;
      for (const ticker of a.matchedTickers) {
        await execute(
          `INSERT INTO article_sentiments (article_id, ticker, sentiment_label, sentiment_score, confidence, model)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (article_id, ticker)
           DO UPDATE SET sentiment_label = EXCLUDED.sentiment_label,
                         sentiment_score = EXCLUDED.sentiment_score,
                         confidence      = EXCLUDED.confidence,
                         model           = EXCLUDED.model`,
          [inserted.id, ticker, a.sentiment.label, a.sentiment.score, a.sentiment.confidence || 0, a.sentiment.model || model]
        );
      }
    }
    console.log(`   💾 ${newArticles} new articles stored, ${relevantCount} relevant (model: ${model})`);

    // 4. Alerts — materiality engine (Phase 3.5): one alert per EVENT cluster per
    //    user, gated on exposure × surprise × volume. Kills the per-article spam.
    const alertCount = await generateAlerts();
    console.log(`   🔔 ${alertCount} event alerts generated`);

    // 5. Recompute per-user portfolio impact (the North Star feed).
    const impactCount = await recomputeImpacts();
    console.log(`   🎯 ${impactCount} portfolio-impact rows computed`);
    console.log(`   ✅ Pipeline complete\n`);
  } catch (err) {
    console.error('Pipeline error:', err);
    captureException(err);
  } finally {
    isRunning = false;
  }
}

// Smart-money poller (Phase 3) — emulates a webhook by watching EDGAR 13F + the congress
// feed on its own slower cadence; new filings/disclosures emit instant alerts internally.
async function runSmartMoneyPoll() {
  if (!FEATURES.SMART_MONEY) return;
  try {
    console.log(`\n🏦 [${new Date().toLocaleTimeString()}] Polling smart money (13F + Congress)...`);
    await pollSmartMoney();
  } catch (err) {
    console.error('Smart-money poll error:', err);
    captureException(err);
  }
}

function startScheduler() {
  setTimeout(runNewsPipeline, 2000);
  cron.schedule('*/10 * * * *', runNewsPipeline);
  console.log('⏰ Scheduler started — news every 10 minutes');

  if (FEATURES.SMART_MONEY) {
    setTimeout(runSmartMoneyPoll, 8000); // stagger after the news pipeline kicks off
    cron.schedule(SMART_MONEY.POLL_CRON, runSmartMoneyPoll);
    console.log(`⏰ Smart-money poller started — ${SMART_MONEY.POLL_CRON}`);
  }
}

module.exports = { startScheduler, runNewsPipeline, runSmartMoneyPoll };
