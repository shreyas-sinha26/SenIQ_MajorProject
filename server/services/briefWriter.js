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
 * Grounding, not model choice, is what makes the brief non-generic: every claim rests on
 * something we pass in, and the prompt forbids invented facts and investment advice.
 *
 * Claude is shown the packet through packetForWriter(): events in rank order with the share
 * of the portfolio they touch, and sentiment in words. The engine's own scores (impact
 * score, sentiment score, z-score) are left out, because a brief that could see them quoted
 * them ("a 0.173-impact event", "z-score +0.27") and no reader knows what those mean.
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
  // Several funds moving on one stock are several rows: name each stock once.
  const uniq = (rows) => [...new Set(rows.map((r) => r.ticker))].join(', ');
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (sm.congress && sm.congress.length) smBits.push(`${count(sm.congress.length, 'recent congressional trade', 'recent congressional trades')} in your names`);
  if (sm.institutions && sm.institutions.length) smBits.push(`institutional moves on ${uniq(sm.institutions)}`);
  if (sm.india_deals && sm.india_deals.length) smBits.push(`${count(sm.india_deals.length, 'bulk or block deal', 'bulk or block deals')} on ${uniq(sm.india_deals)}`);
  if (sm.india_insiders && sm.india_insiders.length) smBits.push(`${sm.india_insiders.length === 1 ? 'an insider trade' : 'insider trades'} disclosed on ${uniq(sm.india_insiders)}`);
  if (smBits.length) lines.push(`Smart money: ${smBits.join('; ')}.`);

  return lines.join(' ');
}

function deterministicBrief(packet) {
  return { writer: 'deterministic', model: null, headline: deterministicHeadline(packet), narrative: deterministicNarrative(packet), usage: { input: 0, output: 0 } };
}

// ── Claude writer ──
const SYSTEM_PROMPT = `You are SenIQ's personal market analyst. You write a short daily brief for one investor about THEIR portfolio.

Rules:
- Ground every statement in the JSON packet (the events, the share of the portfolio each one touches, the sentiment wording, the smart-money facts). Never invent events, prices, or figures not in the packet.
- Lead with what CHANGED since yesterday (the packet's "changed" block) and the single most important event for this portfolio ("most_important").
- Be specific and personal: reference the user's actual holdings and how much of their exposure an event touches.
- Write for a reader who has never seen how SenIQ scores things. Events are listed most important first: say "the story that matters most for you today", never a score. Give sentiment in the packet's own words ("negative", "above its usual level"). The only figures to quote are the percent of the portfolio a story touches, counts, and amounts or dates the packet states.
- Informational only — never give buy/sell/hold advice or price targets.
- Output plain text in exactly two parts:
  HEADLINE: <a headline, not a sentence: 12 words at most, no full stop>
  Then a 120–200 word brief in 1–2 short paragraphs.
- No preamble, no markdown headers, no bullet lists. Just the HEADLINE line followed by the prose.`;

// How far a holding's sentiment sits from its own 90-day normal, in words.
function vsUsual(z) {
  if (z == null || !Number.isFinite(Number(z))) return null;
  const v = Number(z);
  if (v >= 1.5) return 'well above its usual level';
  if (v >= 0.5) return 'above its usual level';
  if (v > -0.5) return 'near its usual level';
  if (v > -1.5) return 'below its usual level';
  return 'well below its usual level';
}

/**
 * The packet as the writer sees it: the same facts, without the engine's scores. Events keep
 * their order (rank 1 = most important) and their share of the portfolio; a holding's
 * sentiment is its label and how that compares with its own normal. Pure.
 */
function packetForWriter(packet) {
  const p = packet || {};
  const event = (e, i) => ({
    rank: i + 1, title: e.title, exposure_pct: e.exposure_pct, direction: e.direction,
    source: e.source || undefined, date: e.last_seen ? new Date(e.last_seen).toISOString().slice(0, 10) : undefined,
  });
  const events = (p.top_events || []).map(event);
  const ch = p.changed || {};
  const swing = (s) => {
    const moved = s.from_acute != null && s.to_acute != null && s.from_acute !== s.to_acute
      ? (s.to_acute > s.from_acute ? 'more positive than yesterday' : 'more negative than yesterday') : undefined;
    return { ticker: s.ticker, from: s.from_label, to: s.to_label, moved };
  };
  return {
    date: p.date,
    portfolio: {
      holdings_count: p.portfolio ? p.portfolio.holdings_count : 0,
      top_holdings: ((p.portfolio && p.portfolio.top_holdings) || []).map((h) => ({
        ticker: h.ticker, name: h.name, sector: h.sector, exposure_pct: h.exposure_pct,
        sentiment: h.sentiment_label, sentiment_vs_usual: vsUsual(h.z) || undefined,
      })),
    },
    top_events: events,
    most_important: events[0] || null,
    smart_money: p.smart_money || {},
    changed: {
      has_prior: !!ch.has_prior,
      new_events: (ch.new_events || []).map((e) => ({ title: e.title, exposure_pct: e.exposure_pct, direction: e.direction })),
      dropped_events: (ch.dropped_events || []).map((e) => ({ title: e.title })),
      rank_changes: (ch.rank_changes || []).map((r) => ({ title: r.title, from_rank: r.from_rank, to_rank: r.to_rank })),
      sentiment_swings: (ch.sentiment_swings || []).map(swing),
    },
  };
}

function buildUserContent(packet) {
  // The packet is already trimmed + clamped by grounding.js; pass the writer's view as JSON.
  return `Here is today's grounding packet for this user. Write the brief.\n\n${JSON.stringify(packetForWriter(packet), null, 2)}`;
}

// A headline is a headline: a model asked for one sometimes returns a full sentence that runs
// to three lines above the brief. Longer than HEADLINE_MAX_WORDS → keep the first clause when
// it stands on its own, else the first HEADLINE_MAX_WORDS words, not ending on a word that
// only leads to the next one ("…touches 41.8% of"). A closing full stop goes. Pure.
const HEADLINE_MAX_WORDS = 14;
const DANGLING = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'as', 'and', 'or', 'but', 'with', 'by', 'from', 'that', 'which', 'while', 'your', 'its', 'their', 'is', 'are']);
function tidyHeadline(text) {
  const h = String(text || '').replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '').replace(/\.$/, '').trim();
  const words = (t) => t.split(' ').filter(Boolean);
  if (words(h).length <= HEADLINE_MAX_WORDS) return h;
  const clause = h.split(/\s[—–-]\s|[;:]\s|,\s(?=(?:and|but|as|while|with|after|which)\b)/)[0].trim();
  if (clause !== h && words(clause).length >= 3 && words(clause).length <= HEADLINE_MAX_WORDS) return clause;
  const kept = words(h).slice(0, HEADLINE_MAX_WORDS);
  while (kept.length > 3 && DANGLING.has(kept[kept.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) kept.pop();
  return `${kept.join(' ').replace(/[,;:—–-]+$/, '').trim()}…`;
}

function parseClaudeOutput(text) {
  const trimmed = (text || '').trim();
  const m = trimmed.match(/^\s*HEADLINE:\s*(.+?)\s*(?:\n|$)/i);
  if (m) {
    const headline = tidyHeadline(m[1]);
    const narrative = trimmed.slice(m[0].length).trim();
    return { headline, narrative: narrative || headline };
  }
  // No HEADLINE marker — use the first sentence as the headline.
  const firstStop = trimmed.search(/[.!?]\s/);
  const headline = tidyHeadline(firstStop > 0 ? trimmed.slice(0, firstStop + 1) : trimmed.slice(0, 140));
  return { headline, narrative: trimmed };
}

async function claudeBrief(packet) {
  const client = require('./llmClient').getClient(); // Anthropic directly, or the router
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
    usage: { input: resp.usage.input_tokens || 0, output: resp.usage.output_tokens || 0, cost_usd: resp.usage.cost_usd || 0 },
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

module.exports = { writeBrief, deterministicBrief, deterministicHeadline, deterministicNarrative, parseClaudeOutput, packetForWriter, tidyHeadline, SYSTEM_PROMPT, DISCLAIMER };
