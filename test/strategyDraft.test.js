/**
 * Offline tests for plain-English → strategy draft: the app-side spec validator, the fixed
 * data-depth notes, the draft_strategy tool (stand-in engine) and the agent's fix-and-retry
 * loop (scripted fake model). No DB, no engine, no model.
 */

const assert = require('node:assert');
const { validateSpec, dataDepthNotes, INDICATORS, SENIQ_METRICS } = require('../server/services/strategySpec');
const ST = require('../server/services/strategyTools');
const { PRESETS_DOC, instantiatePreset } = require('../server/services/strategySignals');
const { runTool } = require('../server/services/qaTools');
const { runAgent, agentSetup } = require('../server/services/qa');
const { checkGrounding } = require('../server/services/answerCheck');
const { QA } = require('../server/config');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

const GOOD = {
  name: 'EMA cross with sentiment',
  factors: [
    { id: 'ema_f', fn: 'ema', params: { period: 20 } },
    { id: 'ema_s', fn: 'ema', params: { period: 50 } },
    { id: 'sz', source: 'seniq', metric: 'sentiment_zscore' },
  ],
  entry: { all: [{ crossover: ['ema_f', 'ema_s'] }, { gt: ['sz', 0] }] },
  exit: { any: [{ crossunder: ['ema_f', 'ema_s'] }, { stop_loss_pct: 8 }] },
};
const vary = (over) => ({ ...JSON.parse(JSON.stringify(GOOD)), ...over });
const errs = (spec) => validateSpec(spec).errors.join(' | ');

section('spec validator (mirror of the engine):');
check('a good spec passes and comes back cleaned, with default sizing', () => {
  const v = validateSpec({ ...GOOD, junk: 1, factors: GOOD.factors.map((f) => ({ ...f, extra: true })) });
  assert.strictEqual(v.valid, true);
  assert.deepStrictEqual(Object.keys(v.spec), ['name', 'factors', 'entry', 'exit', 'sizing']);
  assert.deepStrictEqual(v.spec.sizing, { type: 'percent_equity', value: 25 });
  assert.deepStrictEqual(v.spec.factors[0], { id: 'ema_f', source: 'technical', fn: 'ema', params: { period: 20 } });
  assert.deepStrictEqual(v.spec.exit, GOOD.exit); // risk exits stay in the tree for the Builder
});
check('every shipped SenIQ preset passes', () => {
  for (const p of PRESETS_DOC.presets) assert.deepStrictEqual(validateSpec(instantiatePreset(p.id, { politician: 'Jane Doe' }).spec).errors, [], p.id);
});
check('vocabulary: unknown indicator, parameter, metric and operator are named in the error', () => {
  assert.ok(/unknown fn "bollinger"/.test(errs(vary({ factors: [{ id: 'ema_f', fn: 'bollinger' }, GOOD.factors[1], GOOD.factors[2]] }))));
  assert.ok(/ema has no parameter "length"/.test(errs(vary({ factors: [{ id: 'ema_f', fn: 'ema', params: { length: 20 } }, GOOD.factors[1], GOOD.factors[2]] }))));
  assert.ok(/unknown SenIQ metric "vibes"/.test(errs(vary({ factors: [GOOD.factors[0], GOOD.factors[1], { id: 'sz', source: 'seniq', metric: 'vibes' }] }))));
  assert.ok(/unknown operator "equals"/.test(errs(vary({ entry: { all: [{ equals: ['ema_f', 'ema_s'] }] } }))));
  assert.ok(/unknown factor id "rsi14"/.test(errs(vary({ entry: { all: [{ lt: ['rsi14', 70] }, { crossover: ['ema_f', 'ema_s'] }, { gt: ['sz', 0] }] } }))));
});
check('ranges and structure', () => {
  assert.ok(/period must be a whole number 1\.\.500/.test(errs(vary({ factors: [{ id: 'ema_f', fn: 'ema', params: { period: 0 } }, GOOD.factors[1], GOOD.factors[2]] }))));
  assert.ok(/fast must be smaller than slow/.test(errs({ ...GOOD, factors: [{ id: 'm', fn: 'macd', params: { fast: 30, slow: 12 } }], entry: { all: [{ gt: ['m', 0] }] }, exit: { any: [{ lt: ['m', 0] }] } })));
  assert.ok(/window_days must be/.test(errs(vary({ factors: [GOOD.factors[0], GOOD.factors[1], { id: 'sz', source: 'seniq', metric: 'congress_buys', params: { window_days: 0 } }] }))));
  assert.ok(/only valid inside exit/.test(errs(vary({ entry: { all: [{ crossover: ['ema_f', 'ema_s'] }, { gt: ['sz', 0] }, { stop_loss_pct: 5 }] } }))));
  assert.ok(/left side must be a factor/.test(errs(vary({ entry: { all: [{ crossover: [10, 'ema_s'] }, { gt: ['sz', 0] }, { gt: ['ema_f', 0] }] } }))));
  assert.ok(/entry: at least one/.test(errs(vary({ entry: undefined }))));
  assert.ok(/exit: needs at least one/.test(errs(vary({ exit: undefined }))));
  assert.ok(/percent_equity must be/.test(errs(vary({ sizing: { type: 'percent_equity', value: 150 } }))));
  assert.ok(/unused factor\(s\): sz/.test(errs(vary({ entry: { all: [{ crossover: ['ema_f', 'ema_s'] }] } }))));
  assert.ok(/reserved/.test(errs(vary({ factors: [{ id: 'close', fn: 'ema', params: { period: 5 } }, GOOD.factors[1], GOOD.factors[2]] }))));
  assert.deepStrictEqual(validateSpec('buy low sell high').errors, ['spec must be an object']);
});
check('limits: factors, conditions, nesting', () => {
  const many = Array.from({ length: 13 }, (_, i) => ({ id: `f${i}`, fn: 'sma', params: { period: 5 + i } }));
  assert.ok(/too many factors/.test(errs({ name: 'x', factors: many, entry: { all: [{ gt: ['f0', 'f1'] }] }, exit: { any: [{ stop_loss_pct: 5 }] } })));
  const conds = Array.from({ length: 21 }, () => ({ gt: ['ema_f', 'ema_s'] }));
  assert.ok(/too many conditions/.test(errs(vary({ entry: { all: [...conds, { gt: ['sz', 0] }] } }))));
  let deep = { gt: ['ema_f', 'ema_s'] };
  for (let i = 0; i < 9; i++) deep = { all: [deep] };
  assert.ok(/nested too deeply/.test(errs(vary({ entry: deep }))));
});
check('the vocabulary the agent is told matches the validator', () => {
  for (const fn of Object.keys(INDICATORS)) assert.ok(ST.DRAFT_GRAMMAR.includes(`${fn}(`), fn);
  for (const m of SENIQ_METRICS) assert.ok(ST.DRAFT_GRAMMAR.includes(m), m);
});

section('data-depth notes (written in code, not by the model):');
check('one fixed note per SenIQ signal family used; none for price-only specs', () => {
  assert.strictEqual(dataDepthNotes(validateSpec(GOOD).spec).length, 1);
  assert.ok(/weeks, not years/.test(dataDepthNotes(validateSpec(GOOD).spec)[0]));
  const all = validateSpec(instantiatePreset('fund-accumulation').spec).spec;
  assert.ok(/13F/.test(dataDepthNotes(all)[0]));
  const cong = validateSpec(instantiatePreset('follow-a-politician', { politician: 'A B' }).spec).spec;
  assert.ok(/2026 only/.test(dataDepthNotes(cong)[0]));
  const priceOnly = { ...GOOD, factors: GOOD.factors.slice(0, 2), entry: { all: [{ crossover: ['ema_f', 'ema_s'] }] } };
  assert.deepStrictEqual(dataDepthNotes(validateSpec(priceOnly).spec), []);
});

section('draft_strategy tool (stand-in engine):');
const ex = agentSetup(true).executors;
const mkCtx = (over = {}) => ({ userId: 1, tier: 'plus', holdings: [], heldSet: new Set(['AAPL']), drafts: [], callService: async () => ({ status: 200, data: { valid: true, errors: [] } }), ...over });
const draft = (input, ctx) => runTool({ id: 'd', name: 'draft_strategy', input }, ctx, ex);
check('a valid spec becomes a draft: rules in words, notes attached, spec kept out of the model\'s result', async () => {
  const ctx = mkCtx();
  const r = await draft({ spec: GOOD, assumptions: ['used 20 and 50 days for "short" and "long"'] }, ctx);
  assert.ok(!r.is_error, r.content);
  const out = JSON.parse(r.content);
  assert.ok(out.status.startsWith('draft — not saved'));
  assert.ok(out.rules.includes('Enter when ema_f crosses above ema_s and sz > 0'));
  assert.deepStrictEqual(out.seniq_signals, ['sentiment_zscore']);
  assert.strictEqual(out.data_depth_notes.length, 1);
  assert.strictEqual(out.validated_by, 'app+engine');
  assert.ok(!('spec' in out)); // the model already has it; the result stays small
  assert.ok(r.content.length < QA.MAX_TOOL_RESULT_CHARS);
  assert.strictEqual(ctx.drafts.length, 1);
  assert.deepStrictEqual(ctx.drafts[0].spec.factors.map((f) => f.id), ['ema_f', 'ema_s', 'sz']);
  assert.deepStrictEqual(ctx.drafts[0].assumptions, ['used 20 and 50 days for "short" and "long"']);
});
check('an invalid spec comes back as errors to fix, and no draft is recorded', async () => {
  const ctx = mkCtx();
  const r = await draft({ spec: vary({ factors: [{ id: 'ema_f', fn: 'bollinger' }, GOOD.factors[1], GOOD.factors[2]] }) }, ctx);
  assert.ok(r.is_error && /invalid_draft: fix these/.test(r.content) && /unknown fn "bollinger"/.test(r.content));
  assert.strictEqual(ctx.drafts.length, 0);
});
check('engine offline → the app check stands and the draft says so; engine rejection wins', async () => {
  const off = mkCtx({ callService: async () => ({ status: 503, data: {} }) });
  assert.strictEqual(JSON.parse((await draft({ spec: GOOD }, off)).content).validated_by, 'app');
  assert.strictEqual(off.drafts.length, 1);
  const rejects = mkCtx({ callService: async () => ({ status: 200, data: { valid: false, errors: ['factors[0]: something new'] } }) });
  const r = await draft({ spec: GOOD }, rejects);
  assert.ok(r.is_error && /engine rejected it — factors\[0\]: something new/.test(r.content));
  assert.strictEqual(rejects.drafts.length, 0);
});
check('tier gate and v1 mode', async () => {
  const free = await draft({ spec: GOOD }, mkCtx({ tier: 'free' }));
  assert.ok(free.is_error && /plan_required/.test(free.content));
  const v1 = await runTool({ id: 'd', name: 'draft_strategy', input: { spec: GOOD } }, mkCtx(), agentSetup(false).executors);
  assert.ok(v1.is_error && /unknown tool/.test(v1.content));
});
check('the tool never calls an engine endpoint that runs or saves anything', async () => {
  const paths = [];
  await draft({ spec: GOOD }, mkCtx({ callService: async (p) => { paths.push(p); return { status: 200, data: { valid: true } }; } }));
  assert.deepStrictEqual(paths, ['/api/strategies/validate']);
});

section('agent loop (scripted model):');
const fakeClient = (turns) => { let i = 0; const calls = []; return { calls, messages: { create: async (p) => { calls.push(JSON.parse(JSON.stringify(p))); return turns[Math.min(i++, turns.length - 1)]; } } }; };
const toolTurn = (input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${Math.random()}`, name: 'draft_strategy', input }], usage: { input_tokens: 900, output_tokens: 200 } });
const textTurn = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 120 } });
check('a rejected draft is sent back to the model, which fixes it; only the accepted draft is kept', async () => {
  const bad = vary({ factors: [{ id: 'ema_f', fn: 'ema', params: { length: 20 } }, GOOD.factors[1], GOOD.factors[2]] });
  const answer = 'Draft "EMA cross with sentiment": enter when the 20-day EMA crosses above the 50-day and sentiment is above its norm; exit on the reverse cross or an 8% stop. It is untested. Educational only, not investment advice.';
  const client = fakeClient([toolTurn({ spec: bad }), toolTurn({ spec: GOOD }), textTurn(answer)]);
  const ctx = mkCtx();
  const r = await runAgent('buy when the 20 day ema crosses above the 50 day and sentiment is positive, sell on the reverse cross or an 8% loss', [], ctx, client, { setup: agentSetup(true) });
  assert.strictEqual(client.calls.length, 3);
  const firstResult = client.calls[1].messages.at(-1).content[0];
  assert.ok(firstResult.is_error && /ema has no parameter "length"/.test(firstResult.content));
  assert.strictEqual(ctx.drafts.length, 1);
  assert.strictEqual(r.evidence.length, 1); // only the accepted draft is evidence
  // The figures in the answer (20, 50, 8%) are in the tool result, so the audit passes.
  assert.strictEqual(checkGrounding(r.answer, [client.calls[0].messages[0].content, ...r.evidence]).grounded, true);
});
check('the v2 prompt tells the model to ask instead of inventing a strategy from a goal', () => {
  const sys = agentSetup(true).system;
  assert.ok(/do not invent one/.test(sys) && /Never say a draft will be profitable/.test(sys));
  assert.ok(/pass on every data_depth_notes line/.test(sys));
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} checks passed`);
})();
