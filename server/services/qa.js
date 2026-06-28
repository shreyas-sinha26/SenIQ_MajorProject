/**
 * Ask it anything (Engine Phase E6) — natural-language portfolio Q&A.
 *
 * A user asks in plain English ("why is my portfolio down?", "what's my biggest risk?")
 * and Claude (Haiku) answers grounded STRICTLY on that user's engine data — never outside
 * knowledge — citing the numbers (exposure %, impact, sentiment, z-score). Single-shot:
 * each question is answered fresh against the current grounding context, no chat history.
 *
 * Cost guardrails (Q&A is the on-demand "loopable button" risk the user is firm about):
 *   - hard per-user DAILY question cap, checked BEFORE any Claude call (count of today's
 *     claude_calls with kind='qa') — repeated asks past the cap fall back to the free path.
 *   - shares REPORTS' global $/day kill-switch + per-call cost logging.
 *   - question clamped, output token-capped, FEATURES.CLAUDE_REPORTS gates the Claude path.
 * With no key / flag off / over cap, the answer degrades to a deterministic grounded data
 * summary — no NL reasoning, but it still cites the relevant numbers.
 */

const { QA, REPORTS, FEATURES } = require('../config');
const { buildQAContext } = require('./grounding');
const { guardCheck, estimateCost } = require('./reports');

// ── Pure helpers ──
function sanitizeQuestion(raw) {
  const q = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!q) return '';
  return q.length > QA.MAX_QUESTION_CHARS ? q.slice(0, QA.MAX_QUESTION_CHARS) : q;
}

const DIR_WORD = { positive: 'positive', negative: 'negative', neutral: 'mixed' };

/**
 * Best-effort grounded answer with no LLM — a data digest assembled from the context.
 * Pure. Addresses the common intents (risk / down / improving) by ranking holdings, and
 * always leads with the most important event. Clearly not a reasoned answer; cites numbers.
 */
function deterministicAnswer(question, ctx) {
  const holdings = (ctx.portfolio && ctx.portfolio.holdings) || [];
  if (!holdings.length) return "I don't have any holdings on file for you yet — add a few and ask again.";

  const q = (question || '').toLowerCase();
  const byExposure = holdings.slice().sort((a, b) => (b.exposure_pct ?? 0) - (a.exposure_pct ?? 0));
  const negatives = holdings.filter((h) => h.sentiment_label === 'negative').sort((a, b) => (b.exposure_pct ?? 0) - (a.exposure_pct ?? 0));
  const positives = holdings.filter((h) => h.sentiment_label === 'positive').sort((a, b) => (b.exposure_pct ?? 0) - (a.exposure_pct ?? 0));

  const lines = [];
  const m = ctx.most_important;
  if (m) lines.push(`Most important right now: "${m.title}" — ${m.exposure_pct}% of your exposure, ${DIR_WORD[m.direction] || 'mixed'} (impact ${m.impact_score}).`);

  if (/risk|exposed|exposure|worried|safe/.test(q)) {
    const risk = negatives.length ? negatives : byExposure;
    lines.push(`Highest-exposure names carrying negative sentiment: ${risk.slice(0, 3).map((h) => `${h.ticker} (${h.exposure_pct}%, ${h.sentiment_label})`).join(', ')}.`);
  } else if (/down|drop|fall|lower|red|losing|bad/.test(q)) {
    lines.push(negatives.length
      ? `Negative sentiment is concentrated in: ${negatives.slice(0, 3).map((h) => `${h.ticker} (${h.exposure_pct}%)`).join(', ')}.`
      : 'No holding currently reads negative on sentiment — any move is likely broad/market-driven.');
  } else if (/improv|up|better|gain|positive|winning|good|recover/.test(q)) {
    lines.push(positives.length
      ? `Improving (positive sentiment): ${positives.slice(0, 3).map((h) => `${h.ticker} (${h.exposure_pct}%)`).join(', ')}.`
      : 'Nothing reads clearly positive on sentiment right now.');
  } else {
    lines.push(`Your largest exposures: ${byExposure.slice(0, 4).map((h) => `${h.ticker} (${h.exposure_pct}%, ${h.sentiment_label})`).join(', ')}.`);
  }

  lines.push('(Auto-generated from your data — turn on the AI writer for a fuller answer.)');
  return lines.join(' ');
}

// ── Claude path ──
const SYSTEM_PROMPT = `You are SenIQ's portfolio analyst answering one investor's question about THEIR portfolio.

Rules:
- Answer ONLY from the JSON context provided (their holdings, impact events, sentiment, smart-money). Use no outside knowledge and invent no facts, prices, or events.
- Cite the numbers that support your answer (exposure %, impact score, sentiment label/score, z-score, smart-money facts).
- If the context doesn't contain what's needed to answer, say so plainly rather than guessing.
- Informational only — never give buy/sell/hold advice or price targets.
- Be concise: 2–5 sentences, plain text, no markdown headers or bullet lists.`;

async function askClaude(question, ctx) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: QA.MODEL,
    max_tokens: QA.MAX_OUTPUT_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Question: ${question}\n\nContext (this user's data):\n${JSON.stringify(ctx, null, 2)}` }],
  });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { answer: text, usage: { input: resp.usage.input_tokens || 0, output: resp.usage.output_tokens || 0 } };
}

/**
 * Answer a user's question. Returns { answer, writer, quota:{used,limit,remaining} }.
 */
async function answerQuestion(userId, rawQuestion) {
  const { queryOne, execute } = require('../db');
  const question = sanitizeQuestion(rawQuestion);
  if (!question) return { error: 'empty_question' };

  const ctx = await buildQAContext(userId);

  // ── Guardrails ──
  const dayStart = `${new Date().toISOString().slice(0, 10)} 00:00:00+00`;
  const askedRow = await queryOne(
    "SELECT count(*) c FROM claude_calls WHERE user_id = $1 AND kind = 'qa' AND created_at >= $2",
    [userId, dayStart]
  );
  const spendRow = await queryOne('SELECT COALESCE(sum(cost_usd),0) s FROM claude_calls WHERE created_at >= $1', [dayStart]);
  const used = Number(askedRow.c);
  const guard = guardCheck({
    flagOn: FEATURES.CLAUDE_REPORTS,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    userCallsToday: used,
    quota: QA.PER_USER_DAILY_QUESTIONS,
    globalSpendToday: Number(spendRow.s),
    ceiling: REPORTS.GLOBAL_DAILY_USD_CEILING,
  });

  let answer, writer;
  if (guard.allow) {
    try {
      const r = await askClaude(question, ctx);
      answer = r.answer;
      writer = 'claude';
      const cost = estimateCost(r.usage);
      await execute(
        "INSERT INTO claude_calls (user_id, kind, model, input_tokens, output_tokens, cost_usd) VALUES ($1, 'qa', $2, $3, $4, $5)",
        [userId, QA.MODEL, r.usage.input, r.usage.output, cost]
      );
    } catch (err) {
      console.error('QA Claude call failed, falling back:', err.message);
      answer = deterministicAnswer(question, ctx);
      writer = 'deterministic';
    }
  } else {
    answer = deterministicAnswer(question, ctx);
    writer = 'deterministic';
  }

  const usedAfter = writer === 'claude' ? used + 1 : used;
  return {
    question,
    answer,
    writer,
    guard: guard.reason,
    quota: { used: usedAfter, limit: QA.PER_USER_DAILY_QUESTIONS, remaining: Math.max(0, QA.PER_USER_DAILY_QUESTIONS - usedAfter) },
  };
}

module.exports = { answerQuestion, sanitizeQuestion, deterministicAnswer };
