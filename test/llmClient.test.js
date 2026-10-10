/**
 * Offline tests for the model router client (no network): the request and reply
 * translation between the Anthropic-style calls the app makes and an OpenAI-compatible
 * router, and Ask's real tool loop running through it against a scripted router.
 * Run: node test/llmClient.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';
process.env.AIROUTER_API_KEY = 'sk-air-test';
delete process.env.AIROUTER_MODEL;

const assert = require('assert');
const { toChatRequest, fromChatResponse, routerClient, provider, llmConfigured } = require('../server/services/llmClient');
const { runAgent, toPlainText, SYSTEM_PROMPT } = require('../server/services/qa');
const { findMentionedTickers } = require('../server/services/qaTools');
const { checkGrounding } = require('../server/services/answerCheck');
const { estimateCost } = require('../server/services/reports');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const TOOLS = [{ name: 'get_news', description: 'News for a ticker', input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] } }];

(async () => {
  console.log('llmClient.test.js');

  console.log('request translation:');
  await check('system prompt, model slug, tools and tool choice', () => {
    const body = toChatRequest({
      model: 'claude-haiku-4-5', max_tokens: 500, cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: 'You are an analyst.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS, tool_choice: { type: 'auto' },
    });
    assert.strictEqual(body.model, 'anthropic/claude-haiku-4.5');
    assert.strictEqual(body.max_tokens, 500);
    assert.deepStrictEqual(body.messages, [{ role: 'system', content: 'You are an analyst.' }, { role: 'user', content: 'Hi' }]);
    assert.deepStrictEqual(body.tools, [{ type: 'function', function: { name: 'get_news', description: 'News for a ticker', parameters: TOOLS[0].input_schema } }]);
    assert.strictEqual(body.tool_choice, 'auto');
    assert.ok(!('cache_control' in body) && !('system' in body));
    assert.strictEqual(toChatRequest({ messages: [], tools: TOOLS, tool_choice: { type: 'none' } }).tool_choice, 'none');
    assert.ok(!('tools' in toChatRequest({ system: 's', messages: [{ role: 'user', content: 'x' }] })));
  });
  await check('a tool round: the call, its results, and text sent in the same turn keep their order', () => {
    const body = toChatRequest({
      system: 'S',
      messages: [
        { role: 'user', content: 'News on NVDA?' },
        { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'c1', name: 'get_news', input: { ticker: 'NVDA' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"stories":[]}' }, { type: 'text', text: 'Answer now.' }] },
      ],
    });
    assert.deepStrictEqual(body.messages.slice(2), [
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_news', arguments: '{"ticker":"NVDA"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"stories":[]}' },
      { role: 'user', content: 'Answer now.' },
    ]);
  });

  console.log('reply translation:');
  await check('a text answer: content, stop reason, tokens and the exact charge', () => {
    const r = fromChatResponse({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'NVDA is 20% of your exposure.' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 40, total_cost: 0.0014, prompt_tokens_details: { cached_tokens: 200 } },
    });
    assert.deepStrictEqual(r.content, [{ type: 'text', text: 'NVDA is 20% of your exposure.' }]);
    assert.strictEqual(r.stop_reason, 'end_turn');
    assert.deepStrictEqual(r.usage, { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 40, cost_usd: 0.0014 });
  });
  await check('tool calls become tool_use blocks; bad arguments do not throw; other stops map', () => {
    const r = fromChatResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: 'get_news', arguments: '{"ticker":"TCS"}' } },
      { id: 'b', type: 'function', function: { name: 'get_news', arguments: '{not json' } },
    ] } }] });
    assert.strictEqual(r.stop_reason, 'tool_use');
    assert.deepStrictEqual(r.content, [{ type: 'tool_use', id: 'a', name: 'get_news', input: { ticker: 'TCS' } }, { type: 'tool_use', id: 'b', name: 'get_news', input: {} }]);
    assert.strictEqual(fromChatResponse({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }).stop_reason, 'max_tokens');
    assert.strictEqual(fromChatResponse({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }).stop_reason, 'refusal');
    assert.deepStrictEqual(fromChatResponse({}).content, []);
  });
  await check('the charge the router reports is what gets logged; without one it is estimated', () => {
    assert.strictEqual(estimateCost({ input: 1e6, output: 1e6, cost_usd: 0.0123 }), 0.0123);
    assert.strictEqual(estimateCost({ input: 1e6, output: 1e6, cost_usd: 0 }), 6);
    assert.strictEqual(estimateCost({ input: 1e6, output: 0 }), 1);
  });

  console.log('through the router:');
  await check('the key is sent as a bearer token to /chat/completions; an error status throws', async () => {
    const seen = [];
    const ok = routerClient({ fetchFn: async (url, opts) => { seen.push({ url, opts }); return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] }) }; } });
    await ok.messages.create({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(seen[0].url, 'https://api.airouter.in/v1/chat/completions');
    assert.strictEqual(seen[0].opts.headers.Authorization, 'Bearer sk-air-test');
    const bad = routerClient({ fetchFn: async () => ({ ok: false, status: 402, text: async () => 'insufficient credits' }) });
    await assert.rejects(() => bad.messages.create({ messages: [] }), /402: insufficient credits/);
    assert.strictEqual(provider(), 'router');
    assert.strictEqual(llmConfigured(), true);
  });
  await check("Ask's tool loop runs end to end: the model calls a tool, gets the result, then answers", async () => {
    const bodies = [];
    const replies = [
      { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'echo', arguments: '{"ticker":"NVDA"}' } }] } }], usage: { prompt_tokens: 900, completion_tokens: 20, total_cost: 0.001 } },
      { choices: [{ finish_reason: 'stop', message: { content: 'NVDA had one story today.' } }], usage: { prompt_tokens: 1000, completion_tokens: 15, total_cost: 0.0011 } },
    ];
    const client = routerClient({ fetchFn: async (url, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, json: async () => replies[bodies.length - 1] }; } });
    const setup = {
      system: 'You are an analyst.',
      tools: [{ name: 'echo', description: 'd', input_schema: { type: 'object', properties: { ticker: { type: 'string' } } } }],
      executors: { echo: async (input) => ({ stories: 1, ticker: input.ticker }) },
    };
    const ctx = { userId: 1, holdings: [{ ticker: 'NVDA' }], heldSet: new Set(['NVDA']), drafts: [] };
    const r = await runAgent('News on NVDA?', [], ctx, client, { setup });
    assert.strictEqual(r.answer, 'NVDA had one story today.');
    assert.deepStrictEqual(r.toolsUsed, ['echo']);
    assert.strictEqual(r.rounds, 2);
    assert.strictEqual(r.usage.input, 1900);
    assert.ok(Math.abs(r.usage.cost_usd - 0.0021) < 1e-9);
    // Second request carries the assistant's call and the tool's answer, in OpenAI's shape.
    const second = bodies[1].messages;
    assert.strictEqual(second[second.length - 2].tool_calls[0].function.name, 'echo');
    assert.deepStrictEqual(second[second.length - 1], { role: 'tool', tool_call_id: 't1', content: '{"stories":1,"ticker":"NVDA"}' });
  });

  console.log('answer hygiene:');
  await check('markdown a model adds anyway is removed; words, numbers and paragraphs stay', () => {
    const raw = '## Summary\n\nThe key event is **Bitcoin\'s decline** — z-score `-0.84`.\n\n\n- NVDA is 0.3%\n* AAPL is __0.4%__\n\n**Why it matters**: 2 * 3 = 6.';
    assert.strictEqual(toPlainText(raw), 'Summary\n\nThe key event is Bitcoin\'s decline — z-score -0.84.\n\nNVDA is 0.3%\nAAPL is 0.4%\n\nWhy it matters: 2 * 3 = 6.');
    assert.strictEqual(toPlainText('Plain already.'), 'Plain already.');
    assert.strictEqual(toPlainText(null), '');
  });
  await check('the prompt sets a hard length and forbids markdown', () => {
    assert.ok(/at most 6 sentences/.test(SYSTEM_PROMPT) && /No markdown of any kind/.test(SYSTEM_PROMPT));
    // The rules the 2026-10-11 eval showed were needed: no arithmetic, advice declined first, lists capped.
    assert.ok(/Do no arithmetic of your own/.test(SYSTEM_PROMPT) && /the FIRST sentence says that SenIQ does not give advice or predictions/.test(SYSTEM_PROMPT) && /give at most five/.test(SYSTEM_PROMPT));
  });
  await check('an everyday word is not a ticker: "near-term" is not NEAR, "the cost" is not COST', () => {
    const universe = [{ ticker: 'NEAR', name: 'NEAR Protocol' }, { ticker: 'COST', name: 'Costco' }, { ticker: 'NVDA', name: 'Nvidia' }, { ticker: 'LINK', name: 'Chainlink' }];
    assert.deepStrictEqual(findMentionedTickers('The most important near-term event raises the cost of capital; see the link.', universe), []);
    assert.deepStrictEqual(findMentionedTickers('Near-term, Cost matters.', universe), []);
    assert.deepStrictEqual(findMentionedTickers('NEAR fell while $COST rose; nvda and Costco were flat.', universe).sort(), ['COST', 'NEAR', 'NVDA']);
    const audit = checkGrounding('The most important near-term event is for NVDA.', ['NVDA exposure 20%'], { findTickers: (t) => findMentionedTickers(t, universe) });
    assert.deepStrictEqual(audit.unsupported.filter((u) => u.type === 'ticker'), []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
