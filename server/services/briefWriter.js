/**
 * The analyst voice (Engine Phase E5) — turns a grounding packet into a readable daily
 * brief. Three writers, in order of preference:
 *
 *   claude        — Claude (Haiku by default) writes the prose. Grounded strictly in the
 *                   packet, led by "what changed since yesterday" + the most important
 *                   event. Static system prompt is prompt-cached; output is token-capped.
 *   deterministic — a template assembled from the same packet (pure, always available).
 *
 * The caller (reports.js) owns the cost guardrails and decides whether Claude is allowed
 * for this run; briefWriter just writes, and falls back to the template on any Claude
 * error so a brief always ships.
 *
 * Grounding, not model choice, is what makes the brief non-generic: every claim cites a
 * number we pass in (impact score, exposure %, z-score, sentiment), and the prompt forbids
 * invented facts and investment advice.
 */

const { REPORTS, DISCLAIMER } = require('../config');

const DIR_WORD = { positive: 'positive', negative: 'negative', neutral: 'mixed' };

// ── Deterministic template (pure) ──
function deterministicHeadline(packet) {
  const m = packet.most_important;
  if (!m) return 'A quiet day across your holdings — nothing material to flag.';
  const dir = DIR_WORD[m.direction] || 'mixed';
  return `${m.title} — ${m.exposure_pct}% of your exposure, ${dir}.`;
}

function deterministicNarrative(packet) {
  const lines = [];
  const ch = packet.changed || {};
  const m = packet.most_important;

  if (m) {
    lines.push(`Today's most important event for your portfolio is "${m.title}" — it touches ${m.exposure_pct}% of your exposure and reads ${DIR_WORD[m.direction] || 'mixed'} (impact ${m.impact_score}).`);
  } else {
    lines.push('No event cleared the materiality bar for your holdings today.');
  }

  if (ch.has_prior) {
    if (ch.new_events && ch.new_events.length) {
      lines.push(`New since yesterday: ${ch.new_events.slice(0, 3).map((e) => `"${e.title}" (${e.exposure_pct}% exposure)`).join('; ')}.`);
    }
    if (ch.sentiment_swings && ch.sentiment_swings.length) {
      lines.push(`Sentiment shifted on ${ch.sentiment_swings.slice(0, 3).map((s) => `${s.ticker} (${s.from_label}→${s.to_label})`).join(', ')}.`);
    }
    if ((!ch.new_events || !ch.new_events.length) && (!ch.sentiment_swings || !ch.sentiment_swings.length)) {
      lines.push('Little changed since yesterday across your holdings.');
    }
  } else {
    lines.push('This is your first brief, so there is no prior day to compare against yet.');
  }

  const others = (packet.top_events || []).slice(1, 4);
  if (others.length) {
    lines.push(`Also on the radar: ${others.map((e) => `"${e.title}" (${e.exposure_pct}%)`).join('; ')}.`);
  }

  const sm = packet.smart_money || {};
  const smBits = [];
  if (sm.congress && sm.congress.length) smBits.push(`${sm.congress.length} recent congressional trade(s) in your names`);
  if (sm.institutions && sm.institutions.length) smBits.push(`institutional moves on ${sm.institutions.map((i) => i.ticker).join(', ')}`);
  if (smBits.length) lines.push(`Smart money: ${smBits.join('; ')}.`);

  return lines.join(' ');
}

function deterministicBrief(packet) {
  return { writer: 'deterministic', model: null, headline: deterministicHeadline(packet), narrative: deterministicNarrative(packet), usage: { input: 0, output: 0 } };
}

// ── Claude writer ──
const SYSTEM_PROMPT = `You are SenIQ's personal market analyst. You write a short daily brief for one investor about THEIR portfolio.

Rules:
- Ground every statement in the numbers provided in the JSON packet (impact score, exposure %, z-score, sentiment label/score, smart-money facts). Never invent events, prices, or figures not in the packet.
- Lead with what CHANGED since yesterday (the packet's "changed" block) and the single most important event for this portfolio ("most_important").
- Be specific and personal: reference the user's actual holdings and how much of their exposure an event touches.
- Informational only — never give buy/sell/hold advice or price targets.
- Output plain text in exactly two parts:
  HEADLINE: <one punchy sentence — the single most important thing today>
  Then a 120–200 word brief in 1–2 short paragraphs.
- No preamble, no markdown headers, no bullet lists. Just the HEADLINE line followed by the prose.`;

function buildUserContent(packet) {
  // The packet is already trimmed + clamped by grounding.js; pass it as JSON context.
  return `Here is today's grounding packet for this user. Write the brief.\n\n${JSON.stringify(packet, null, 2)}`;
}

function parseClaudeOutput(text) {
  const trimmed = (text || '').trim();
  const m = trimmed.match(/^\s*HEADLINE:\s*(.+?)\s*(?:\n|$)/i);
  if (m) {
    const headline = m[1].trim();
    const narrative = trimmed.slice(m[0].length).trim();
    return { headline, narrative: narrative || headline };
  }
  // No HEADLINE marker — use the first sentence as the headline.
  const firstStop = trimmed.search(/[.!?]\s/);
  const headline = firstStop > 0 ? trimmed.slice(0, firstStop + 1).trim() : trimmed.slice(0, 140);
  return { headline, narrative: trimmed };
}

async function claudeBrief(packet) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const resp = await client.messages.create({
    model: REPORTS.MODEL,
    max_tokens: REPORTS.MAX_OUTPUT_TOKENS,
    system: [
      // Static prefix → prompt-cached so repeated daily runs only pay the cache-read rate.
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: buildUserContent(packet) }],
  });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const { headline, narrative } = parseClaudeOutput(text);
  return {
    writer: 'claude',
    model: REPORTS.MODEL,
    headline,
    narrative,
    usage: { input: resp.usage.input_tokens || 0, output: resp.usage.output_tokens || 0 },
  };
}

/**
 * Write a brief for a packet. `allowClaude` is the caller's guardrail decision (flag +
 * key + quota + kill-switch all passed). On any Claude error, fall back to the template.
 */
async function writeBrief(packet, { allowClaude = false } = {}) {
  if (allowClaude) {
    try {
      return await claudeBrief(packet);
    } catch (err) {
      console.error('Claude brief failed, falling back to template:', err.message);
    }
  }
  return deterministicBrief(packet);
}

module.exports = { writeBrief, deterministicBrief, deterministicHeadline, deterministicNarrative, parseClaudeOutput, SYSTEM_PROMPT, DISCLAIMER };
