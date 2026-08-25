/**
 * Pro alert narrative (Phase 9) — a short, grounded explanation attached to a Pro user's
 * instant alert email. Same analyst voice + guardrails as the daily brief (E5) and Q&A
 * (E6); this does NOT introduce a new Claude wrapper or a new fallback order:
 *
 *   Claude (Haiku)  → guardrailed by reports.guardCheck (flag + key + per-user daily quota
 *                     + global $/day kill-switch), cost logged to claude_calls
 *                     (kind='alert_narrative') via reports.estimateCost.
 *   Ollama (local)  → reuses ollamaExplainer.generate when Claude is unavailable/denied.
 *   Template        → deterministic, pure, always available; cites the alert's numbers.
 *
 * Everything is grounded in the alert facts we already computed in the materiality engine
 * (exposure %, sentiment, impact/materiality, source count) — no outside knowledge,
 * informational only, never buy/sell/hold advice.
 */

const { ALERT_NARRATIVE, REPORTS, FEATURES } = require('../config');
const { guardCheck, estimateCost } = require('./reports');

// ── Pure helpers ──
function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

const DIR_WORD = { positive: 'positive', negative: 'negative', neutral: 'mixed' };

// Normalise a materiality-engine alert (enriched in generateAlerts) into narrative facts.
function buildFacts(alert = {}) {
  const isMarket = !alert.ticker || alert.ticker === 'MARKET';
  const direction = alert.direction || alert.sentiment_label || alert.label || 'neutral';
  return {
    headline: alert.title || alert.headline || alert.message || 'Portfolio event',
    ticker: alert.ticker || 'MARKET',
    isMarket,
    direction,
    sentimentScore: alert.score != null ? Number(alert.score) : (alert.sentiment_score != null ? Number(alert.sentiment_score) : null),
    exposurePct: alert.exposure_pct != null ? Number(alert.exposure_pct) : null,
    impactScore: alert.priority != null ? Number(alert.priority) : (alert.impact_score != null ? Number(alert.impact_score) : null),
    sourceCount: Number(alert.source_count || alert.sourceCount || 1),
    alertType: alert.alert_type || 'holding',
  };
}

// Qualitative confidence from corroboration (sources) + sentiment extremity — grounded,
// never a precision claim. Returns 'high' | 'moderate' | 'low'.
function confidenceLabel(facts) {
  const extremity = facts.sentimentScore != null ? Math.abs(facts.sentimentScore - 0.5) * 2 : 0;
  const sources = facts.sourceCount || 1;
  const s = Math.min(1, extremity * 0.6 + Math.min(sources, 5) / 5 * 0.4);
  if (s >= 0.66) return 'high';
  if (s >= 0.33) return 'moderate';
  return 'low';
}

function shortTermImpact(direction) {
  if (direction === 'negative') return 'near-term downward pressure is possible if the theme persists';
  if (direction === 'positive') return 'a near-term tailwind is possible if the theme persists';
  return 'limited clear directional impact is expected in the near term';
}

function pctStr(n) {
  return n == null ? null : `${Math.round(n)}%`;
}

/**
 * Deterministic template narrative — pure, always available. Weaves in all seven required
 * elements (what happened, why it matters, holdings affected, exposure, expected short-term
 * impact, confidence, key risks) grounded in the alert's own numbers.
 */
function deterministicNarrative(factsOrAlert) {
  const f = factsOrAlert && factsOrAlert.headline && factsOrAlert.ticker !== undefined && 'isMarket' in factsOrAlert
    ? factsOrAlert
    : buildFacts(factsOrAlert);
  const dir = DIR_WORD[f.direction] || 'mixed';
  const who = f.isMarket ? 'the broad market' : f.ticker;
  const exposure = pctStr(f.exposurePct);
  const sent = f.sentimentScore != null ? Math.round(f.sentimentScore * 100) : null;
  const conf = confidenceLabel(f);
  const src = f.sourceCount > 1 ? `${f.sourceCount} sources` : 'a single source';

  const parts = [];
  // What happened
  parts.push(`What happened: ${f.headline} — a ${dir} development affecting ${who}, reported by ${src}.`);
  // Why it matters + holdings + exposure
  if (f.isMarket) {
    parts.push(`Why it matters: this is a market/world event that can move your portfolio broadly rather than through a single name.`);
  } else {
    parts.push(`Why it matters: ${f.ticker} is one of your holdings${exposure ? `, carrying ${exposure} of your portfolio exposure` : ''}, so ${dir} news here feeds directly into your positioning.`);
  }
  // Affected holdings + exposure (explicit)
  parts.push(`Affected holdings: ${f.isMarket ? 'your portfolio broadly' : f.ticker}${exposure ? ` (${exposure} exposure)` : ''}.`);
  // Sentiment / impact numbers
  const nums = [];
  if (sent != null) nums.push(`sentiment reads ${sent}/100 (${dir})`);
  if (f.impactScore != null) nums.push(`materiality/impact score ${Math.round(f.impactScore * 100) / 100}`);
  if (nums.length) parts.push(`The signal: ${nums.join(', ')}.`);
  // Expected short-term impact
  parts.push(`Expected short-term impact: ${shortTermImpact(f.direction)}.`);
  // Confidence
  parts.push(`Confidence: ${conf}, based on ${src} and the strength of the sentiment reading.`);
  // Key risks
  parts.push(`Key risks: sentiment can reverse quickly and headline coverage may overstate a one-off; treat this as one input, not a signal to act. Informational only — not investment advice.`);

  return parts.join(' ');
}

function templateResult(facts) {
  return { writer: 'template', model: null, narrative: deterministicNarrative(facts), usage: { input: 0, output: 0 } };
}

// ── Claude tier (same call shape as qa.askClaude — not a new abstraction) ──
const SYSTEM_PROMPT = `You are SenIQ's personal market analyst writing a SHORT alert explanation for one investor about a single event affecting THEIR portfolio.

Rules:
- Ground every statement in the numbers provided (affected ticker, exposure %, sentiment score, impact/materiality score, source count). Never invent events, prices, or figures.
- Informational only — never give buy/sell/hold advice or price targets.
- Write ${ALERT_NARRATIVE.MIN_WORDS}–${ALERT_NARRATIVE.MAX_WORDS} words of plain text (no markdown, no bullet characters), covering, in order: what happened; why it matters; which holdings are affected; portfolio exposure; expected short-term impact; your confidence; key risks.`;

async function claudeNarrative(facts) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const resp = await client.messages.create({
    model: ALERT_NARRATIVE.MODEL,
    max_tokens: ALERT_NARRATIVE.MAX_OUTPUT_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Alert facts for this user:\n${JSON.stringify(facts, null, 2)}\n\nWrite the alert explanation.` }],
  });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('Claude returned empty narrative');
  return { writer: 'claude', model: ALERT_NARRATIVE.MODEL, narrative: text, usage: { input: resp.usage.input_tokens || 0, output: resp.usage.output_tokens || 0 } };
}

// ── Ollama tier (reuses ollamaExplainer.generate) ──
async function ollamaNarrative(facts) {
  const { generate, OLLAMA_MODEL } = require('./ollamaExplainer');
  const prompt = `You are a concise financial analyst. Using ONLY these facts, write ${ALERT_NARRATIVE.MIN_WORDS}-${ALERT_NARRATIVE.MAX_WORDS} words of plain text covering: what happened, why it matters, which holdings are affected, portfolio exposure, expected short-term impact, confidence, and key risks. Informational only, no buy/sell advice, do not invent numbers.\n\nFacts:\n${JSON.stringify(facts)}`;
  const text = await generate(prompt, { numPredict: ALERT_NARRATIVE.MAX_OUTPUT_TOKENS });
  if (!text) throw new Error('Ollama returned empty narrative');
  return { writer: 'ollama', model: OLLAMA_MODEL, narrative: text, usage: { input: 0, output: 0 } };
}

/**
 * Write a narrative with the Claude → Ollama → template hierarchy. Pure control flow with
 * injectable tiers (claudeFn/ollamaFn) so the fallback order is unit-testable offline.
 * `allowClaude` is the caller's guardrail decision. Any tier error falls through to the
 * next; the template never fails.
 */
async function writeAlertNarrative(facts, { allowClaude = false, claudeFn = claudeNarrative, ollamaFn = ollamaNarrative } = {}) {
  if (allowClaude && claudeFn) {
    try {
      return await claudeFn(facts);
    } catch (err) {
      console.error('Alert narrative: Claude failed, trying Ollama —', err.message);
    }
  }
  if (ollamaFn) {
    try {
      return await ollamaFn(facts);
    } catch (err) {
      console.error('Alert narrative: Ollama failed, using template —', err.message);
    }
  }
  return templateResult(facts);
}

/**
 * Guardrailed entry used by the notifier for Pro users. Mirrors qa.answerQuestion:
 * count today's alert_narrative Claude calls for this user, apply guardCheck, then write
 * with the reusable hierarchy and log the cost if Claude actually ran.
 */
async function generateProNarrative(userId, alert) {
  const { queryOne, execute } = require('../db');
  const facts = buildFacts(alert);

  const dayStart = `${new Date().toISOString().slice(0, 10)} 00:00:00+00`;
  const madeRow = await queryOne(
    "SELECT count(*) c FROM claude_calls WHERE user_id = $1 AND kind = 'alert_narrative' AND created_at >= $2",
    [userId, dayStart]
  );
  const spendRow = await queryOne('SELECT COALESCE(sum(cost_usd),0) s FROM claude_calls WHERE created_at >= $1', [dayStart]);
  const guard = guardCheck({
    flagOn: FEATURES.CLAUDE_REPORTS,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    userCallsToday: Number(madeRow.c),
    quota: ALERT_NARRATIVE.PER_USER_DAILY_QUOTA,
    globalSpendToday: Number(spendRow.s),
    ceiling: REPORTS.GLOBAL_DAILY_USD_CEILING,
  });

  const result = await writeAlertNarrative(facts, { allowClaude: guard.allow });

  if (result.writer === 'claude') {
    const cost = estimateCost(result.usage);
    await execute(
      "INSERT INTO claude_calls (user_id, kind, model, input_tokens, output_tokens, cost_usd) VALUES ($1, 'alert_narrative', $2, $3, $4, $5)",
      [userId, result.model, result.usage.input, result.usage.output, cost]
    );
  }
  return { ...result, guard: guard.reason };
}

module.exports = {
  buildFacts,
  deterministicNarrative,
  writeAlertNarrative,
  generateProNarrative,
  confidenceLabel,
  wordCount,
  SYSTEM_PROMPT,
};
