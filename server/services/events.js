/**
 * Durable events (Engine Phase E1b).
 *
 * After articles are stored, this rolls them up into persistent `events` (one per
 * cluster_key) and attaches each article to its event. Runs every pipeline pass; an
 * event is upserted so the same story re-appearing in a later run updates the existing
 * row (source_count, last_seen) instead of creating a new one — that's what makes an
 * event a thing the system *remembers*.
 *
 * Aggregates are computed set-based from the articles table over a bounded window:
 *   - representative title/url/source = the cluster's highest-importance, newest article
 *   - source_count / first_seen / last_seen = over the cluster's articles
 *   - primary_ticker = the most-mentioned non-macro ticker in the cluster
 */

const { execute, query } = require('../db');
const { EVENTS } = require('../config');
const { classifyEventType } = require('./eventTyping');

async function upsertEvents() {
  const win = String(EVENTS.WINDOW_DAYS);

  // 1. Upsert one event per cluster_key from recent RELEVANT articles. Representative
  //    fields come from the highest-importance/newest article (DISTINCT ON). first_seen
  //    is kept as the earliest ever seen.
  await execute(
    `WITH agg AS (
       SELECT a.cluster_key,
              count(*)                AS source_count,
              min(a.published_at)     AS first_seen,
              max(a.published_at)     AS last_seen,
              max(a.importance)       AS importance,
              max(a.relevance_tier)   AS relevance_tier
         FROM articles a
        WHERE a.is_relevant AND a.relevance_tier <> 'none' AND a.cluster_key IS NOT NULL
          AND a.published_at > now() - ($1 || ' days')::interval
        GROUP BY a.cluster_key
     ),
     rep AS (
       SELECT DISTINCT ON (a.cluster_key) a.cluster_key, a.title, a.url, a.source
         FROM articles a
        WHERE a.is_relevant AND a.relevance_tier <> 'none' AND a.cluster_key IS NOT NULL
          AND a.published_at > now() - ($1 || ' days')::interval
        ORDER BY a.cluster_key, a.importance DESC, a.published_at DESC
     )
     INSERT INTO events (cluster_key, title, url, source, relevance_tier, importance, source_count, first_seen, last_seen)
     SELECT agg.cluster_key, rep.title, rep.url, rep.source, agg.relevance_tier, agg.importance,
            agg.source_count, agg.first_seen, agg.last_seen
       FROM agg JOIN rep USING (cluster_key)
     ON CONFLICT (cluster_key) DO UPDATE SET
       title          = EXCLUDED.title,
       url            = EXCLUDED.url,
       source         = EXCLUDED.source,
       relevance_tier = EXCLUDED.relevance_tier,
       importance     = GREATEST(events.importance, EXCLUDED.importance),
       source_count   = EXCLUDED.source_count,
       first_seen     = LEAST(events.first_seen, EXCLUDED.first_seen),
       last_seen      = GREATEST(events.last_seen, EXCLUDED.last_seen),
       updated_at     = now()`,
    [win]
  );

  // 2. primary_ticker = most-mentioned non-macro ticker in the cluster.
  await execute(
    `WITH ranked AS (
       SELECT a.cluster_key, s.ticker, count(*) AS c
         FROM articles a
         JOIN article_sentiments s ON s.article_id = a.id
        WHERE s.ticker <> '__MARKET__' AND a.cluster_key IS NOT NULL
          AND a.published_at > now() - ($1 || ' days')::interval
        GROUP BY a.cluster_key, s.ticker
     ),
     top AS (
       SELECT DISTINCT ON (cluster_key) cluster_key, ticker
         FROM ranked ORDER BY cluster_key, c DESC
     )
     UPDATE events e SET primary_ticker = top.ticker
       FROM top WHERE top.cluster_key = e.cluster_key`,
    [win]
  );

  // 3. Attach articles to their event.
  const res = await execute(
    `UPDATE articles a SET event_id = e.id
       FROM events e
      WHERE a.cluster_key = e.cluster_key
        AND a.is_relevant AND a.relevance_tier <> 'none'
        AND (a.event_id IS DISTINCT FROM e.id)`
  );

  // 4. Aggregate the sector THEMES of a cluster's articles onto the event, so a
  //    sector-wide story can touch holdings in that sector (E2 impact).
  await execute(
    `UPDATE events e SET sectors = COALESCE(sub.sectors, '{}')
       FROM (
         SELECT a.event_id, array_agg(DISTINCT sec) AS sectors
           FROM articles a, unnest(a.sectors) AS sec
          WHERE a.event_id IS NOT NULL
          GROUP BY a.event_id
       ) sub
      WHERE sub.event_id = e.id AND e.sectors IS DISTINCT FROM sub.sectors`
  );

  // 5. Type each recent event (earnings/legal/M&A/…) from its representative title.
  const recent = await query(
    `SELECT id, title, relevance_tier, event_type FROM events
      WHERE last_seen > now() - ($1 || ' days')::interval`,
    [win]
  );
  for (const ev of recent) {
    const type = classifyEventType(ev.title, '', ev.relevance_tier);
    if (type !== ev.event_type) {
      await execute('UPDATE events SET event_type = $2 WHERE id = $1', [ev.id, type]);
    }
  }

  // 6. Prune events that have aged out of the window (cascades impacts).
  await execute(
    `DELETE FROM events WHERE last_seen < now() - ($1 || ' days')::interval`,
    [win]
  );

  return res.rowCount;
}

module.exports = { upsertEvents };
