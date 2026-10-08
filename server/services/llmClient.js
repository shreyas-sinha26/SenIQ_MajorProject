/**
 * Where the analyst voice (daily brief, Ask, Pro alert narrative) sends its model calls.
 *
 * The callers are written against Anthropic's Messages API. Two ways to reach Claude:
 *   Anthropic directly  — ANTHROPIC_API_KEY (the Anthropic SDK, unchanged).
 *   An OpenAI-compatible router — AIROUTER_API_KEY. Routers such as AIRouter expose only
 *     /chat/completions, so routerClient() below presents the same messages.create() the
 *     callers already use and translates each request and reply (system prompt, tool
 *     definitions, tool calls and results, stop reason, token usage). The router key wins
 *     when both are set.
 * Either way CLAUDE_REPORTS=1 is still needed, and every guardrail in reports.js / qa.js
 * (per-user quota, global $/day ceiling, token caps) applies unchanged.
 */

const { LLM } = require('../config');

function provider() {
  if (LLM.ROUTER.API_KEY) return 'router';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

// True when a model key is present (the guardrails' "hasKey").
function llmConfigured() {
  return provider() !== null;
}

// ── Pure: Anthropic request → OpenAI chat/completions body ──
function toChatRequest({ model, max_tokens, system, messages, tools, tool_choice }) {
  const out = [];
  const systemText = Array.isArray(system) ? system.map((b) => b.text || '').join('\n') : (system || '');
  if (systemText) out.push({ role: 'system', content: systemText });

  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (m.role === 'assistant') {
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      // Tool results answer the assistant's calls first; any text in the same turn follows.
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }

  const body = { model: LLM.ROUTER.MODEL || model, max_tokens, messages: out };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    body.tool_choice = tool_choice && tool_choice.type === 'none' ? 'none' : 'auto';
  }
  return body;
}

const STOP_REASON = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

// ── Pure: OpenAI chat/completions reply → Anthropic message ──
function fromChatResponse(data) {
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content.trim()) content.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse((call.function && call.function.arguments) || '{}'); } catch { /* malformed arguments → the tool reports what is missing */ }
    content.push({ type: 'tool_use', id: call.id, name: call.function && call.function.name, input });
  }
  const u = data.usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    model: data.model || null,
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : (STOP_REASON[choice.finish_reason] || choice.finish_reason || 'end_turn'),
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
      cache_read_input_tokens: cached,
      output_tokens: u.completion_tokens || 0,
      // The router bills this request at exactly this amount; preferred over our own estimate.
      cost_usd: typeof u.total_cost === 'number' ? u.total_cost : (Number(u.total_cost) || 0),
    },
  };
}

function routerClient({ fetchFn = fetch } = {}) {
  return {
    messages: {
      async create(request) {
        const res = await fetchFn(`${LLM.ROUTER.BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${LLM.ROUTER.API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(toChatRequest(request)),
          signal: AbortSignal.timeout(LLM.ROUTER.TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`model router answered ${res.status}: ${detail.slice(0, 200)}`);
        }
        return fromChatResponse(await res.json());
      },
    },
  };
}

// The client the analyst voice calls: messages.create(request) → Anthropic-shaped reply.
function getClient() {
  if (provider() === 'router') return routerClient();
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic(); // reads ANTHROPIC_API_KEY from env
}

module.exports = { getClient, llmConfigured, provider, routerClient, toChatRequest, fromChatResponse };
