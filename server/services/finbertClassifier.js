/**
 * FinBERT classifier (Phase 2d) — local, CPU, batch.
 *
 * Per the model split: classification is high-volume and must be deterministic +
 * free, so it runs as a local transformer in the cron pass (NOT via an LLM API).
 * FinBERT is slow on CPU but fine for batch. The lexicon (sentiment.js) stays the
 * low-latency path for the live UI + instant alerts.
 *
 * Opt-in via FEATURES.FINBERT_CLASSIFY (env FINBERT_CLASSIFY=1) because the model
 * weights download (~250MB) on first use. If the model can't load for any reason,
 * isReady() reports false and callers fall back to the lexicon — never a hard fail.
 *
 * Output matches the lexicon classifier: { label, score (0-1, 0.5=neutral), confidence }.
 */

const { FEATURES, INGEST } = require('../config');

let pipePromise = null;
let loadFailed = false;

async function getPipeline() {
  if (loadFailed) return null;
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = require('@huggingface/transformers');
      env.allowLocalModels = false; // pull the ONNX weights from the HF hub
      return pipeline('text-classification', 'Xenova/finbert');
    })().catch((err) => {
      loadFailed = true;
      console.warn('   ⚠️  FinBERT unavailable, falling back to lexicon:', err.message);
      return null;
    });
  }
  return pipePromise;
}

// FinBERT label + probability → the shared 0-1 sentiment scale.
function toScore(label, prob) {
  const l = String(label).toLowerCase();
  if (l === 'positive') return { label: 'positive', score: 0.5 + 0.5 * prob, confidence: prob };
  if (l === 'negative') return { label: 'negative', score: 0.5 - 0.5 * prob, confidence: prob };
  return { label: 'neutral', score: 0.5, confidence: prob };
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * Classify many texts. Returns an array aligned to `texts`, or null if FinBERT
 * isn't available (caller should fall back to the lexicon).
 */
async function classifyBatch(texts) {
  if (!FEATURES.FINBERT_CLASSIFY) return null;
  const pipe = await getPipeline();
  if (!pipe) return null;

  const inputs = texts.map((t) => String(t || '').slice(0, INGEST.MAX_TEXT_CHARS));
  const out = [];
  const CHUNK = 16; // keep CPU + memory bounded on large fetches
  try {
    for (let i = 0; i < inputs.length; i += CHUNK) {
      const slice = inputs.slice(i, i + CHUNK);
      const res = await pipe(slice, { truncation: true });
      const arr = Array.isArray(res) ? res : [res];
      for (const r of arr) {
        const top = Array.isArray(r) ? r[0] : r; // top-1 label
        const { label, score, confidence } = toScore(top.label, top.score);
        out.push({ label, score: round(score), confidence: round(confidence), model: 'finbert' });
      }
    }
    return out;
  } catch (err) {
    console.warn('   ⚠️  FinBERT classification error, falling back to lexicon:', err.message);
    loadFailed = true;
    return null;
  }
}

function isEnabled() {
  return FEATURES.FINBERT_CLASSIFY && !loadFailed;
}

module.exports = { classifyBatch, isEnabled };
