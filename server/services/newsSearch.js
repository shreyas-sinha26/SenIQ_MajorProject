/**
 * News search — the retrieval ("RAG") half of Ask. Everything else Ask knows comes from
 * exact tool queries over engine tables; this is the one place we search free text.
 *
 * Corpus = what the pipeline already ingests: headline + summary of RELEVANT articles from
 * the last NEWS_SEARCH.WINDOW_DAYS (no full-article scraping). Each article is embedded once
 * via the HF Inference API (same HF_API_TOKEN as FinBERT) and stored in pgvector.
 *
 * Retrieval is HYBRID and STORY-LEVEL. Hard filters first (the caller's allowed tickers + date
 * window). Then two independent rankings of the surviving articles — Postgres full-text (exact
 * names, tickers, numbers) and cosine similarity (meaning) — are fused per STORY with reciprocal
 * rank fusion, and re-ranked for this user by portfolio impact, importance and recency. The
 * result is a short list of story cards; get_story_detail expands one into its articles.
 *
 * Degrades, never fails: no pgvector / no token / flag off / HF error → full-text only
 * (mode:'text'); no full-text column yet (migration 0020 not applied) → ILIKE keyword matching
 * (mode:'keyword'). So Ask still works on a fresh local DB.
 *
 * pgvector is optional per environment (Neon has it; a teammate's local Postgres may not), so
 * the store is created here idempotently instead of in a migration that would fail boot.
 */

const { FEATURES, NEWS_SEARCH } = require('../config');

let hf = null;
let storeReady = false; // cached only once true — re-checked each run until pgvector exists

function getClient() {
  if (!hf && process.env.HF_API_TOKEN) {
    const { HfInference } = require('@huggingface/inference');
    hf = new HfInference(process.env.HF_API_TOKEN);
  }
  return hf;
}

function embeddingsEnabled() {
  return FEATURES.NEWS_EMBEDDINGS && !!process.env.HF_API_TOKEN;
}

// ── Pure helpers ──
function l2normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

// Mean-pool token-level output ([[...],[...]]) into one sentence vector.
function meanPool(rows) {
  const out = new Array(rows[0].length).fill(0);
  for (const r of rows) for (let i = 0; i < r.length; i++) out[i] += r[i];
  return out.map((x) => x / rows.length);
}

/** Normalise HF feature-extraction output for N inputs into N unit vectors. Pure. */
function toVectors(output, n) {
  const rows = n === 1 && typeof output[0] === 'number' ? [output] : output;
  return rows.map((r) => l2normalize(Array.isArray(r[0]) ? meanPool(r) : r));
}

const toPgVector = (v) => `[${v.join(',')}]`;

function articleText(a) {
  return `${a.title || ''}. ${a.summary || ''}`.replace(/\s+/g, ' ').trim().slice(0, NEWS_SEARCH.MAX_TEXT_CHARS);
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'what', 'why', 'how', 'about', 'news', 'any', 'are', 'was', 'did', 'does', 'has', 'have', 'this', 'that', 'from', 'into', 'its', 'say', 'said', 'tell', 'give', 'latest', 'today', 'there']);

/** Query → its content words (lowercase, no stopwords, max 8). Pure. */
function searchTerms(q) {
  const words = String(q || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 8);
}

/** Query → ILIKE patterns for the keyword fallback. Pure. */
function keywordPatterns(q) {
  return searchTerms(q).map((w) => `%${w}%`);
}

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

/**
 * An article's story: its durable event when it has one, else its per-batch cluster, else
 * itself. `id` is what a caller passes to get_story_detail ("e12" = event, "a345" = article).
 */
function storyOf(row) {
  if (row.event_id != null) return { key: `e${row.event_id}`, id: `e${row.event_id}` };
  return { key: row.cluster_key ? `c${row.cluster_key}` : `a${row.id}`, id: `a${row.id}` };
}

/**
 * Reciprocal rank fusion at story level. `lists` = [{ name, rows }] where rows are articles in
 * rank order. Within a list a story takes the rank of its best article and later articles of
 * the same story are skipped, so a much-repeated story can't push others down. A story found
 * by both lists scores higher than one found by either alone. `match` is normalised to 0–1
 * (1 = ranked first by every list). `strength` (0–1) is the best evidence any list had for the
 * story — share of query terms hit, or cosine similarity — because rank alone forgets whether
 * the top result matched everything or just scraped in. Pure.
 */
function fuseStories(lists, k = NEWS_SEARCH.RRF_K) {
  const stories = new Map();
  for (const { name, rows } of lists) {
    const seen = new Set();
    let rank = 0;
    for (const row of rows) {
      const { key, id } = storyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rank++;
      let st = stories.get(key);
      if (!st) stories.set(key, (st = { key, id, lead: row, rrf: 0, strength: 0, matched: [] }));
      st.rrf += 1 / (k + rank);
      st.strength = Math.max(st.strength, row.strength == null ? 1 : clamp01(row.strength));
      st.matched.push(name);
    }
  }
  const best = lists.length / (k + 1);
  return [...stories.values()].map((st) => ({ ...st, match: best > 0 ? st.rrf / best : 0 }));
}

/**
 * Re-rank fused stories for one user:
 *   score = match × strength × (1 + IMPACT·impact + IMPORTANCE·importance) × recency
 * `meta` maps story key → { impact, importance, last_seen } (missing = no boost). Only stories
 * that matched the query are here, so a high-impact story can outrank a better text match but
 * an unrelated one can never appear. Pure.
 */
function rankStories(stories, meta = new Map(), now = Date.now(), W = NEWS_SEARCH.RANK) {
  return stories
    .map((st) => {
      const m = meta.get(st.key) || {};
      const when = new Date(m.last_seen || st.lead.published_at).getTime();
      const ageDays = Number.isFinite(when) ? Math.max(0, (now - when) / 86_400_000) : W.RECENCY_HALF_LIFE_DAYS;
      const recency = 1 - W.RECENCY + W.RECENCY * Math.pow(0.5, ageDays / W.RECENCY_HALF_LIFE_DAYS);
      const boost = 1 + W.IMPACT * clamp01(m.impact) + W.IMPORTANCE * clamp01(m.importance ?? st.lead.importance);
      const strength = 1 - W.STRENGTH + W.STRENGTH * (st.strength ?? 1);
      return { ...st, score: st.match * strength * boost * recency };
    })
    .sort((a, b) => b.score - a.score);
}

// ── Store ──
async function ensureVectorStore() {
  if (storeReady) return true;
  const { queryOne, execute } = require('../db');
  const avail = await queryOne("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
  if (!avail) return false;
  await execute('CREATE EXTENSION IF NOT EXISTS vector');
  // No ANN index: the hard filters cut the candidate set to hundreds of rows, where an exact
  // scan is both fast and exact. Add HNSW only if the corpus outgrows that.
  await execute(`
    CREATE TABLE IF NOT EXISTS article_embeddings (
      article_id BIGINT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
      model      TEXT NOT NULL,
      embedding  vector(${NEWS_SEARCH.DIM}) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  storeReady = true;
  return true;
}

async function embedTexts(texts) {
  const client = getClient();
  const out = [];
  for (let i = 0; i < texts.length; i += NEWS_SEARCH.EMBED_BATCH) {
    const slice = texts.slice(i, i + NEWS_SEARCH.EMBED_BATCH);
    const res = await client.featureExtraction({ model: NEWS_SEARCH.EMBED_MODEL, inputs: slice });
    const vecs = toVectors(res, slice.length);
    if (vecs.length !== slice.length || vecs.some((v) => v.length !== NEWS_SEARCH.DIM)) {
      throw new Error(`unexpected embedding shape from ${NEWS_SEARCH.EMBED_MODEL}`);
    }
    out.push(...vecs);
  }
  return out;
}

/** Pipeline step: embed recent relevant articles that don't have a vector yet. Bounded per run. */
async function embedPendingArticles() {
  if (!embeddingsEnabled()) return { embedded: 0, skipped: 'disabled' };
  if (!(await ensureVectorStore())) return { embedded: 0, skipped: 'no_pgvector' };
  const { query, execute } = require('../db');
  const rows = await query(
    `SELECT a.id, a.title, a.summary
       FROM articles a
       LEFT JOIN article_embeddings e ON e.article_id = a.id AND e.model = $1
      WHERE e.article_id IS NULL AND a.is_relevant
        AND a.published_at > now() - ($2 || ' days')::interval
      ORDER BY a.published_at DESC
      LIMIT $3`,
    [NEWS_SEARCH.EMBED_MODEL, String(NEWS_SEARCH.WINDOW_DAYS), NEWS_SEARCH.MAX_EMBED_PER_RUN]
  );
  if (!rows.length) return { embedded: 0 };
  const vecs = await embedTexts(rows.map(articleText));
  for (let i = 0; i < rows.length; i++) {
    await execute(
      `INSERT INTO article_embeddings (article_id, model, embedding) VALUES ($1, $2, $3::vector)
       ON CONFLICT (article_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, created_at = now()`,
      [rows[i].id, NEWS_SEARCH.EMBED_MODEL, toPgVector(vecs[i])]
    );
  }
  return { embedded: rows.length };
}

// ── Search ──
// Scope filter shared by every mode: a specific ticker, or (no ticker) any allowed ticker
// plus market/world-level stories.
function scopeClause(tickerParam, marketOk) {
  return marketOk
    ? `(s.ticker = ANY(${tickerParam}) OR a.relevance_tier IN ('market','world'))`
    : `s.ticker = ANY(${tickerParam})`;
}

const ARTICLE_COLS = `a.id, a.event_id, a.cluster_key, a.title, a.summary, a.source, a.url, a.published_at, a.importance,
                array_remove(array_agg(DISTINCT s.ticker), NULL) AS tickers`;

// Full-text ranking. Terms are OR-ed so a natural-language question still matches, then
// ranked by ts_rank_cd; multi-word queries must match 2+ terms so one shared common word
// ("demand") isn't returned as relevant — an empty result lets the model honestly say
// nothing was reported. Terms are [a-z0-9] only (searchTerms), so the tsquery text is safe.
async function textCandidates({ terms, tickers, scope, window, limit }) {
  const { query } = require('../db');
  return query(
    `SELECT ${ARTICLE_COLS}, ts_rank_cd(a.search_tsv, to_tsquery('english', $3)) AS rank,
            (SELECT count(*) FROM unnest($4::text[]) t WHERE a.search_tsv @@ to_tsquery('english', t))::float
              / GREATEST(1, (SELECT count(*) FROM unnest($4::text[]) t WHERE numnode(to_tsquery('english', t)) > 0)) AS strength
       FROM articles a
       LEFT JOIN article_sentiments s ON s.article_id = a.id
      WHERE a.is_relevant
        AND a.published_at > now() - ($2 || ' days')::interval
        AND ${scope}
        AND a.search_tsv @@ to_tsquery('english', $3)
      GROUP BY a.id
     HAVING (SELECT count(*) FROM unnest($4::text[]) t WHERE a.search_tsv @@ to_tsquery('english', t))
            >= LEAST(2, (SELECT count(*) FROM unnest($4::text[]) t WHERE numnode(to_tsquery('english', t)) > 0))
      ORDER BY strength DESC, rank DESC, a.importance DESC, a.published_at DESC
      LIMIT $5`,
    [tickers, window, terms.join(' | '), terms, limit]
  );
}

// ILIKE fallback for a database without the full-text column. With no usable terms it
// returns the most important recent stories in scope.
async function keywordCandidates({ q, tickers, scope, window, limit }) {
  const { query } = require('../db');
  const patterns = keywordPatterns(q);
  return query(
    `SELECT ${ARTICLE_COLS},
            (SELECT count(*) FROM unnest($3::text[]) p WHERE (a.title || ' ' || a.summary) ILIKE p) AS hits,
            CASE WHEN cardinality($3::text[]) = 0 THEN 1
                 ELSE (SELECT count(*) FROM unnest($3::text[]) p WHERE (a.title || ' ' || a.summary) ILIKE p)::float / cardinality($3::text[]) END AS strength
       FROM articles a
       LEFT JOIN article_sentiments s ON s.article_id = a.id
      WHERE a.is_relevant
        AND a.published_at > now() - ($2 || ' days')::interval
        AND ${scope}
        AND (cardinality($3::text[]) = 0 OR (a.title || ' ' || a.summary) ILIKE ANY($3::text[]))
      GROUP BY a.id
     HAVING (SELECT count(*) FROM unnest($3::text[]) p WHERE (a.title || ' ' || a.summary) ILIKE p)
            >= LEAST(2, cardinality($3::text[]))
      ORDER BY hits DESC, a.importance DESC, a.published_at DESC
      LIMIT $4`,
    [tickers, window, patterns, limit]
  );
}

async function vectorCandidates({ q, tickers, scope, window, limit }) {
  const { query } = require('../db');
  const [vec] = await embedTexts([String(q).slice(0, NEWS_SEARCH.MAX_TEXT_CHARS)]);
  const rows = await query(
    `SELECT ${ARTICLE_COLS}, 1 - (e.embedding <=> $3::vector) AS similarity
       FROM article_embeddings e
       JOIN articles a ON a.id = e.article_id
       LEFT JOIN article_sentiments s ON s.article_id = a.id
      WHERE e.model = $4 AND a.is_relevant
        AND a.published_at > now() - ($2 || ' days')::interval
        AND ${scope}
      GROUP BY a.id, e.article_id
      ORDER BY e.embedding <=> $3::vector
      LIMIT $5`,
    [tickers, window, toPgVector(vec), NEWS_SEARCH.EMBED_MODEL, limit]
  );
  return rows.filter((r) => Number(r.similarity) >= NEWS_SEARCH.MIN_SIMILARITY).map((r) => ({ ...r, strength: Number(r.similarity) }));
}

// Event fields + this user's impact for the stories that are durable events.
async function loadEventMeta(eventIds, userId) {
  const meta = new Map();
  if (!eventIds.length) return meta;
  const { query } = require('../db');
  const rows = await query(
    `SELECT e.id, e.title, e.url, e.source, e.event_type, e.source_count, e.first_seen, e.last_seen, e.importance,
            i.impact_score, i.exposure_pct, i.direction
       FROM events e
       LEFT JOIN event_portfolio_impact i ON i.event_id = e.id AND i.user_id = $2
      WHERE e.id = ANY($1)`,
    [eventIds, userId ?? null]
  );
  for (const r of rows) {
    meta.set(`e${r.id}`, {
      event: r,
      impact: r.impact_score == null ? null : Number(r.impact_score),
      importance: r.importance == null ? null : Number(r.importance),
      last_seen: r.last_seen,
    });
  }
  return meta;
}

/**
 * Search ingested news and return story cards. `tickers` MUST already be restricted to what
 * the user may see — this function trusts it. `userId` personalises the ranking (optional).
 * Returns { mode: 'hybrid'|'semantic'|'text'|'keyword', results: [card] }.
 */
async function searchNews({ query: q, tickers, userId = null, includeMarket = true, days = NEWS_SEARCH.WINDOW_DAYS, limit = NEWS_SEARCH.TOP_K }) {
  const base = {
    q, tickers,
    scope: scopeClause('$1', includeMarket),
    window: String(Math.min(days, NEWS_SEARCH.WINDOW_DAYS)),
    limit: NEWS_SEARCH.CANDIDATES,
  };
  const terms = searchTerms(q);
  const lists = [];

  if (terms.length) {
    try {
      lists.push({ name: 'text', rows: await textCandidates({ ...base, terms }) });
    } catch (err) {
      // 42703 = undefined column: migration 0020 hasn't run on this database yet.
      if (err.code !== '42703') console.warn('   ⚠️  full-text news search failed, using keyword fallback:', err.message);
    }
  }
  if (!lists.length) lists.push({ name: 'keyword', rows: await keywordCandidates(base) });

  if (embeddingsEnabled() && (await ensureVectorStore().catch(() => false))) {
    try {
      lists.push({ name: 'meaning', rows: await vectorCandidates(base) });
    } catch (err) {
      console.warn('   ⚠️  semantic news search failed, continuing without it:', err.message);
    }
  }

  const names = lists.map((l) => l.name);
  const mode = names.includes('meaning') ? (names.includes('text') ? 'hybrid' : 'semantic') : names[0];
  // A keyword list is only a stand-in for full-text; once the vector list exists it is the
  // weaker signal, but it still catches exact names, so it stays in the fusion.
  const fused = fuseStories(lists);
  const meta = await loadEventMeta(fused.filter((st) => st.lead.event_id != null).map((st) => Number(st.lead.event_id)), userId);
  const ranked = rankStories(fused, meta).slice(0, limit);
  return { mode, results: ranked.map((st) => card(st, meta.get(st.key))) };
}

const clip = (text, n) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const cleanTickers = (ts) => (ts || []).filter((t) => t !== '__MARKET__');

function impactOf(e) {
  if (!e || e.impact_score == null) return undefined;
  return { score: Math.round(Number(e.impact_score) * 1000) / 1000, exposure_pct: Math.round(Number(e.exposure_pct) * 10) / 10, direction: e.direction };
}

// One story as a compact card. Event-backed stories carry the event's title, type, span and
// source count; a story with no durable event is its lead article. No URL here — it is the
// longest field and get_story_detail returns it.
function card(st, m) {
  const a = st.lead;
  const e = m && m.event;
  const out = {
    id: st.id,
    title: clip(e ? e.title : a.title, NEWS_SEARCH.CARD_TITLE_CHARS),
    summary: clip(a.summary, NEWS_SEARCH.CARD_SUMMARY_CHARS),
    source: a.source,
    first_seen: e ? e.first_seen : a.published_at,
    last_seen: e ? e.last_seen : a.published_at,
    sources: e ? Number(e.source_count) : 1,
    tickers: cleanTickers(a.tickers),
    matched: st.matched.join('+'),
  };
  if (e && e.event_type && e.event_type !== 'unknown') out.type = e.event_type;
  const impact = impactOf(e);
  if (impact) out.impact = impact;
  return out;
}

/**
 * Expand one story card into its articles. `id` is a card id ("e12" / "a345"). `tickers` is
 * the caller's allowed set, as in searchNews: a story is visible only if one of its articles
 * touches an allowed ticker or it is market/world news. Returns null when the story doesn't
 * exist or is out of scope — the two are deliberately indistinguishable.
 */
async function getStory({ id, tickers, userId = null }) {
  const m = /^([ea])(\d{1,18})$/.exec(String(id || '').trim().toLowerCase());
  if (!m) return null;
  const { query } = require('../db');
  const where = m[1] === 'e' ? 'a.event_id = $1' : 'a.id = $1';
  const rows = await query(
    `SELECT ${ARTICLE_COLS}, a.relevance_tier
       FROM articles a
       LEFT JOIN article_sentiments s ON s.article_id = a.id
      WHERE ${where} AND a.is_relevant
      GROUP BY a.id
      ORDER BY a.importance DESC, a.published_at DESC
      LIMIT 50`,
    [Number(m[2])]
  );
  const allowed = new Set(tickers);
  const visible = rows.some((r) => ['market', 'world'].includes(r.relevance_tier) || (r.tickers || []).some((t) => allowed.has(t)));
  if (!rows.length || !visible) return null;

  const meta = m[1] === 'e' ? (await loadEventMeta([Number(m[2])], userId)).get(`e${m[2]}`) : null;
  const e = meta && meta.event;
  const times = rows.map((r) => new Date(r.published_at).getTime()).filter(Number.isFinite);
  const out = {
    id: `${m[1]}${m[2]}`,
    title: clip(e ? e.title : rows[0].title, 200),
    first_seen: e ? e.first_seen : new Date(Math.min(...times)),
    last_seen: e ? e.last_seen : new Date(Math.max(...times)),
    sources: e ? Number(e.source_count) : rows.length,
    tickers: cleanTickers([...new Set(rows.flatMap((r) => r.tickers || []))]),
    articles: rows.slice(0, NEWS_SEARCH.DETAIL_ARTICLES).map((r) => ({
      title: clip(r.title, 200),
      summary: clip(r.summary, NEWS_SEARCH.DETAIL_SUMMARY_CHARS),
      source: r.source,
      url: r.url,
      published_at: r.published_at,
    })),
    more_articles: Math.max(0, rows.length - NEWS_SEARCH.DETAIL_ARTICLES),
  };
  if (e && e.event_type && e.event_type !== 'unknown') out.type = e.event_type;
  const impact = impactOf(e);
  if (impact) out.impact = impact;
  return out;
}

module.exports = {
  searchNews, getStory, embedPendingArticles, ensureVectorStore,
  toVectors, searchTerms, keywordPatterns, articleText, storyOf, fuseStories, rankStories,
};
