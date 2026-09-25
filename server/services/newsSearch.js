/**
 * News search — the retrieval ("RAG") half of Ask. Everything else Ask knows comes from
 * exact tool queries over engine tables; this is the one place we search free text.
 *
 * Corpus = what the pipeline already ingests: headline + summary of RELEVANT articles from
 * the last NEWS_SEARCH.WINDOW_DAYS (no full-article scraping). Each article is embedded once
 * via the HF Inference API (same HF_API_TOKEN as FinBERT) and stored in pgvector.
 *
 * Retrieval is HYBRID: hard filters first (the caller's allowed tickers + date window), then
 * rank by cosine similarity. Same-story duplicates are collapsed by cluster_key.
 *
 * Degrades, never fails: no pgvector / no token / flag off / HF error → keyword matching over
 * the same filtered set (mode:'keyword'), so Ask still works on a fresh local DB.
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

/** Query → ILIKE patterns for the keyword fallback. Pure. */
function keywordPatterns(q) {
  const words = String(q || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 8).map((w) => `%${w}%`);
}

/** Keep the best-ranked article per story (cluster_key). Pure. */
function dedupeByCluster(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = r.cluster_key || `a${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
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
// Scope filter shared by both modes: a specific ticker, or (no ticker) any allowed ticker
// plus market/world-level stories.
function scopeClause(tickerParam, marketOk) {
  return marketOk
    ? `(s.ticker = ANY(${tickerParam}) OR a.relevance_tier IN ('market','world'))`
    : `s.ticker = ANY(${tickerParam})`;
}

/**
 * Search ingested news. `tickers` MUST already be restricted to what the user may see —
 * this function trusts it. Returns { mode, results:[{title, summary, source, url, published_at, tickers, similarity?}] }.
 */
async function searchNews({ query: q, tickers, includeMarket = true, days = NEWS_SEARCH.WINDOW_DAYS, limit = NEWS_SEARCH.TOP_K }) {
  const { query } = require('../db');
  const window = String(Math.min(days, NEWS_SEARCH.WINDOW_DAYS));
  const scope = scopeClause('$1', includeMarket);

  if (embeddingsEnabled() && (await ensureVectorStore().catch(() => false))) {
    try {
      const [vec] = await embedTexts([String(q).slice(0, NEWS_SEARCH.MAX_TEXT_CHARS)]);
      const rows = await query(
        `SELECT a.id, a.cluster_key, a.title, a.summary, a.source, a.url, a.published_at,
                array_remove(array_agg(DISTINCT s.ticker), NULL) AS tickers,
                1 - (e.embedding <=> $2::vector) AS similarity
           FROM article_embeddings e
           JOIN articles a ON a.id = e.article_id
           LEFT JOIN article_sentiments s ON s.article_id = a.id
          WHERE e.model = $3 AND a.is_relevant
            AND a.published_at > now() - ($4 || ' days')::interval
            AND ${scope}
          GROUP BY a.id, e.article_id
          ORDER BY e.embedding <=> $2::vector
          LIMIT $5`,
        [tickers, toPgVector(vec), NEWS_SEARCH.EMBED_MODEL, window, limit * 3]
      );
      const relevant = rows.filter((r) => Number(r.similarity) >= NEWS_SEARCH.MIN_SIMILARITY);
      return { mode: 'semantic', results: dedupeByCluster(relevant, limit).map(shape) };
    } catch (err) {
      console.warn('   ⚠️  semantic news search failed, using keyword fallback:', err.message);
    }
  }

  // Keyword fallback: rank by how many query words an article matches, and require 2+ matches
  // for multi-word queries, so one shared common word ("demand") isn't returned as relevant —
  // an empty result lets the model honestly say nothing was reported.
  const patterns = keywordPatterns(q);
  const rows = await query(
    `SELECT a.id, a.cluster_key, a.title, a.summary, a.source, a.url, a.published_at,
            array_remove(array_agg(DISTINCT s.ticker), NULL) AS tickers,
            (SELECT count(*) FROM unnest($3::text[]) p WHERE (a.title || ' ' || a.summary) ILIKE p) AS hits
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
    [tickers, window, patterns, limit * 3]
  );
  return { mode: 'keyword', results: dedupeByCluster(rows, limit).map(shape) };
}

function shape(r) {
  const out = {
    title: r.title,
    summary: (r.summary || '').slice(0, 400),
    source: r.source,
    url: r.url,
    published_at: r.published_at,
    tickers: (r.tickers || []).filter((t) => t !== '__MARKET__'),
  };
  if (r.similarity != null) out.similarity = Math.round(Number(r.similarity) * 1000) / 1000;
  return out;
}

module.exports = { searchNews, embedPendingArticles, ensureVectorStore, toVectors, keywordPatterns, dedupeByCluster, articleText };
