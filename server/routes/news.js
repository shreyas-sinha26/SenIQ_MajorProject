const express = require('express');
const { query, execute } = require('../db');
const { authMiddleware } = require('./auth');
const { fetchNewsForTickers } = require('../services/newsFetcher');
const { analyzeSentiment, aggregateSentiment } = require('../services/sentiment');
const { matchTickers } = require('../services/tickerMatcher');
const { generateDigest, summarizeArticle } = require('../services/summarizer');
const { isUrl, scrapeArticle } = require('../services/articleScraper');
const { explainForPortfolio } = require('../services/ollamaExplainer');
const { scoreTicker } = require('../services/sentimentScoring');
const { getImpactFeed } = require('../services/impactScoring');
const { attachTier } = require('../middleware/tier');

const router = express.Router();
router.use(authMiddleware, attachTier);

// ─── GET /api/news/feed ──────────────────────────────────────
// Phase 3.5: a de-spammed feed in the three buckets a user actually cares about —
// (1) news about THEIR holdings, (2) broad MARKET-moving news, (3) major WORLD
// affairs. Reads the persisted, relevance-graded corpus and shows ONE card per
// event cluster (with a source count), so the same story from four outlets, and
// generic filler, never reach the user.
const FEED_WINDOW_HOURS = 48;

router.get('/feed', async (req, res) => {
  try {
    const holdings = await query('SELECT ticker FROM portfolio WHERE user_id = $1', [req.user.id]);
    const tickers = holdings.map(h => h.ticker);

    // One row per durable event (E1b), with its source count.
    const evs = await query(
      `SELECT id, title, source, url, last_seen AS published_at, relevance_tier, importance, source_count
         FROM events
        WHERE relevance_tier <> 'none'
          AND last_seen > now() - ($1 || ' hours')::interval`,
      [String(FEED_WINDOW_HOURS)]
    );
    if (evs.length === 0) {
      return res.json({ articles: [], buckets: { holdings: [], market: [], world: [] } });
    }

    const ids = evs.map(e => e.id);
    // Per-event matched tickers + a representative sentiment (via attached articles).
    const sents = await query(
      `SELECT a.event_id, s.ticker, s.sentiment_label, s.sentiment_score
         FROM articles a JOIN article_sentiments s ON s.article_id = a.id
        WHERE a.event_id = ANY($1)`,
      [ids]
    );
    const sentByEvent = {};
    for (const s of sents) (sentByEvent[s.event_id] ||= []).push(s);

    // This user's exposure-weighted impact, to rank the holdings bucket.
    const impacts = await query(
      `SELECT event_id, impact_score FROM event_portfolio_impact
        WHERE user_id = $1 AND event_id = ANY($2)`,
      [req.user.id, ids]
    );
    const impactByEvent = {};
    for (const i of impacts) impactByEvent[i.event_id] = Number(i.impact_score);

    const heldSet = new Set(tickers);
    const shape = (e) => {
      const rows = sentByEvent[e.id] || [];
      const matched = [...new Set(rows.map(s => s.ticker).filter(t => t !== '__MARKET__'))];
      const heldMatch = matched.filter(t => heldSet.has(t));
      // Representative sentiment: a held ticker's score if any, else the first row.
      const pick = rows.find(s => heldSet.has(s.ticker)) || rows[0];
      return {
        id: e.id,
        title: e.title,
        source: e.source,
        url: e.url,
        published_at: e.published_at,
        tier: e.relevance_tier,
        importance: Number(e.importance),
        source_count: Number(e.source_count),
        matchedTickers: matched,
        heldTickers: heldMatch,
        impact: impactByEvent[e.id] ?? null,
        sentiment: {
          label: pick ? pick.sentiment_label : 'neutral',
          score: pick ? Number(pick.sentiment_score) : 0.5,
        },
      };
    };

    const shaped = evs.map(shape);

    const byImpactThenTime = (a, b) =>
      (b.impact ?? -1) - (a.impact ?? -1) || new Date(b.published_at) - new Date(a.published_at);
    const byImportanceThenTime = (a, b) =>
      b.importance - a.importance || b.source_count - a.source_count ||
      new Date(b.published_at) - new Date(a.published_at);

    const buckets = {
      // Holdings bucket = holding-tier stories about something THIS user owns.
      holdings: shaped.filter(a => a.tier === 'holding' && a.heldTickers.length > 0).sort(byImpactThenTime),
      market: shaped.filter(a => a.tier === 'market').sort(byImportanceThenTime),
      world: shaped.filter(a => a.tier === 'world').sort(byImportanceThenTime),
    };

    // Flat list (holdings → market → world) keeps the existing search/filter UI working.
    const articles = [...buckets.holdings, ...buckets.market, ...buckets.world];
    res.json({ articles, buckets });
  } catch (err) {
    console.error('News feed error:', err);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// ─── GET /api/news/sentiment/:ticker ─────────────────────────
// Get sentiment analysis for a specific ticker
router.get('/sentiment/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const apiKey = process.env.FINNHUB_API_KEY || '';
    const articles = await fetchNewsForTickers([ticker], apiKey);

    const tickerArticles = articles.filter(a => a.matchedTickers.includes(ticker));
    const sentiments = tickerArticles.map(a => a.sentiment);
    const aggregate = aggregateSentiment(sentiments);

    // Phase 2a: decay-weighted acute score + momentum + 90-day baseline z-score,
    // computed from persisted history (what makes the picture non-generic).
    const scoring = await scoreTicker(ticker);

    res.json({
      ticker,
      aggregate,
      scoring,
      articles: tickerArticles.slice(0, 10),
      digest: generateDigest(tickerArticles, ticker)
    });
  } catch (err) {
    console.error('Sentiment error:', err);
    res.status(500).json({ error: 'Failed to analyze sentiment' });
  }
});

// ─── GET /api/news/portfolio-sentiment ───────────────────────
// Get aggregate sentiment for entire portfolio
router.get('/portfolio-sentiment', async (req, res) => {
  try {
    const holdings = await query('SELECT ticker FROM portfolio WHERE user_id = $1', [req.user.id]);
    const tickers = holdings.map(h => h.ticker);

    if (tickers.length === 0) {
      return res.json({ sentiments: {}, overallScore: 50 });
    }

    const apiKey = process.env.FINNHUB_API_KEY || '';
    const allArticles = await fetchNewsForTickers(tickers, apiKey);

    const tickerSentiments = {};
    for (const ticker of tickers) {
      const tickerArticles = allArticles.filter(a => a.matchedTickers.includes(ticker));
      const sentiments = tickerArticles.map(a => a.sentiment);
      tickerSentiments[ticker] = {
        ...aggregateSentiment(sentiments),
        recentHeadline: tickerArticles[0]?.title || 'No recent news'
      };
    }

    // Overall portfolio score (weighted average)
    const scores = Object.values(tickerSentiments).filter(s => s.count > 0);
    const overallScore = scores.length > 0
      ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length * 100)
      : 50;

    res.json({ sentiments: tickerSentiments, overallScore });
  } catch (err) {
    console.error('Portfolio sentiment error:', err);
    res.status(500).json({ error: 'Failed to analyze portfolio sentiment' });
  }
});

// ─── GET /api/news/impact ────────────────────────────────────
// The North Star feed: events ranked by their exposure-weighted impact on THIS
// user's portfolio. The first item is "today's most important event for you".
router.get('/impact', async (req, res) => {
  try {
    const feed = await getImpactFeed(req.user.id, 20);
    // Phase 6 — Free tier sees only today's single most important event; Plus/Pro get the
    // full ranked feed.
    if (req.tierCfg?.impactFeed === 'top') {
      return res.json({ topEvent: feed[0] || null, feed: feed.slice(0, 1), gated: true, upgrade: { requiredTier: 'plus', requiredLabel: 'Plus' } });
    }
    res.json({ topEvent: feed[0] || null, feed });
  } catch (err) {
    console.error('Impact feed error:', err);
    res.status(500).json({ error: 'Failed to load portfolio impact' });
  }
});

// ─── GET /api/news/alerts ────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const alerts = await query(
      `SELECT al.*, e.url AS article_url
         FROM alerts al
         LEFT JOIN events e ON e.id = al.event_id
        WHERE al.user_id = $1
        ORDER BY al.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ alerts });
  } catch (err) {
    console.error('List alerts error:', err);
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

// ─── PUT /api/news/alerts/read-all ───────────────────────────
// Defined before the :id route so "read-all" isn't captured as an id.
router.put('/alerts/read-all', async (req, res) => {
  try {
    const result = await execute('UPDATE alerts SET read = true WHERE user_id = $1 AND read = false', [req.user.id]);
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    console.error('Mark all alerts read error:', err);
    res.status(500).json({ error: 'Failed to update alerts' });
  }
});

// ─── PUT /api/news/alerts/:id/read ───────────────────────────
router.put('/alerts/:id/read', async (req, res) => {
  try {
    await execute('UPDATE alerts SET read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Mark alert read error:', err);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// ─── PUT /api/news/alerts/:id/dismiss ────────────────────────
// Negative engagement signal (E3 outcome logging) — distinct from "read".
router.put('/alerts/:id/dismiss', async (req, res) => {
  try {
    await execute('UPDATE alerts SET dismissed = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Dismiss alert error:', err);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// ─── POST /api/news/analyze ─────────────────────────────────
// Analyze headline, URL, or article text
router.post('/analyze', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  let inputText = text.trim();
  let summary = null;
  let articleTitle = null;

  // Step 1: scrape if URL
  if (isUrl(inputText)) {
    try {
      const article = await scrapeArticle(inputText);
      articleTitle = article.title;
      inputText = article.text;
      summary = article.metaDesc || summarizeArticle(article.title, article.text);
    } catch (err) {
      return res.status(400).json({ error: `Could not fetch article: ${err.message}` });
    }
  } else if (inputText.length > 300) {
    summary = summarizeArticle('', inputText);
  }

  // Step 2: sentiment + ticker matching
  const sentiment = analyzeSentiment(inputText);
  const tickers = matchTickers(inputText);

  // Step 3: LLM explanation with portfolio context (graceful fallback if Ollama is down)
  let llmExplanation = null;
  try {
    const holdings = await query('SELECT ticker FROM portfolio WHERE user_id = $1', [req.user.id]);
    const portfolioTickers = holdings.map(h => h.ticker);
    llmExplanation = await explainForPortfolio(inputText, sentiment, tickers, portfolioTickers);
  } catch (err) {
    console.warn('Ollama unavailable, skipping LLM explanation:', err.message);
  }

  res.json({ sentiment, matchedTickers: tickers, summary, articleTitle, llmExplanation });
});

module.exports = router;
