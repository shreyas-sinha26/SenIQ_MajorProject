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
const { FEATURES, SMART_MONEY, INDIA_SMART_MONEY, IPO_WATCH, PAPER } = require('./config');
const { gatherArticles } = require('./services/ingest');
const { loadIndex, indianListed, isUsListed } = require('./services/entityResolver');
const usNews = require('./services/usNews');
const { analyzeSentiment } = require('./services/sentiment');
const { classifyBatch, classifyTargets, targetEnabled, isEnabled: finbertEnabled } = require('./services/finbertClassifier');
const { classifyArticle, isRoundup, assignClusters } = require('./services/newsRelevance');
const { readCompanies, settle } = require('./services/targetedSentiment');
const { upsertEvents } = require('./services/events');
const { generateAlerts } = require('./services/materiality');
const { recomputeImpacts } = require('./services/impactScoring');
const { logEventFeatures, resolveOutcomes } = require('./services/outcomes');
const { pollSmartMoney } = require('./services/smartMoney');
const { pollIndiaSmartMoney } = require('./services/smartMoney/india');
const { pollCalendar } = require('./services/ipoWatch');
const { linkArticles, linkSymbols, monitoredTickers, graduate } = require('./services/ipoWatch/registry');
const { resolveReturns, resolveUsOutcomes } = require('./services/ipoWatch/returns');
const { readPendingStories } = require('./services/ipoWatch/arc');
const { syncDisclosures } = require('./services/disclosures');
const { generateDailyBriefs } = require('./services/reports');
const { embedPendingArticles } = require('./services/newsSearch');
const { purgeOldThreads } = require('./services/askThreads');
const retention = require('./services/retention');
const { runReportEmails } = require('./services/reportEmails');
const { runPaperMarks } = require('./services/paperLedger');
const { captureException } = require('./observability');
const { REPORTS, QA, REPORT_EMAIL, RETENTION } = require('./config');

let isRunning = false;

// Choose FinBERT (batch) when available, else the lexicon, for every article.
// `held` = [{ticker, name}] portfolio holdings, so news about a user's holding outside
// the curated universe still resolves (basic symbol/name match).
// `ownFeed`: the stories say which ticker's company news they came from, so a US listed name
// counts only on a story from its own feed. `gained`: stored stories that have now turned up
// in such a name's feed (usNews.gainedFeeds); they are read again.
// Returns { articles, dropped } — `dropped` counts the stories the rotation alone brought in
// that are about no company.
async function classifyArticles(fetched, held = [], known = new Set(), { ownFeed = false, gained = new Map() } = {}) {
  const resolver = await loadIndex(); // curated-universe entity resolver (cached)
  const heldTickers = new Set(held.map((h) => h.ticker));
  // A US listed name nobody holds is looked for only in the stories from its own feed.
  const feedNames = (feeds) => [...new Set(feeds)].filter((t) => !heldTickers.has(t) && isUsListed(t)).map((ticker) => ({ ticker }));
  const namedFor = (a) => [...held, ...feedNames(a.feeds || [])];
  const feedsOf = (a) => (ownFeed ? a.feeds || [] : null);
  // A piece of a story on its own (one sentence): every name the batch could tag.
  const anyNamed = [...held, ...feedNames(fetched.flatMap((a) => a.feeds || []))];
  const companiesIn = (text) => resolver.resolve(text, '', anyNamed).tickers;

  const resolvedAll = fetched.map((a) => resolver.resolve(a.title, a.summary || '', namedFor(a), feedsOf(a)));
  const inHeadlineAll = fetched.map((a) => resolver.resolve(a.title, '', namedFor(a), feedsOf(a)).tickers);
  // Before any tone is read: a story the rotation alone brought in that is about no company goes.
  const kept = fetched.map((a, i) => i).filter((i) => usNews.worthReading(fetched[i], resolvedAll[i].tickers, inHeadlineAll[i]));
  const articles = kept.map((i) => fetched[i]);
  const resolved = kept.map((i) => resolvedAll[i]);
  const inHeadline = kept.map((i) => inHeadlineAll[i]);

  const texts = articles.map((a) => `${a.title} ${a.summary || ''}`.trim());
  // FinBERT reads only stories that are not stored yet: a stored story keeps the reading it
  // has, and the copy fetched again this run is dropped at insert anyway. The exception is a
  // stored story about to gain a name from that name's own feed.
  const gains = (a, i) => (gained.get(a.external_id) || []).some((t) => resolved[i].tickers.includes(t));
  const finbert = new Array(articles.length).fill(null);
  if (finbertEnabled()) {
    const fresh = articles.map((a, i) => i).filter((i) => !known.has(articles[i].external_id) || gains(articles[i], i));
    const read = fresh.length ? await classifyBatch(fresh.map((i) => texts[i])) : [];
    if (read) fresh.forEach((i, k) => { finbert[i] = read[k]; });
  }

  // One reading is one tone for the whole text. A story naming several companies is read
  // again per company (targetedSentiment); a roundup is about none of them and is left out.
  const perCompany = await readCompanies(articles.map((a, i) => ({
    title: a.title, summary: a.summary || '', whole: finbert[i],
    tickers: isRoundup(a.title, inHeadline[i]) ? [] : resolved[i].tickers,
  })), {
    companiesIn, classify: classifyBatch, nameOf: resolver.nameByTicker,
    ...(targetEnabled() ? { classifyTarget: classifyTargets, surface: resolver.surface } : {}),
  });

  const enriched = articles.map((a, i) => {
    let sentiment;
    if (finbert && finbert[i]) {
      sentiment = finbert[i];
    } else {
      const s = analyzeSentiment(texts[i]);
      sentiment = { label: s.label, score: s.score, confidence: s.confidence, model: 'lexicon' };
    }

    // The companies the story is stored against, each with its own reading where it has one.
    const { tickers: matched, readings } = settle(a.title, resolved[i].tickers, inHeadline[i], perCompany[i]);
    // Read per company, every name in it turned out a passing mention: the same as above.
    if (a.rotationOnly && matched.length === 0) return null;

    // Phase 3.5: grade relevance (holding / market / world / none).
    const rel = classifyArticle(a, matched, { aboutMarket: resolved[i].tickers.length > 0 && matched.length === 0 });
    // Macro tag drives broad portfolio impact: a market/world event (or a macro-sourced
    // article) applies across portfolios, not just to a named ticker.
    if ((rel.tier === 'market' || rel.tier === 'world' || a.platform === 'macro') && !matched.includes('__MARKET__')) {
      matched.push('__MARKET__');
    }
    return { ...a, matchedTickers: matched, sentiment, readings, relevance: rel, sectors: resolved[i].sectors };
  }).filter(Boolean);

  // Cluster duplicates across the whole batch (stemmed-headline similarity) so the
  // same story from GDELT + multiple RSS feeds shares one cluster_key → one feed
  // card, one alert.
  const keys = assignClusters(enriched);
  return { articles: enriched.map((a, i) => ({ ...a, cluster_key: keys[i] })), dropped: fetched.length - enriched.length };
}

// A stored story that has turned up in the feed of a US listed name: the feed is recorded,
// and the name, if the story is about it, is stored against the story with its reading. A
// reading the story already has is left as it is. Returns how many names were added.
async function addFeedTags(a, tickers) {
  const row = await queryOne(
    `UPDATE articles SET feeds = ARRAY(SELECT DISTINCT unnest(feeds || $2::text[]))
      WHERE external_id = $1 RETURNING id, relevance_tier`,
    [a.external_id, tickers]
  );
  if (!row) return 0;
  let added = 0;
  for (const ticker of tickers.filter((t) => a.matchedTickers.includes(t))) {
    const r = a.readings[ticker] || a.sentiment;
    const res = await execute(
      `INSERT INTO article_sentiments (article_id, ticker, sentiment_label, sentiment_score, confidence, model)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (article_id, ticker) DO NOTHING`,
      [row.id, ticker, r.label, r.score, r.confidence || 0, r.model || 'lexicon']
    );
    added += res.rowCount;
  }
  // Stored as about nothing, it is now about a company.
  if (added && row.relevance_tier === 'none' && a.relevance.tier === 'holding') {
    await execute("UPDATE articles SET relevance_tier = 'holding', importance = $2, is_relevant = true WHERE id = $1", [row.id, a.relevance.importance]);
  }
  return added;
}

// Store the classified stories that are new, each with its per-ticker readings. A story
// already stored is left as it is, unless it has gained a US listed name's feed (`gained`).
async function storeArticles(articles, gained = new Map()) {
  let newArticles = 0;
  let newByFinbert = 0;
  let relevantCount = 0;
  let feedTags = 0;
  for (const a of articles) {
    const inserted = await queryOne(
      `INSERT INTO articles (external_id, title, summary, source, url, image_url, published_at, platform,
                             cluster_key, relevance_tier, importance, is_relevant, sectors, feeds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (external_id) DO NOTHING
       RETURNING id`,
      [a.external_id, a.title, a.summary || '', a.source, a.url, a.image_url, a.published_at, a.platform || 'news',
       a.cluster_key, a.relevance.tier, a.relevance.importance, a.relevance.isRelevant, a.sectors || [], a.feeds || []]
    );
    if (!inserted) {
      if (gained.has(a.external_id)) feedTags += await addFeedTags(a, gained.get(a.external_id));
      continue;
    }
    newArticles++;
    if (a.sentiment.model === 'finbert') newByFinbert++;
    if (a.relevance.isRelevant) relevantCount++;
    for (const ticker of a.matchedTickers) {
      const r = a.readings[ticker] || a.sentiment; // the company's own reading, else the story's
      await execute(
        `INSERT INTO article_sentiments (article_id, ticker, sentiment_label, sentiment_score, confidence, model)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (article_id, ticker)
         DO UPDATE SET sentiment_label = EXCLUDED.sentiment_label,
                       sentiment_score = EXCLUDED.sentiment_score,
                       confidence      = EXCLUDED.confidence,
                       model           = EXCLUDED.model`,
        [inserted.id, ticker, r.label, r.score, r.confidence || 0, r.model || 'lexicon']
      );
    }
  }
  return { newArticles, newByFinbert, relevantCount, feedTags };
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
    // IPO Watch: newly filed and priced US issues are nobody's holding yet, so their company
    // news is asked for alongside. A failure here must not stop the pipeline.
    let ipoTickers = [];
    if (FEATURES.IPO_WATCH) ipoTickers = await monitoredTickers().catch(() => []);
    // US coverage: this run's few of the US shares nobody holds. A failure to pick them, or
    // to record the visit, must not stop the pipeline.
    const rotation = await usNews.nextBatch([...tickers, ...ipoTickers]).catch((err) => { console.warn('   ⚠️  US rotation not picked:', err.message); return []; });
    const { articles: fetched, counts, rotation: rotated } = await gatherArticles(tickers, ipoTickers, rotation);
    console.log(`   📰 Fetched ${fetched.length} articles ${JSON.stringify(counts)}`);
    if (rotation.length) {
      await usNews.markChecked(rotated.checked).catch((err) => console.warn('   ⚠️  US rotation not recorded:', err.message));
      console.log(`   🇺🇸 US rotation: ${rotated.checked.length} of ${rotation.length} name(s) checked${rotated.stopped ? ` (stopped: ${rotated.stopped})` : ''}`);
    }
    // Retention: once old stories have been pruned, one from before the pruning horizon is
    // not stored again. A failure to check must not stop the pipeline.
    const raw = retention.dropTooOld(fetched, await retention.ingestCutoff().catch(() => null));
    if (raw.length < fetched.length) console.log(`   🗄️  ${fetched.length - raw.length} left out: published before the retention horizon`);

    // 2. Classify + entity-resolve (curated universe + held-holding fallback).
    const ids = raw.map((a) => a.external_id).filter(Boolean);
    const stored = ids.length ? await query('SELECT external_id, feeds FROM articles WHERE external_id = ANY($1)', [ids]) : [];
    const known = new Set(stored.map((r) => r.external_id));
    // With a Finnhub key each company story says whose feed it came from, and a US listed
    // name is tagged from its own feed only. Without one there is no such feed to wait for.
    const ownFeed = !!process.env.FINNHUB_API_KEY;
    const gained = ownFeed ? usNews.gainedFeeds(raw, stored) : new Map();
    // INDIA_LISTED_NEWS: the Indian listed names are matched too, held or not. They go to the
    // resolver only; the per-company fetches above still run for held tickers alone.
    const heldTickers = new Set(tickers);
    const named = FEATURES.INDIA_LISTED_NEWS ? [...held, ...indianListed().filter((c) => !heldTickers.has(c.ticker))] : held;
    const { articles, dropped } = await classifyArticles(raw, named, known, { ownFeed, gained });
    if (dropped) console.log(`   🇺🇸 ${dropped} left out: brought in by the US rotation and about no company`);

    // 3. Persist new articles (+ relevance/cluster grade) + their per-ticker sentiment.
    const { newArticles, newByFinbert, relevantCount, feedTags } = await storeArticles(articles, gained);
    // Which scorer read the new stories: FinBERT when it is on and working, else the word list.
    console.log(`   💾 ${newArticles} new articles stored, ${relevantCount} relevant (read by ${newByFinbert ? `FinBERT: ${newByFinbert}, word list: ${newArticles - newByFinbert}` : 'the word list'})`);
    if (feedTags) console.log(`   🇺🇸 ${feedTags} stored stor${feedTags === 1 ? 'y' : 'ies'} now tagged from a US name's own feed`);

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

    // 8. Embed new relevant articles for Ask's news search (flag + HF token + pgvector;
    //    otherwise Ask falls back to keyword search). Bounded per run; never fails the pipeline.
    try {
      const emb = await embedPendingArticles();
      if (emb.embedded || emb.skipped !== 'disabled') console.log(`   🔎 news search: ${emb.embedded} embedded${emb.skipped ? ` (${emb.skipped})` : ''}`);
    } catch (err) {
      console.warn('   ⚠️  news embedding step failed:', err.message);
    }
    // 9. IPO Watch: link the new stories to the issues they are about. Never fails the pipeline.
    if (FEATURES.IPO_WATCH) {
      try {
        const ipo = await linkArticles();
        const tone = await readPendingStories();
        if (ipo.linked || tone.read) console.log(`   📅 IPO Watch: ${ipo.linked} story link(s) added, ${tone.read} read for tone`);
      } catch (err) {
        console.warn('   ⚠️  IPO story linking failed:', err.message);
      }
    }
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
  // Company filings (SEC 8-K) for held US stocks ride the same cadence — same source, same
  // rate limit — but a failure here must not look like a smart-money failure.
  try {
    const d = await syncDisclosures();
    if (d.inserted) console.log(`   📄 filings: ${d.inserted} new 8-K(s) across ${d.checked} ticker(s)`);
    if (d.error) console.warn(`   ⚠️  filings: ${d.error}`);
  } catch (err) {
    console.error('Disclosure sync error:', err);
    captureException(err);
  }
}

// Daily analyst brief (E5) — server-scheduled only, on each user's own clock; cost guardrails
// live in reports.js.
async function runDailyBriefs() {
  try {
    // Runs every few minutes; a user's brief is written when their own morning comes.
    const r = await generateDailyBriefs();
    if (r.due) console.log(`📝 Briefs: ${r.due} written — ${r.claude} via Claude, ${r.fallback} via fallback writer`);
  } catch (err) {
    console.error('Daily brief run error:', err);
    captureException(err);
  }
}

// India smart money — NSE bulk/block deals + insider trades, once a day.
async function runIndiaSmartMoneyPoll() {
  if (!FEATURES.INDIA_SMART_MONEY) return;
  try {
    console.log(`\n🇮🇳 [${new Date().toLocaleTimeString()}] Polling India smart money (NSE deals + insider trades)...`);
    await pollIndiaSmartMoney();
  } catch (err) {
    console.error('India smart-money poll error:', err);
    captureException(err);
  }
}

// IPO Watch — the calendar of Indian public issues, once a day.
async function runIpoCalendarPoll() {
  if (!FEATURES.IPO_WATCH) return;
  try {
    const r = await pollCalendar();
    console.log(`\n📅 IPO calendar: ${r.stored} issue(s), ${r.gmp + r.gmpHistory} GMP and ${r.subscriptions} subscription reading(s), ${r.outcomes} new outcome(s) stored from ${r.sources} source(s)`);
    for (const f of r.failed) console.warn(`   ⚠️  ${f.source}: ${f.error}`);
    // A newly seen issue gets the stories written before we knew of it; a listed one its ticker.
    const links = await linkArticles({ days: IPO_WATCH.LINK_BACKFILL_DAYS });
    await readPendingStories();
    const sym = await linkSymbols();
    console.log(`   ${links.linked} story link(s) added; ticker found for ${sym.found} of ${sym.due} listed issue(s)${sym.error ? ` (${sym.error})` : ''}`);
    const ret = await resolveReturns();
    if (ret.due) console.log(`   returns: ${ret.updated} of ${ret.due} issue(s) updated${ret.error ? ` (${ret.error})` : ''}`);
    const us = await resolveUsOutcomes();
    if (us.due) console.log(`   US outcomes: ${us.updated} of ${us.due} issue(s) updated${us.error ? ` (${us.error})` : ''}`);
    // A listed issue whose ticker a price now confirms joins the company reference.
    const grad = await graduate();
    if (grad.graduated || grad.clashes) console.log(`   graduated ${grad.graduated} compan${grad.graduated === 1 ? 'y' : 'ies'} into the reference${grad.clashes ? `; ${grad.clashes} ticker clash(es) skipped` : ''}`);
  } catch (err) {
    console.error('IPO calendar poll error:', err);
    captureException(err);
  }
}

// Ask thread retention — drop conversations untouched for QA.THREAD_RETENTION_DAYS.
async function runThreadPurge() {
  try {
    const n = await purgeOldThreads();
    if (n) console.log(`🧹 Purged ${n} Ask conversation(s) older than ${QA.THREAD_RETENTION_DAYS} days`);
  } catch (err) {
    console.error('Ask thread purge error:', err);
    captureException(err);
  }
}

// News retention — archive, roll up and remove old stories (services/retention.js). Runs
// only when FEATURES.RETENTION is on.
async function runRetention() {
  try {
    const r = await retention.prune({ write: true, log: console.log });
    if (r.written) console.log(`🗄️  Retention: ${r.deleted} stories removed (${r.unused} unused, ${r.used} used), ${r.readingsRolled} readings added to ${r.tickerDays} ticker-days, archive ${r.archive.file}`);
  } catch (err) {
    console.error('Retention error:', err);
    captureException(err);
  }
}

// Report emails — whoever is inside their morning (or Sunday-evening) window and has not had
// that day's report. The service never throws; this only logs what went out.
async function runReportEmailJob() {
  const r = await runReportEmails();
  if (r.due) console.log(`📬 Report emails: ${r.sent} sent, ${r.failed} failed`);
}

// Paper ledger (v2) — record each deployment's fills and closing value for the days that
// have completed, then email the new fills. A deployment already marked today is skipped.
async function runPaperMarkJob() {
  if (!FEATURES.STRATEGIES) return;
  try {
    const r = await runPaperMarks();
    if (!r.due) return;
    console.log(`\n📒 Paper ledger: ${r.marked} of ${r.due} deployment(s) marked, ${r.fills} fill(s) and ${r.days} day(s) recorded; emails ${r.emails.sent} sent, ${r.emails.skipped} skipped, ${r.emails.failed} failed`);
    for (const f of r.failed) console.warn(`   ⚠️  deployment ${f.id}: ${f.error}`);
  } catch (err) {
    console.error('Paper ledger error:', err);
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

  // India smart money: once a day after the NSE close, never on boot — the routes are
  // unofficial, so a restart loop must not turn into a burst of requests.
  if (FEATURES.INDIA_SMART_MONEY) {
    tasks.push(cron.schedule(INDIA_SMART_MONEY.CRON, runIndiaSmartMoneyPoll, { timezone: INDIA_SMART_MONEY.TIMEZONE }));
    console.log(`⏰ India smart-money poller started — ${INDIA_SMART_MONEY.CRON} ${INDIA_SMART_MONEY.TIMEZONE}`);
  }

  if (FEATURES.IPO_WATCH) {
    tasks.push(cron.schedule(IPO_WATCH.CRON, runIpoCalendarPoll, { timezone: IPO_WATCH.TIMEZONE }));
    console.log(`⏰ IPO calendar poller started — ${IPO_WATCH.CRON} ${IPO_WATCH.TIMEZONE}`);
  }

  // Paper ledger: once a day after every market has closed, and once after start — the
  // engine is our own process, and the app is not always up at the scheduled minute.
  if (FEATURES.STRATEGIES) {
    setTimeout(runPaperMarkJob, PAPER.BOOT_DELAY_MS);
    tasks.push(cron.schedule(PAPER.MARK_CRON, runPaperMarkJob, { timezone: PAPER.MARK_TIMEZONE }));
    console.log(`⏰ Paper ledger started — ${PAPER.MARK_CRON} ${PAPER.MARK_TIMEZONE}`);
  }

  tasks.push(cron.schedule(REPORTS.CRON, runDailyBriefs));
  console.log(`⏰ Daily-brief generator started — ${REPORTS.CRON}, each user at ${String(REPORTS.LOCAL_TIME.HOUR).padStart(2, '0')}:${String(REPORTS.LOCAL_TIME.MINUTE).padStart(2, '0')} their time`);

  tasks.push(cron.schedule(QA.THREAD_PURGE_CRON, runThreadPurge));

  if (FEATURES.RETENTION) {
    tasks.push(cron.schedule(RETENTION.CRON, runRetention));
    console.log(`⏰ News retention started — ${RETENTION.CRON}: unused stories ${RETENTION.UNUSED_DAYS} days, the rest ${RETENTION.USED_DAYS}`);
  }

  tasks.push(cron.schedule(REPORT_EMAIL.CRON, runReportEmailJob));
  console.log(`⏰ Report emails started — ${REPORT_EMAIL.CRON}`);

  return tasks;
}

module.exports = { startScheduler, runNewsPipeline, runSmartMoneyPoll, runDailyBriefs, classifyArticles, storeArticles };
