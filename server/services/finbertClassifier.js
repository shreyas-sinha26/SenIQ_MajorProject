/**
 * FinBERT classifier — via Hugging Face Inference API.
 *
 * Uses ProsusAI/finbert on the HF Serverless Inference API instead of loading
 * the model locally, reducing memory from ~250MB to near zero.
 *
 * Requires HF_API_TOKEN (free at huggingface.co → Settings → Access Tokens).
 * Falls back to the lexicon classifier if the API is unavailable — never a hard fail.
 *
 * Output matches the lexicon classifier: { label, score (0-1, 0.5=neutral), confidence }.
 */

const { FEATURES, INGEST } = require('../config');

let hf = null;
let loadFailed = false;

function getClient() {
  if (!hf && process.env.HF_API_TOKEN) {
    const { HfInference } = require('@huggingface/inference');
    hf = new HfInference(process.env.HF_API_TOKEN);
  }
  return hf;
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
 * isn't available (caller falls back to the lexicon).
 */
async function classifyBatch(texts) {
  if (!FEATURES.FINBERT_CLASSIFY) return null;
  if (loadFailed) return null;
  const client = getClient();
  if (!client) return null;

  const inputs = texts.map((t) => String(t || '').slice(0, INGEST.MAX_TEXT_CHARS));
  const out = [];
  const CHUNK = 8;

  try {
    for (let i = 0; i < inputs.length; i += CHUNK) {
      const slice = inputs.slice(i, i + CHUNK);
      // textClassification returns [{label, score}] for single or an array of those for batch.
      const res = await client.textClassification({
        model: 'ProsusAI/finbert',
        inputs: slice,
      });
      // Normalise: single input → wrap in array; batch → already array of arrays.
      const rows = Array.isArray(res[0]) ? res : [res];
      for (const row of rows) {
        const top = Array.isArray(row) ? row[0] : row;
        const { label, score, confidence } = toScore(top.label, top.score);
        out.push({ label, score: round(score), confidence: round(confidence), model: 'finbert' });
      }
    }
    return out;
  } catch (err) {
    console.warn('   ⚠️  FinBERT API error, falling back to lexicon:', err.message);
    loadFailed = true;
    return null;
  }
}

function isEnabled() {
  return FEATURES.FINBERT_CLASSIFY && !loadFailed && !!process.env.HF_API_TOKEN;
}

module.exports = { classifyBatch, isEnabled };
