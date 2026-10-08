/**
 * Offline tests for the FinBERT classifier's own logic: turning the model's three
 * probabilities into a reading, lining results up with texts, and what happens when the
 * model fails. The model itself is never loaded here — a stand-in returns probabilities.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';
process.env.FINBERT_CLASSIFY = '1';

const assert = require('node:assert');
const F = require('../server/services/finbertClassifier');
const { FINBERT } = require('../server/config');
const { analyzeSentiment } = require('../server/services/sentiment');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));
const probs = (positive, neutral, negative) => [{ label: 'neutral', score: neutral }, { label: 'positive', score: positive }, { label: 'negative', score: negative }];

section('probabilities → a reading:');
check('a clear positive, a clear negative, a clear neutral', () => {
  assert.deepStrictEqual(F.fromProbabilities(probs(0.92, 0.07, 0.01)), { label: 'positive', score: 0.96, confidence: 0.92, model: 'finbert' });
  assert.deepStrictEqual(F.fromProbabilities(probs(0.02, 0.08, 0.90)), { label: 'negative', score: 0.06, confidence: 0.9, model: 'finbert' });
  assert.deepStrictEqual(F.fromProbabilities(probs(0.03, 0.95, 0.02)), { label: 'neutral', score: 0.51, confidence: 0.95, model: 'finbert' });
});
check('a text the model is torn on lands near the middle, not at an extreme', () => {
  const r = F.fromProbabilities(probs(0.45, 0.15, 0.40)); // "positive" is the top label, barely
  assert.strictEqual(r.label, 'neutral');
  assert.ok(Math.abs(r.score - 0.5) < 0.05);
  const lean = F.fromProbabilities(probs(0.55, 0.40, 0.05));
  assert.deepStrictEqual([lean.label, lean.score], ['positive', 0.75]);
});
check('the label follows the score on the word list\'s bands', () => {
  assert.strictEqual(F.fromProbabilities(probs(0.30, 0.60, 0.10)).label, 'positive');  // score 0.60
  assert.strictEqual(F.fromProbabilities(probs(0.29, 0.61, 0.11)).label, 'neutral');   // score 0.59
  assert.strictEqual(F.fromProbabilities(probs(0.10, 0.60, 0.30)).label, 'negative');  // score 0.40
  assert.deepStrictEqual(FINBERT.BANDS, { POSITIVE: 0.6, NEGATIVE: 0.4 });
});
check('upper-case labels, missing labels and junk are handled', () => {
  assert.strictEqual(F.fromProbabilities([{ label: 'POSITIVE', score: 0.9 }]).label, 'positive');
  assert.deepStrictEqual(F.fromProbabilities([]), { label: 'neutral', score: 0.5, confidence: 0, model: 'finbert' });
  assert.deepStrictEqual(F.fromProbabilities(null), { label: 'neutral', score: 0.5, confidence: 0, model: 'finbert' });
  assert.strictEqual(F.fromProbabilities([{ label: 'weird', score: 1 }]).score, 0.5);
});
check('the story that started this: one stray word no longer decides it', () => {
  const text = 'Apple Reportedly Partners With LG Electronics To Enter Smart Home Device Market Apple Inc. has reportedly partnered with LG Electronics Inc. to co-develop a range of smart home accessories, aiming to revitalize its HomeKit ecosystem and challenge rivals Amazon and Google.';
  const words = analyzeSentiment(text);
  assert.deepStrictEqual([words.label, words.score], ['negative', 0]);          // the word list: "challenge" → the bottom of the scale
  // What the local model returned for this text on 2026-10-08:
  assert.deepStrictEqual(F.fromProbabilities(probs(0.9187, 0.0717, 0.0096)), { label: 'positive', score: 0.95, confidence: 0.92, model: 'finbert' });
});

section('classifying a batch:');
const T0 = 1_000_000_000_000;
check('one reading per text, in order; long texts are cut before the model sees them', async () => {
  F.resetForTests();
  let seen = null;
  const runFn = async (texts) => { seen = texts; return texts.map((t) => (t.startsWith('good') ? probs(0.9, 0.05, 0.05) : probs(0.05, 0.05, 0.9))); };
  const out = await F.classifyBatch(['good news', 'bad news', `good ${'x'.repeat(5000)}`], { runFn, now: T0 });
  assert.deepStrictEqual(out.map((r) => r.label), ['positive', 'negative', 'positive']);
  assert.ok(seen[2].length <= FINBERT.MAX_CHARS);
  assert.deepStrictEqual(await F.classifyBatch([], { runFn, now: T0 }), []);
});
check('a failure hands the run to the word list and rests the model; it is tried again later', async () => {
  F.resetForTests();
  let calls = 0;
  const down = async () => { calls++; throw new Error('model unavailable'); };
  const up = async (texts) => { calls++; return texts.map(() => probs(0.9, 0.05, 0.05)); };
  assert.strictEqual(await F.classifyBatch(['a'], { runFn: down, now: T0 }), null);
  assert.strictEqual(await F.classifyBatch(['a'], { runFn: up, now: T0 + 60 * 1000 }), null); // still resting — not even called
  assert.strictEqual(calls, 1);
  const later = await F.classifyBatch(['a'], { runFn: up, now: T0 + FINBERT.RETRY_MINUTES * 60 * 1000 });
  assert.strictEqual(later[0].label, 'positive');
  assert.strictEqual(calls, 2);
});
check('a reply with the wrong number of results is treated as a failure, not misaligned', async () => {
  F.resetForTests();
  assert.strictEqual(await F.classifyBatch(['a', 'b'], { runFn: async () => [probs(0.9, 0.05, 0.05)], now: T0 }), null);
  F.resetForTests();
});
check('the company-aware model is asked "<company> | <text>" and is off unless a folder is set', async () => {
  const sent = [];
  const out = await F.classifyTargets([{ entity: 'Kotak Bank', text: 'Kotak Bank rose 3%' }], { runFn: async (t) => { sent.push(...t); return [probs(0.9, 0.05, 0.05)]; } });
  assert.deepStrictEqual(sent, ['Kotak Bank | Kotak Bank rose 3%']);
  assert.deepStrictEqual(out, [{ label: 'positive', score: 0.93, confidence: 0.9, model: 'finbert-target' }]);
  assert.strictEqual(await F.classifyTargets([{ entity: 'A', text: 'b' }], { runFn: async () => { throw new Error('missing'); } }), null);
  assert.strictEqual(F.targetEnabled(), false);
  assert.strictEqual(await F.classifyTargets([{ entity: 'A', text: 'b' }]), null);
});
check('local is the default mode and needs no token', () => {
  assert.strictEqual(FINBERT.MODE, 'local');
  assert.strictEqual(F.isEnabled(), true);
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} FinBERT checks passed`);
})();
