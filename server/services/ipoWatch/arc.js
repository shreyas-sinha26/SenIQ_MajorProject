/**
 * IPO Watch — the news and sentiment arc (IPO_PLAN.md, Change 3).
 *
 * The stories linked to an issue (registry.js), each read for its tone, laid out by day
 * from the first mention to after listing. The main pipeline stores sentiment per ticker,
 * which an unlisted company does not have, so the stories are read here: FinBERT when it is
 * on, else the word list — one reading of the headline and summary, as the pipeline does.
 *
 * One kind of story is not left to the model. A headline that reports a subscription figure
 * ("IPO subscribed 42%") is scored from the figure: the model reads the word "subscribed" as
 * good news whatever the number.
 *
 * A story that covers several issues at once is listed but not read: one tone for the whole
 * text is about none of them. The same goes for a story that names the issue only below
 * its headline.
 */

const { query, execute } = require('../../db');
const { IPO_WATCH } = require('../../config');
const { analyzeSentiment } = require('../sentiment');
const { classifyBatch } = require('../finbertClassifier');
const { sourceWeight, labelFor } = require('../sentimentScoring');
const { buildMatcher } = require('./registry');

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// Whether a story's headline names the issue (by name or alias). A story that names it only
// further down — a list of the day's movers, a weekly recap — mentions the issue but is not
// about it, so it is linked and listed but not read for tone. Pure.
const inHeadline = (ipo, title) => buildMatcher([ipo])(title, '').length > 0;

const NUM = '(\\d+(?:\\.\\d+)?)\\s?(x|times|%)';
const SUB_PATTERNS = [
  new RegExp(`\\b(?:over)?subscribed(?: over| nearly| about| around)? ${NUM}`, 'i'),      // "subscribed 42%", "subscribed over 1.6x"
  new RegExp(`\\bbooked(?: over| nearly| about| around)? ${NUM}`, 'i'),                    // "booked 7.08x so far"
  new RegExp(`\\b${NUM} subscription\\b`, 'i'),                                           // "ends with 1.58 times subscription"
  new RegExp(`\\bsubscription (?:reaches|reached|at|hits|stands at|of) ${NUM}`, 'i'),      // "subscription reaches 18.07 times"
];

// How many times over the headline says the issue is subscribed: "subscribed 42%" → 0.42,
// "booked 7.08x" → 7.08. null when the headline gives no such figure. Pure.
function subscriptionFigure(title) {
  for (const re of SUB_PATTERNS) {
    const m = String(title || '').match(re);
    if (m) return m[2] === '%' ? Number(m[1]) / 100 : Number(m[1]);
  }
  return null;
}

// Whether the headline's figure is the final one: it says so, or the story is from the
// closing day or later. Pure.
function isFinalFigure(title, day, closeDate) {
  if (/\b(final day|last day|ends with|issue ends|closes with|at close)\b/i.test(title || '')) return true;
  return Boolean(day && closeDate && day >= closeDate);
}

// A subscription figure as tone. FinBERT reads "subscribed 42%" as good news; it is not.
//   covered or better  → 50 at 1x, rising with each tenfold: 70 at 10x, 90 at 100x
//   under 1x, final    → below 50, falling fast: 31 at 0.42x, 18 at 0.23x
//   under 1x, earlier  → 50: bidding is still open, so it is not yet a verdict
// Pure.
function subscriptionTone(times, final) {
  let score = 0.5;
  if (times >= 1) score = Math.min(0.95, 0.5 + 0.2 * Math.log10(times));
  else if (final) score = Math.max(0.05, 0.5 + 0.5 * Math.log10(Math.max(times, 0.01)));
  score = round(score);
  return { label: labelFor(score), score, confidence: 0.9, model: 'subscription-rule' };
}

// The reading a story gets from its own figures, without a model — or null when it has none. Pure.
function ruleReading(story) {
  const times = subscriptionFigure(story.title);
  return times == null ? null : subscriptionTone(times, isFinalFigure(story.title, story.day, story.close_date));
}

// texts → [{ label, score, confidence, model }], FinBERT first, the word list otherwise.
async function readTexts(texts) {
  const finbert = texts.length ? await classifyBatch(texts) : [];
  return texts.map((t, i) => {
    if (finbert && finbert[i]) return finbert[i];
    const s = analyzeSentiment(t);
    return { label: s.label, score: s.score, confidence: s.confidence, model: 'lexicon' };
  });
}

const PENDING_SQL = `
  SELECT x.ipo_id, x.article_id, a.title, a.summary, i.close_date::text AS close_date,
         i.id, i.name, i.name_key, i.aliases,
         to_char(COALESCE(a.published_at, a.fetched_at) AT TIME ZONE $1, 'YYYY-MM-DD') AS day,
         (SELECT count(*)::int FROM ipo_articles y WHERE y.article_id = x.article_id) AS issues
    FROM ipo_articles x JOIN articles a ON a.id = x.article_id JOIN ipos i ON i.id = x.ipo_id`;

const saveReading = (r, s) => execute(
  `UPDATE ipo_articles SET sentiment_label = $3, sentiment_score = $4, sentiment_confidence = $5, sentiment_model = $6, read_at = now()
    WHERE ipo_id = $1 AND article_id = $2`,
  [r.ipo_id, r.article_id, s.label, s.score, s.confidence, s.model]
);

// Read the linked stories that have not been looked at yet, a capped number a run. A story
// whose headline carries a subscription figure is scored from the figure; the rest go to
// the model.
async function readPendingStories({ limit = IPO_WATCH.STORY_READS_PER_RUN, read = readTexts } = {}) {
  const rows = await query(`${PENDING_SQL} WHERE x.read_at IS NULL ORDER BY x.created_at LIMIT $2::int`, [IPO_WATCH.TIMEZONE, limit]);
  const single = rows.filter((r) => r.issues === 1 && inHeadline(r, r.title));
  const byRule = single.map(ruleReading);
  const forModel = single.filter((_, i) => !byRule[i]);
  const modelReadings = await read(forModel.map((r) => `${r.title} ${r.summary || ''}`.trim()));
  let m = 0;
  for (const [i, r] of single.entries()) await saveReading(r, byRule[i] || modelReadings[m++]);
  for (const r of rows.filter((x) => !single.includes(x))) {
    await execute('UPDATE ipo_articles SET read_at = now() WHERE ipo_id = $1 AND article_id = $2', [r.ipo_id, r.article_id]);
  }
  return { read: single.length, byRule: byRule.filter(Boolean).length, unread: rows.length - single.length };
}

// Go back over stories already read: re-score the ones a rule now covers, and take the
// reading off any that should not have one (the issue is not in the headline). No model runs.
async function reapplyRules() {
  const rows = await query(`${PENDING_SQL} WHERE x.read_at IS NOT NULL`, [IPO_WATCH.TIMEZONE]);
  let changed = 0;
  let cleared = 0;
  let requeued = 0;
  for (const r of rows.filter((x) => x.issues === 1)) {
    if (!inHeadline(r, r.title)) {
      const u = await execute(
        `UPDATE ipo_articles SET sentiment_label = NULL, sentiment_score = NULL, sentiment_confidence = NULL, sentiment_model = NULL
          WHERE ipo_id = $1 AND article_id = $2 AND sentiment_score IS NOT NULL`,
        [r.ipo_id, r.article_id]
      );
      cleared += u.rowCount || 0;
      continue;
    }
    const s = ruleReading(r);
    if (s) { await saveReading(r, s); changed++; continue; }
    // In the headline (a new alias, say) but never read: hand it back to the next pipeline pass.
    const q = await execute('UPDATE ipo_articles SET read_at = NULL WHERE ipo_id = $1 AND article_id = $2 AND sentiment_score IS NULL', [r.ipo_id, r.article_id]);
    requeued += q.rowCount || 0;
  }
  return { checked: rows.length, changed, cleared, requeued };
}

// A story's weight in an average: how far its source is trusted.
const weightOf = (s) => sourceWeight(s.source, s.platform || 'news');

function weightedScore(stories) {
  const w = stories.reduce((sum, s) => sum + weightOf(s), 0);
  return w ? stories.reduce((sum, s) => sum + s.sentiment.score * weightOf(s), 0) / w : null;
}

// The stories that carry a reading, by day (oldest first): how many, and their weighted
// tone on the 0–1 scale. Pure.
function arcOf(stories) {
  const byDay = new Map();
  for (const s of stories) {
    if (!s.sentiment || !s.day) continue;
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  return [...byDay.keys()].sort().map((day) => ({ day, stories: byDay.get(day).length, score: round(weightedScore(byDay.get(day))) }));
}

// The overall tone across every read story, or null when none has been read. Pure.
function toneOf(stories) {
  const read = stories.filter((s) => s.sentiment);
  if (!read.length) return null;
  const score = round(weightedScore(read));
  return { score, label: labelFor(score), stories: read.length };
}

// Everything the page shows for one issue's news: its stories (newest first), the arc and
// the overall tone. `shared` marks a story that covers several issues, `passing` one that
// names this issue only below the headline; neither has a reading.
async function storiesFor(ipoId) {
  const rows = await query(
    `SELECT a.id, a.title, a.url, a.source, a.platform, a.published_at,
            to_char(COALESCE(a.published_at, a.fetched_at) AT TIME ZONE $2, 'YYYY-MM-DD') AS day,
            x.matched_on, x.sentiment_label, x.sentiment_score, x.sentiment_model,
            (SELECT count(*)::int FROM ipo_articles y WHERE y.article_id = a.id) AS issues
       FROM ipo_articles x JOIN articles a ON a.id = x.article_id
      WHERE x.ipo_id = $1
      ORDER BY COALESCE(a.published_at, a.fetched_at) DESC`,
    [ipoId, IPO_WATCH.TIMEZONE]
  );
  const ipo = (await query('SELECT id, name, name_key, aliases FROM ipos WHERE id = $1', [ipoId]))[0];
  const stories = rows.map((r) => {
    const shared = r.issues > 1;
    const passing = !shared && Boolean(ipo) && !inHeadline(ipo, r.title);
    return {
      id: r.id, title: r.title, url: r.url, source: r.source, platform: r.platform, published_at: r.published_at, day: r.day,
      matched_on: r.matched_on, shared, passing,
      sentiment: !shared && !passing && r.sentiment_score != null ? { label: r.sentiment_label, score: round(r.sentiment_score), model: r.sentiment_model } : null,
    };
  });
  return { stories, arc: arcOf(stories), tone: toneOf(stories) };
}

module.exports = { inHeadline, subscriptionFigure, isFinalFigure, subscriptionTone, ruleReading, readTexts, readPendingStories, reapplyRules, arcOf, toneOf, storiesFor };
