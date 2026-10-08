/**
 * FinBERT classifier — a finance-trained language model that reads the whole text.
 *
 * The word list (sentiment.js) scores a story by counting words, so one ambiguous word
 * decides it: "…to challenge rivals Amazon and Google" read as the most negative score
 * there is, because "challenge" was the only match. FinBERT reads the sentence.
 *
 * Two ways to run it (FINBERT.MODE):
 *   local  — the model runs in this process (transformers.js, the Xenova/finbert ONNX build
 *            of ProsusAI/finbert). Downloaded once (~110 MB), then no network, no token, no
 *            usage limit. A few hundred MB of memory while loaded. The default.
 *   hosted — Hugging Face's Inference API (needs HF_API_TOKEN). For a server too small to
 *            hold the model; the free allowance is tiny, so it is not the default.
 *
 * On by FEATURES.FINBERT_CLASSIFY. If the model cannot be loaded or a call fails, the
 * caller falls back to the word list for that run; the model is tried again after
 * FINBERT.RETRY_MINUTES — never a hard fail, and never a silent switch for good.
 *
 * Output matches the word list's: { label, score (0–1, 0.5 = neutral), confidence, model }.
 */

const { FEATURES, FINBERT, INGEST } = require('../config');

const round = (n) => Math.round(n * 100) / 100;

/**
 * Pure: the model's three probabilities → our reading.
 * probs = [{ label: 'positive'|'neutral'|'negative', score: probability }, …] in any order.
 * score      = 0.5 + half the gap between positive and negative, so a text the model is
 *              torn on lands near the middle instead of at an extreme.
 * label      = from the score, on the same bands the word list uses (FINBERT.BANDS).
 * confidence = the probability of the model's top label.
 */
function fromProbabilities(probs) {
  const p = { positive: 0, neutral: 0, negative: 0 };
  for (const r of probs || []) {
    const l = String(r.label || '').toLowerCase();
    if (l in p) p[l] = Number(r.score) || 0;
  }
  const score = Math.min(1, Math.max(0, 0.5 + 0.5 * (p.positive - p.negative)));
  const label = score >= FINBERT.BANDS.POSITIVE ? 'positive' : score <= FINBERT.BANDS.NEGATIVE ? 'negative' : 'neutral';
  return { label, score: round(score), confidence: round(Math.max(p.positive, p.neutral, p.negative)), model: 'finbert' };
}

// ── The two runners. Each takes texts and returns one list of probabilities per text. ──
let localPipeline = null;
async function runLocal(texts) {
  if (!localPipeline) {
    const { pipeline } = await import('@huggingface/transformers'); // ESM-only package
    localPipeline = await pipeline('text-classification', FINBERT.LOCAL_MODEL, { dtype: FINBERT.LOCAL_DTYPE });
  }
  const out = [];
  for (let i = 0; i < texts.length; i += FINBERT.BATCH) {
    const res = await localPipeline(texts.slice(i, i + FINBERT.BATCH), { top_k: null });
    out.push(...res);
  }
  return out;
}

let hostedClient = null;
async function runHosted(texts) {
  if (!process.env.HF_API_TOKEN) throw new Error('HF_API_TOKEN is not set');
  if (!hostedClient) {
    const { HfInference } = require('@huggingface/inference');
    hostedClient = new HfInference(process.env.HF_API_TOKEN);
  }
  const out = [];
  for (const text of texts) {
    // One text per call: the reply is that text's list of { label, score }.
    const res = await hostedClient.textClassification({ model: FINBERT.HOSTED_MODEL, inputs: text });
    out.push(Array.isArray(res[0]) ? res[0] : res);
  }
  return out;
}

// ── The company-aware model (optional): the same kind of model, loaded from a folder ──
let targetPipeline = null;
async function runTarget(texts) {
  if (!targetPipeline) {
    const path = require('path');
    const { pipeline, env } = await import('@huggingface/transformers');
    const dir = path.resolve(FINBERT.TARGET_MODEL);
    env.localModelPath = path.dirname(dir) + path.sep; // a folder on disk is looked up by its name under this
    targetPipeline = await pipeline('text-classification', path.basename(dir), { dtype: FINBERT.LOCAL_DTYPE, local_files_only: true });
  }
  const out = [];
  for (let i = 0; i < texts.length; i += FINBERT.BATCH) {
    out.push(...await targetPipeline(texts.slice(i, i + FINBERT.BATCH), { top_k: null }));
  }
  return out;
}

// Whether the company-aware model is configured and on disk.
function targetEnabled() {
  return FEATURES.FINBERT_CLASSIFY && !!FINBERT.TARGET_MODEL && require('fs').existsSync(FINBERT.TARGET_MODEL);
}

/**
 * Read each text for one company. items = [{ entity, text }], entity being the company as
 * the text names it. Returns readings aligned to `items`, or null when the model is not
 * set up or fails (the caller falls back to FinBERT). deps for tests: { runFn }.
 */
async function classifyTargets(items, deps = {}) {
  if (!deps.runFn && !targetEnabled()) return null;
  if (!items || !items.length) return [];
  const inputs = items.map((it) => `${it.entity}${FINBERT.TARGET_SEP}${String(it.text || '')}`.slice(0, FINBERT.MAX_CHARS));
  try {
    const rows = await (deps.runFn || runTarget)(inputs);
    if (!Array.isArray(rows) || rows.length !== inputs.length) throw new Error(`expected ${inputs.length} results, got ${rows && rows.length}`);
    return rows.map((r) => ({ ...fromProbabilities(r), model: 'finbert-target' }));
  } catch (err) {
    console.warn(`   ⚠️  Company-aware model failed — FinBERT reads this run instead: ${err.message}`);
    return null;
  }
}

// After a failure the model is left alone until this time, then tried again.
let retryAt = 0;
let warned = false;

/**
 * Classify many texts. Returns an array aligned to `texts`, or null when FinBERT is off or
 * unavailable right now (the caller uses the word list). deps for tests: { runFn, now }.
 */
async function classifyBatch(texts, deps = {}) {
  if (!FEATURES.FINBERT_CLASSIFY) return null;
  const now = deps.now != null ? deps.now : Date.now();
  if (now < retryAt) return null;
  if (!texts || !texts.length) return [];
  const runFn = deps.runFn || (FINBERT.MODE === 'hosted' ? runHosted : runLocal);
  // The model reads at most 512 tokens; a headline and summary rarely come near it.
  const inputs = texts.map((t) => String(t || '').slice(0, Math.min(INGEST.MAX_TEXT_CHARS, FINBERT.MAX_CHARS)));
  try {
    const rows = await runFn(inputs);
    if (!Array.isArray(rows) || rows.length !== inputs.length) throw new Error(`expected ${inputs.length} results, got ${rows && rows.length}`);
    if (warned) { console.log('   ✅ FinBERT is back; using it again.'); warned = false; }
    return rows.map(fromProbabilities);
  } catch (err) {
    retryAt = now + FINBERT.RETRY_MINUTES * 60 * 1000;
    warned = true;
    console.warn(`   ⚠️  FinBERT (${FINBERT.MODE}) failed — using the word list for now, retrying in ${FINBERT.RETRY_MINUTES} min: ${err.message}`);
    return null;
  }
}

// Whether FinBERT is switched on (it may still be resting after a failure).
function isEnabled() {
  return FEATURES.FINBERT_CLASSIFY && (FINBERT.MODE !== 'hosted' || !!process.env.HF_API_TOKEN);
}

// For tests: forget a failure.
function resetForTests() { retryAt = 0; warned = false; }

module.exports = { classifyBatch, classifyTargets, targetEnabled, isEnabled, fromProbabilities, resetForTests };
