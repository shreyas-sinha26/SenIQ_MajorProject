/**
 * News retention — archive, roll up, then prune.
 *
 * Stories were kept for good, and the articles table was the one part of the database that
 * grew without limit. Nothing the app shows reads a story older than 90 days, so old ones
 * can go — but not before three things are safe:
 *
 *   1. ARCHIVE. Every story about to go is written to a gzip file first (one JSON story per
 *      line, with its readings and IPO links), and the file is read back and counted before
 *      anything is deleted. Once the text is gone a day cannot be read again by a better
 *      model; the archive is what keeps that possible.
 *   2. ROLL UP. A strategy's sentiment factors read every day there is, and deleting an
 *      article deletes its readings with it. So each reading's share of its ticker's day is
 *      added to sentiment_daily in the same transaction as the delete (signalHistory.js adds
 *      the two back together). Backtests see the same numbers before and after.
 *   3. IPO STORIES. A story linked to an issue that is not finished is never pruned: the IPO
 *      Watch page builds the issue's tone from its stories. Finished = withdrawn or listed,
 *      and no longer on the calendar. The first time a finished issue loses a story, its
 *      news as the page last showed it is saved to ipo_news_summary.
 *
 * Two ages (config RETENTION), each counted from the LATER of published and fetched — how
 * long the story has been held, so one that was already old when fetched is not removed and
 * fetched again the next day:
 *   unused — judged irrelevant, no reading, no IPO link: UNUSED_DAYS.
 *   used   — everything else: USED_DAYS.
 * A story attached to an event that is still alive is left alone whatever its age.
 *
 * plan() only reads. prune({ write: true }) is the one thing here that removes anything; the
 * scheduler calls it only when FEATURES.RETENTION is on.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { RETENTION, FEATURES } = require('../config');
const { sentimentSums, READING_COLS } = require('./signalHistory');

const DAY_MS = 86400e3;
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// ── Pure helpers ──

// The two dates a story must have been held since before it may go. Pure.
function cutoffs(now = new Date(), { unusedDays = RETENTION.UNUSED_DAYS, usedDays = RETENTION.USED_DAYS } = {}) {
  const t = new Date(now).getTime();
  return { unused: new Date(t - unusedDays * DAY_MS), used: new Date(t - usedDays * DAY_MS) };
}

// The issues whose stories may be pruned: withdrawn or listed, and off the calendar. An
// issue that has not listed keeps its stories however long ago it was announced — it can
// still come to market, and the page would then need them. Pure.
function finishedIpoIds(ipos, onCalendar) {
  return ipos.filter((i) => !onCalendar.has(i.id) && (i.withdrawn || i.listing_date)).map((i) => i.id);
}

// Readings of the stories about to go → the rows to add into sentiment_daily. Pure.
function rollupRows(readings) {
  const byTicker = new Map();
  for (const r of readings) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  const out = [];
  for (const [ticker, rows] of byTicker) {
    for (const d of sentimentSums(rows)) out.push({ ticker, day: d.date, n_articles: d.n_articles, score_sum: d.score_sum, w_sum: d.w_sum, w_score: d.w_score });
  }
  return out;
}

// What storiesFor returns for an issue → its ipo_news_summary row. Pure.
function ipoSummary(ipoId, news) {
  const stories = (news && news.stories) || [];
  const days = stories.map((s) => s.day).filter(Boolean).sort();
  return {
    ipo_id: ipoId,
    stories: stories.length,
    stories_read: news && news.tone ? news.tone.stories : 0,
    tone_score: news && news.tone ? news.tone.score : null,
    tone_label: news && news.tone ? news.tone.label : null,
    first_story: days[0] || null,
    last_story: days[days.length - 1] || null,
    by_day: (news && news.arc) || [],
  };
}

// One archived story: the row as stored (minus the search index, which is derived), why it
// went, and what hung off it. Pure.
function archiveRecord(row, unused) {
  const { sentiments, ipo_links: ipoLinks, ...article } = row;
  return { ...article, class: unused ? 'unused' : 'used', sentiments: sentiments || [], ipo_links: ipoLinks || [] };
}

// Stories from the fetchers, less any published before the pruning horizon. Pure.
function dropTooOld(articles, cutoff) {
  if (!cutoff) return articles;
  return articles.filter((a) => !(a.published_at && new Date(a.published_at) < cutoff));
}

const archiveName = (now) => `articles-${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z.jsonl.gz`;
const archiveDirOf = (dir = RETENTION.ARCHIVE_DIR) => (path.isAbsolute(dir) ? dir : path.join(PROJECT_ROOT, dir));

// ── Reads ──

// The issues whose stories may be pruned, as of `now`.
async function loadFinishedIpoIds(now) {
  const { query } = require('../db');
  const { listCalendar, marketDate, MARKETS } = require('./ipoWatch');
  const today = marketDate(new Date(now));
  const shown = (await Promise.all(MARKETS.map((market) => listCalendar({ market, board: 'all', spacs: true, today })))).flat();
  const ipos = await query('SELECT id, withdrawn, listing_date::text AS listing_date FROM ipos');
  return finishedIpoIds(ipos, new Set(shown.map((r) => r.id)));
}

// A story is `unused` when nothing was ever made of it.
const UNUSED_SQL = `(NOT a.is_relevant
        AND NOT EXISTS (SELECT 1 FROM article_sentiments s WHERE s.article_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM ipo_articles x WHERE x.article_id = a.id))`;
const HELD_SINCE_SQL = 'GREATEST(a.published_at, a.fetched_at)';

/**
 * What a run at `now` would remove, and what it would keep back. Reads only.
 * { now, cutoffs, total, unused, used, ids, unusedIds, readings, tickerDays, ipoIssues,
 *   keptForIpo, keptForEvent, oldest, newest }
 */
async function plan({ now = new Date(), unusedDays, usedDays } = {}) {
  const { query } = require('../db');
  const cut = cutoffs(now, { unusedDays, usedDays });
  const finished = await loadFinishedIpoIds(now);
  // Everything held longer than the shorter age; the longer age is applied below, by class.
  const old = await query(
    `SELECT a.id, ${UNUSED_SQL} AS unused, ${HELD_SINCE_SQL} AS held_since,
            EXISTS (SELECT 1 FROM events e WHERE e.id = a.event_id) AS in_live_event,
            EXISTS (SELECT 1 FROM ipo_articles x WHERE x.article_id = a.id AND NOT (x.ipo_id = ANY($2::int[]))) AS ipo_unfinished
       FROM articles a
      WHERE ${HELD_SINCE_SQL} < $1
      ORDER BY a.id`,
    [cut.unused > cut.used ? cut.unused : cut.used, finished]
  );
  const due = old.filter((r) => new Date(r.held_since) < (r.unused ? cut.unused : cut.used));
  const going = due.filter((r) => !r.in_live_event && !r.ipo_unfinished);
  const ids = going.map((r) => Number(r.id));
  const unusedIds = going.filter((r) => r.unused).map((r) => Number(r.id));

  const readings = ids.length ? await loadReadings(ids, query) : [];
  const ipoIssues = ids.length
    ? await query(
      `SELECT i.id, i.name, i.market, count(*)::int AS stories,
              EXISTS (SELECT 1 FROM ipo_news_summary n WHERE n.ipo_id = i.id) AS saved
         FROM ipo_articles x JOIN ipos i ON i.id = x.ipo_id
        WHERE x.article_id = ANY($1) GROUP BY i.id ORDER BY i.name`, [ids])
    : [];
  const total = (await query('SELECT count(*)::int AS n FROM articles'))[0].n;
  const held = going.map((r) => new Date(r.held_since).getTime());
  return {
    now: new Date(now), cutoffs: cut, total,
    unused: unusedIds.length, used: ids.length - unusedIds.length,
    ids, unusedIds,
    readings: readings.length, tickerDays: rollupRows(readings).length,
    ipoIssues,
    keptForIpo: due.filter((r) => r.ipo_unfinished).length,
    keptForEvent: due.filter((r) => r.in_live_event && !r.ipo_unfinished).length,
    oldest: held.length ? new Date(Math.min(...held)) : null,
    newest: held.length ? new Date(Math.max(...held)) : null,
  };
}

// The readings of these stories, in the columns the strategy factors read. A story with no
// published date has no day to add to (the live query cannot place it either).
function loadReadings(ids, run) {
  return run(
    `SELECT s.ticker, ${READING_COLS}
       FROM article_sentiments s JOIN articles a ON a.id = s.article_id
      WHERE a.id = ANY($1) AND a.published_at IS NOT NULL`, [ids]);
}

// ── Archive ──

// Write the stories to a gzip file, one JSON object per line. Returns { file, bytes, sha256, lines }.
// A file of that name already there is never written over; a file left half-written by a
// failure is removed.
async function writeArchive(file, ids, unusedIds) {
  const { query } = require('../db');
  const unused = new Set(unusedIds);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lines = 0;
  async function* stories() {
    for (let i = 0; i < ids.length; i += RETENTION.ARCHIVE_BATCH) {
      const rows = await query(
        `SELECT a.id, a.external_id, a.title, a.summary, a.source, a.url, a.image_url, a.published_at, a.fetched_at,
                a.platform, a.cluster_key, a.relevance_tier, a.importance, a.is_relevant, a.sectors,
                COALESCE((SELECT json_agg(json_build_object('ticker', s.ticker, 'label', s.sentiment_label, 'score', s.sentiment_score,
                                   'confidence', s.confidence, 'model', s.model, 'created_at', s.created_at) ORDER BY s.ticker)
                            FROM article_sentiments s WHERE s.article_id = a.id), '[]') AS sentiments,
                COALESCE((SELECT json_agg(json_build_object('ipo_id', x.ipo_id, 'issue', i.name, 'market', i.market, 'matched_on', x.matched_on,
                                   'label', x.sentiment_label, 'score', x.sentiment_score, 'model', x.sentiment_model) ORDER BY x.ipo_id)
                            FROM ipo_articles x JOIN ipos i ON i.id = x.ipo_id WHERE x.article_id = a.id), '[]') AS ipo_links
           FROM articles a WHERE a.id = ANY($1) ORDER BY a.id`,
        [ids.slice(i, i + RETENTION.ARCHIVE_BATCH)]
      );
      for (const row of rows) {
        lines++;
        yield `${JSON.stringify(archiveRecord(row, unused.has(Number(row.id))))}\n`;
      }
    }
  }
  try {
    await pipeline(Readable.from(stories()), zlib.createGzip(), fs.createWriteStream(file, { flags: 'wx' }));
  } catch (err) {
    if (err.code !== 'EEXIST') fs.rmSync(file, { force: true });
    throw err;
  }
  return { file, lines, ...(await fileDigest(file)) };
}

async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

// Read an archive back: how many stories it holds and their ids. Throws on a line that is
// not a story, so a file cut short is not mistaken for a whole one.
async function readArchive(file) {
  const ids = [];
  let rest = '';
  const take = (line) => {
    if (!line) return;
    const rec = JSON.parse(line);
    if (rec == null || rec.id == null || typeof rec.title !== 'string') throw new Error(`a line of ${path.basename(file)} is not a story`);
    ids.push(Number(rec.id));
  };
  const source = fs.createReadStream(file);
  const gunzip = zlib.createGunzip();
  source.on('error', (err) => gunzip.destroy(err));   // a missing file must fail the read, not hang it
  for await (const chunk of source.pipe(gunzip)) {
    const parts = (rest + chunk.toString('utf8')).split('\n');
    rest = parts.pop();
    parts.forEach(take);
  }
  take(rest);
  return { lines: ids.length, ids };
}

// ── The run ──

/**
 * Archive, roll up and remove what plan() lists. With `write` false (the default) nothing is
 * written anywhere: the result is the plan. Returns the plan plus, after a real run,
 * { deleted, readingsRolled, tickerDays, ipoSummaries, archive }.
 */
async function prune({ write = false, now = new Date(), unusedDays, usedDays, archiveDir, log = () => {} } = {}) {
  const p = await plan({ now, unusedDays, usedDays });
  if (!write || !p.ids.length) return { ...p, written: false };

  // 1. Archive, then read the file back: nothing is deleted unless every story is in it.
  const file = path.join(archiveDirOf(archiveDir), archiveName(now));
  const archive = await writeArchive(file, p.ids, p.unusedIds);
  const back = await readArchive(file);
  const archived = new Set(back.ids);
  if (back.lines !== p.ids.length || !p.ids.every((id) => archived.has(id))) {
    throw new Error(`archive ${path.basename(file)} holds ${back.lines} of ${p.ids.length} stories — nothing was deleted`);
  }
  log(`   archived ${archive.lines} stories → ${file} (${archive.bytes} bytes)`);

  // 2. The news of each finished issue about to lose a story, as the page last showed it.
  const { storiesFor } = require('./ipoWatch/arc');
  const summaries = [];
  for (const issue of p.ipoIssues.filter((i) => !i.saved)) summaries.push(ipoSummary(issue.id, await storiesFor(issue.id)));

  // 3. Roll up and delete as one unit: either both happen or neither does.
  const { tx } = require('../db');
  const cut = p.cutoffs;
  const done = await tx(async (client) => {
    const run = async (sql, params) => (await client.query(sql, params)).rows;
    // The rows are locked, so a reading cannot be added to one between the roll-up and the delete.
    const locked = await run('SELECT id FROM articles WHERE id = ANY($1) FOR UPDATE', [p.ids]);
    const ids = locked.map((r) => Number(r.id));
    const rows = rollupRows(await loadReadings(ids, run));
    const readingsRolled = rows.reduce((n, r) => n + r.n_articles, 0);
    for (const r of rows) {
      await client.query(
        `INSERT INTO sentiment_daily (ticker, day, n_articles, score_sum, w_sum, w_score)
         VALUES ($1, $2::date, $3, $4, $5, $6)
         ON CONFLICT (ticker, day) DO UPDATE SET
           n_articles = sentiment_daily.n_articles + EXCLUDED.n_articles,
           score_sum  = sentiment_daily.score_sum  + EXCLUDED.score_sum,
           w_sum      = sentiment_daily.w_sum      + EXCLUDED.w_sum,
           w_score    = sentiment_daily.w_score    + EXCLUDED.w_score,
           updated_at = now()`,
        [r.ticker, r.day, r.n_articles, r.score_sum, r.w_sum, r.w_score]
      );
    }
    for (const s of summaries) {
      await client.query(
        `INSERT INTO ipo_news_summary (ipo_id, stories, stories_read, tone_score, tone_label, first_story, last_story, by_day)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8::jsonb) ON CONFLICT (ipo_id) DO NOTHING`,
        [s.ipo_id, s.stories, s.stories_read, s.tone_score, s.tone_label, s.first_story, s.last_story, JSON.stringify(s.by_day)]
      );
    }
    const gone = await client.query('DELETE FROM articles WHERE id = ANY($1)', [ids]);
    const unused = new Set(p.unusedIds);
    const unusedDeleted = ids.filter((id) => unused.has(id)).length;
    await client.query(
      `INSERT INTO retention_runs (unused_days, used_days, unused_deleted, used_deleted, readings_rolled, ticker_days,
                                   ipo_summaries, archive_file, archive_sha256, archive_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [Math.round((new Date(now) - cut.unused) / DAY_MS), Math.round((new Date(now) - cut.used) / DAY_MS),
       unusedDeleted, gone.rowCount - unusedDeleted, readingsRolled, rows.length, summaries.length,
       path.basename(file), archive.sha256, archive.bytes]
    );
    return { deleted: gone.rowCount, readingsRolled, tickerDays: rows.length };
  });
  everPruned = true;
  return { ...p, written: true, ...done, ipoSummaries: summaries.length, archive };
}

// ── Ingest guard ──

// Once anything has been pruned, a story published before the pruning horizon is not let
// back in. Its day is frozen in sentiment_daily, and a feed that still lists it (some carry
// items for years) would have it counted there a second time. null = let everything in.
// An item the feed gives no date for is stamped with the time it is fetched, so this cannot
// stop one of those returning; they are rare.
let everPruned = false;
async function ingestCutoff(now = new Date()) {
  if (!everPruned) {
    const { queryOne } = require('../db');
    const row = await queryOne('SELECT EXISTS (SELECT 1 FROM retention_runs) AS yes');
    everPruned = Boolean(row && row.yes);
  }
  return everPruned || FEATURES.RETENTION ? cutoffs(now).used : null;
}

module.exports = {
  cutoffs, finishedIpoIds, rollupRows, ipoSummary, archiveRecord, dropTooOld, archiveName, archiveDirOf,
  plan, prune, writeArchive, readArchive, ingestCutoff,
};
