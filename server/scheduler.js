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
const { loadIndex } = require('./services/entityResolver');
const { analyzeSentiment } = require('./services/sentiment');
const { classifyBatch, isEnabled: finbertEnabled } = require('./services/finbertClassifier');
const { classifyArticle, assignClusters } = require('./services/newsRelevance');
const { upsertEvents } = require('./services/events');
const { generateAlerts } = require('./services/materiality');
const { recomputeImpacts } = require('./services/impactScoring');
const { logEventFeatures, resolveOutcomes } = require('./services/outcomes');
const { pollSmartMoney } = require('./services/smartMoney');
const { generateDailyBriefs } = require('./services/reports');
const { captureException } = require('./observability');
const { REPORTS } = require('./config');

let isRunning = false;

// Choose FinBERT (batch) when available, else the lexicon, for every article.
// `held` = [{ticker, name}] portfolio holdings, so news about a user's holding outside
// the curated universe still resolves (basic symbol/name match).
async function classifyArticles(articles, held = []) {
  const texts = articles.map((a) => `${a.title} ${a.summary || ''}`.trim());
  let finbert = null;
  if (finbertEnabled()) finbert = await classifyBatch(texts);
  const resolver = await loadIndex(); // curated-universe entity resolver (cached)

  const enriched = articles.map((a, i) => {
    const resolved = resolver.resolve(a.title, a.summary || '', held);
    const matched = resolved.tickers;

    let sentiment;
    if (finbert && finbert[i]) {
      sentiment = finbert[i];
    } else {
      const s = analyzeSentiment(texts[i]);
      sentiment = { label: s.label, score: s.score, confidence: s.confidence, model: 'lexicon' };
    }

    // Phase 3.5: grade relevance (holding / market / world / none).
    const rel = classifyArticle(a, matched);
    // Macro tag drives broad portfolio impact: a market/world event (or a macro-sourced
    // article) applies across portfolios, not just to a named ticker.
    if ((rel.tier === 'market' || rel.tier === 'world' || a.platform === 'macro') && !matched.includes('__MARKET__')) {
      matched.push('__MARKET__');
    }
    return { ...a, matchedTickers: matched, sentiment, relevance: rel, sectors: resolved.sectors };
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

    const allHoldings = await query('SELECT DISTINCT ticker, company_name FROM portfolio');
    const tickers = allHoldings.map((h) => h.ticker);
    if (tickers.length === 0) {
      console.log('   No portfolios to monitor.');
      return;
    }
    const held = allHoldings.map((h) => ({ ticker: h.ticker, name: h.company_name }));

    // 1. Gather raw articles from every enabled source.
    const { articles: raw, counts } = await gatherArticles(tickers);
    console.log(`   📰 Fetched ${raw.length} articles ${JSON.stringify(counts)}`);

    // 2. Classify + entity-resolve (curated universe + held-holding fallback).
    const articles = await classifyArticles(raw, held);
    const model = finbertEnabled() ? 'finbert' : 'lexicon';

    // 3. Persist new articles (+ relevance/cluster grade) + their per-ticker sentiment.
    let newArticles = 0;
    let relevantCount = 0;
    for (const a of articles) {
      const inserted = await queryOne(
        `INSERT INTO articles (external_id, title, summary, source, url, image_url, published_at, platform,
                               cluster_key, relevance_tier, importance, is_relevant, sectors)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (external_id) DO NOTHING
         RETURNING id`,
        [a.external_id, a.title, a.summary || '', a.source, a.url, a.image_url, a.published_at, a.platform || 'news',
         a.cluster_key, a.relevance.tier, a.relevance.importance, a.relevance.isRelevant, a.sectors || []]
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

    // 4. Roll articles up into durable events (E1b) — the unit impact/alerts key off.
    await upsertEvents();

    // 5. Alerts — materiality engine: one alert per EVENT per user, gated on exposure ×
    //    surprise × volume, then capped by per-user budgets (realtime vs digest).
    const alerts = await generateAlerts();
    console.log(`   🔔 ${alerts.total} alerts (${alerts.realtime} realtime, ${alerts.total - alerts.realtime} digest)`);

    // 6. Recompute per-user portfolio impact (the North Star feed).
    const impactCount = await recomputeImpacts();
    console.log(`   🎯 ${impactCount} portfolio-impact rows computed`);

    // 7. Outcome logging (E3): snapshot event features + resolve 1–3d price moves —
    //    the self-assembling dataset for future supervised tuning.
    const logged = await logEventFeatures();
    const resolved = await resolveOutcomes();
    console.log(`   🧪 outcomes: ${logged} logged, ${resolved} price-resolved`);
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

// Daily analyst brief (E5) — server-scheduled only; cost guardrails live in reports.js.
async function runDailyBriefs() {
  try {
    console.log(`\n📝 [${new Date().toLocaleTimeString()}] Generating daily briefs...`);
    const r = await generateDailyBriefs();
    console.log(`   ✅ Briefs: ${r.users} user(s) — ${r.claude} via Claude, ${r.fallback} via fallback writer`);
  } catch (err) {
    console.error('Daily brief run error:', err);
    captureException(err);
  }
}

function startScheduler() {
  // Collect the cron tasks so graceful shutdown can stop them (SIGTERM on deploy).
  const tasks = [];

  setTimeout(runNewsPipeline, 2000);
  tasks.push(cron.schedule('*/10 * * * *', runNewsPipeline));
  console.log('⏰ Scheduler started — news every 10 minutes');

  if (FEATURES.SMART_MONEY) {
    setTimeout(runSmartMoneyPoll, 8000); // stagger after the news pipeline kicks off
    tasks.push(cron.schedule(SMART_MONEY.POLL_CRON, runSmartMoneyPoll));
    console.log(`⏰ Smart-money poller started — ${SMART_MONEY.POLL_CRON}`);
  }

  tasks.push(cron.schedule(REPORTS.CRON, runDailyBriefs));
  console.log(`⏰ Daily-brief generator started — ${REPORTS.CRON}`);

  return tasks;
}

module.exports = { startScheduler, runNewsPipeline, runSmartMoneyPoll, runDailyBriefs };
