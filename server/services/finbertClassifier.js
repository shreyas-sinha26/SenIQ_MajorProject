/**
 * FinBERT classifier — via Hugging Face Inference API.
 *
 * Uses ProsusAI/finbert on the HF Inference API instead of loading the model
 * locally, reducing memory from ~250MB to near zero.
 *
 * Requires HF_API_TOKEN (free at huggingface.co → Settings → Access Tokens).
 * If the token is absent or the API is down, falls back to the lexicon — never a hard fail.
 *
 * Output matches the lexicon classifier: { label, score (0-1, 0.5=neutral), confidence }.
 */

const { FEATURES, INGEST } = require('../config');

const HF_API_URL = 'https://api-inference.huggingface.co/models/ProsusAI/finbert';

let loadFailed = false;

// FinBERT label + probability → the shared 0-1 sentiment scale.
function toScore(label, prob) {
  const l = String(label).toLowerCase();
  if (l === 'positive') return { label: 'positive', score: 0.5 + 0.5 * prob, confidence: prob };
  if (l === 'negative') return { label: 'negative', score: 0.5 - 0.5 * prob, confidence: prob };
  return { label: 'neutral', score: 0.5, confidence: prob };
}

const round = (n) => Math.round(n * 100) / 100;

async function callInferenceAPI(inputs, retried = false) {
  const token = process.env.HF_API_TOKEN;
  if (!token) throw new Error('HF_API_TOKEN not set');

  const res = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs }),
  });

  if (res.status === 503 && !retried) {
    // Model is cold-starting — wait the suggested time and retry once.
    const body = await res.json().catch(() => ({}));
    const wait = Math.min((body.estimated_time || 20) * 1000, 30_000);
    await new Promise((r) => setTimeout(r, wait));
    return callInferenceAPI(inputs, true);
  }

  if (!res.ok) {
    throw new Error(`HF API ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

/**
 * Classify many texts. Returns an array aligned to `texts`, or null if FinBERT
 * isn't available (caller falls back to the lexicon).
 */
async function classifyBatch(texts) {
  if (!FEATURES.FINBERT_CLASSIFY) return null;
  if (loadFailed) return null;
  if (!process.env.HF_API_TOKEN) return null;

  const inputs = texts.map((t) => String(t || '').slice(0, INGEST.MAX_TEXT_CHARS));
  const out = [];
  const CHUNK = 8; // keep individual API requests reasonable

  try {
    for (let i = 0; i < inputs.length; i += CHUNK) {
      const slice = inputs.slice(i, i + CHUNK);
      const res = await callInferenceAPI(slice);
      // Batch response: [[{label, score}, ...], ...] — one inner array per input.
      // Single-item edge-case: API may return [{label, score}, ...] — wrap it.
      const rows = Array.isArray(res[0]) ? res : [res];
      for (const row of rows) {
        const top = row[0]; // results are sorted by score desc; [0] is top-1
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
