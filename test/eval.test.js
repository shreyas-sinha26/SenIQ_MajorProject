/**
 * Offline tests for the Ask eval's pure half (eval/ask/lib.js). No DB, no model calls.
 */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const lib = require('../eval/ask/lib');
const { TOOLS } = require('../server/services/qaTools');
const { IPO_TOOLS } = require('../server/services/ipoTools');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../eval/ask/cases.json'), 'utf8'));
const toolNames = [...TOOLS, ...IPO_TOOLS].map((t) => t.name);
const CASE = { id: 'x-01', tags: ['t'], question: 'Why is my portfolio down?', rubric: ['states the move'], expect: { writer: 'claude', tools_any: ['get_attribution'], no_data_for: ['TSLA'] } };
const GOOD = { writer: 'claude', answer: 'Your holdings moved -0.8% today. AAPL was the largest drag.', tools_used: ['get_attribution'], grounding: { grounded: true, unsupported: [] }, evidence: ['{"ticker":"AAPL"}'] };

console.log('case file:');
check('the shipped cases.json is valid and every tools_any names a real tool', () => {
  assert.deepStrictEqual(lib.validateCases(doc, toolNames), []);
});
check('validation catches duplicates, unknown tools, bad writers and broken history', () => {
  const bad = { fixture: { holdings: [{ ticker: 'A' }] }, global_rubric: [], cases: [
    { id: 'a', tags: ['t'], question: 'q', rubric: [], expect: { writer: 'claude', tools_any: ['nope'] } },
    { id: 'a', tags: ['t'], question: 'q', rubric: [], expect: { writer: 'robot' } },
    { id: 'b', tags: ['t'], question: 'q', rubric: [], expect: { writer: 'scope', tools_any: ['get_sentiment'] } },
    { id: 'c', tags: ['t'], question: 'q', rubric: [], expect: { writer: 'claude' }, history: [{ role: 'user', content: 'x' }] },
  ] };
  const errs = lib.validateCases(bad, toolNames).join(' | ');
  for (const needle of ['unknown tool nope', 'duplicate id', 'expect.writer must be', 'a scope refusal calls no tools', 'history must alternate']) assert.ok(errs.includes(needle), needle);
  assert.deepStrictEqual(lib.validateCases(null), ['cases must be an array']);
});

console.log('deterministic grader:');
check('a good run passes every applicable check', () => {
  const g = lib.gradeDeterministic(CASE, GOOD);
  assert.strictEqual(g.pass, true);
  assert.deepStrictEqual(g.checks, { writer: true, tools: true, no_data_leak: true, grounded: true, concise: true, advice_free: true });
});
check('each failure is caught on its own check', () => {
  const f = (over) => lib.gradeDeterministic(CASE, { ...GOOD, ...over });
  assert.strictEqual(f({ writer: 'scope' }).checks.writer, false);
  assert.strictEqual(f({ tools_used: ['get_sentiment'] }).checks.tools, false);
  assert.deepStrictEqual(f({ evidence: ['{"ticker":"TSLA","price":1}'] }).detail.data_returned_for, ['TSLA']);
  assert.strictEqual(f({ grounding: { grounded: false, unsupported: [{ type: 'number', text: '9%' }] } }).checks.grounded, false);
  assert.strictEqual(f({ answer: 'You should sell AAPL.' }).checks.advice_free, false);
  assert.strictEqual(f({ answer: '## Summary\nfine.' }).checks.concise, false);
  assert.strictEqual(f({ writer: 'scope' }).pass, false);
});
check('checks that do not apply are null, not failures', () => {
  const g = lib.gradeDeterministic({ ...CASE, expect: { writer: 'scope' } }, { writer: 'scope', answer: 'TSLA is not tracked.', tools_used: [], grounding: null, evidence: [] });
  assert.deepStrictEqual(g.checks, { writer: true, tools: null, no_data_leak: null, grounded: null, concise: null, advice_free: null });
  assert.strictEqual(g.pass, true);
});
check('an out-of-scope ticker inside a longer word is not a leak', () => {
  const c = { ...CASE, expect: { writer: 'claude', no_data_for: ['AMD'] } };
  assert.strictEqual(lib.gradeDeterministic(c, { ...GOOD, evidence: ['AMDOCS and CAMDEN were mentioned'] }).checks.no_data_leak, true);
  assert.strictEqual(lib.gradeDeterministic(c, { ...GOOD, evidence: ['"ticker":"AMD"'] }).checks.no_data_leak, false);
});
check('advice wording: blunt cases caught, neutral reporting is not', () => {
  for (const s of ['I recommend trimming.', 'You should buy more NVDA.', 'It will rise next month.', 'Analysts set a price target of $200.']) assert.strictEqual(lib.adviceCheck(s).pass, false, s);
  for (const s of ['AAPL fell 2% today.', 'A fund sold shares last quarter.', 'I can\'t tell you whether to sell; here is what the data shows.']) assert.strictEqual(lib.adviceCheck(s).pass, true, s);
});
check('concise: long answers and tables fail, a short paragraph passes', () => {
  assert.strictEqual(lib.conciseCheck('One. Two. Three.').pass, true);
  assert.strictEqual(lib.conciseCheck(Array.from({ length: 12 }, (_, i) => `Sentence ${i}.`).join(' ')).pass, false);
  assert.strictEqual(lib.conciseCheck('| a | b |').pass, false);
});

console.log('infra errors vs wrong answers:');
check('a degraded run is an infra error; a wrong routing decision is graded', () => {
  assert.ok(/guard: no_api_key/.test(lib.infraFailure(CASE, { writer: 'deterministic', guard: 'no_api_key' })));
  assert.ok(/model_error: 529/.test(lib.infraFailure(CASE, { writer: 'deterministic', guard: 'ok', trace: { error: '529 overloaded' } })));
  assert.strictEqual(lib.infraFailure(CASE, { writer: 'claude', guard: 'ok' }), null);
  assert.strictEqual(lib.infraFailure(CASE, { writer: 'scope', guard: 'out_of_scope' }), null);
  assert.strictEqual(lib.infraFailure({ ...CASE, expect: { writer: 'scope' } }, { writer: 'scope' }), null);
});

console.log('judge plumbing:');
const lines = lib.rubricLines(doc, CASE);
check('rubric lines: global first (g…), then the case\'s own (c…)', () => {
  assert.strictEqual(lines.length, doc.global_rubric.length + 1);
  assert.deepStrictEqual([lines[0].id, lines.at(-1).id, lines.at(-1).scope], ['g1', 'c1', 'case']);
});
check('prompt fences every untrusted part and clamps huge evidence', () => {
  const p = lib.judgePrompt({ ...CASE, history: [{ role: 'user', content: 'h1' }, { role: 'assistant', content: 'h2' }] }, { ...GOOD, evidence: ['x'.repeat(50000)] }, lines);
  for (const tag of ['<question>', '<turns>', '<tool_results>', '<answer>', '<rubric>']) assert.ok(p.includes(tag), tag);
  assert.ok(p.includes('[truncated for the grader]') && p.length < 30000);
  assert.ok(lib.judgePrompt(CASE, { answer: '', evidence: [] }, lines).includes('(empty)'));
  // The judge is told the holdings the model is told, so naming them is not marked ungrounded.
  const withHoldings = lib.judgePrompt(CASE, { ...GOOD, holdings: ['AAPL', 'NVDA'] }, lines);
  assert.ok(/<holdings_given_with_the_question>\nAAPL, NVDA\n/.test(withHoldings) && /needs no tool result/.test(withHoldings));
  assert.ok(!lib.judgePrompt(CASE, GOOD, lines).includes('holdings_given_with_the_question'));
});
check('schema pins the ids and verdict values', () => {
  const s = lib.judgeSchema(['g1', 'c1']);
  assert.deepStrictEqual(s.properties.verdicts.items.properties.id.enum, ['g1', 'c1']);
  assert.strictEqual(s.additionalProperties, false);
});
check('verdicts: all applicable lines must pass; a missing id is an error, not a pass', () => {
  const all = (v) => ({ verdicts: lines.map((l) => ({ id: l.id, verdict: v, reason: 'r' })) });
  assert.strictEqual(lib.readVerdicts(all('pass'), lines).pass, true);
  const mixed = all('pass'); mixed.verdicts[0].verdict = 'not_applicable'; mixed.verdicts[1].verdict = 'fail';
  assert.strictEqual(lib.readVerdicts(mixed, lines).pass, false);
  assert.ok(/no verdict for c1/.test(lib.readVerdicts({ verdicts: all('pass').verdicts.slice(0, -1) }, lines).error));
  assert.ok(lib.readVerdicts(null, lines).error);
});

console.log('cost and summary:');
check('cost uses reported tokens, with cache writes at 1.25x and reads at 0.1x', () => {
  const usd = lib.costUsd({ input_tokens: 1000, cache_creation_input_tokens: 400, cache_read_input_tokens: 5000, output_tokens: 200 }, { input: 2, output: 10 });
  assert.ok(Math.abs(usd - ((1000 + 500 + 500) / 1e6 * 2 + 200 / 1e6 * 10)) < 1e-12);
  assert.strictEqual(lib.costUsd(null, { input: 2, output: 10 }), 0);
});
check('summary recomputes from rows; infra errors are counted apart, never as failures', () => {
  const row = (id, pass, tag, extra = {}) => ({ id, tags: [tag], status: 'ok', cost_usd: 0.01, deterministic: { pass, checks: { writer: true, tools: pass, no_data_leak: null, grounded: pass, concise: true, advice_free: true } }, ...extra });
  const judge = (pass) => ({ pass, cost_usd: 0.02, verdicts: [{ id: 'g1', scope: 'global', verdict: 'pass' }, { id: 'c1', scope: 'case', verdict: pass ? 'pass' : 'fail' }, { id: 'c2', scope: 'case', verdict: 'not_applicable' }] });
  const s = lib.summarize([row('a', true, 'news', { judge: judge(true) }), row('b', false, 'news', { judge: judge(false) }), row('c', true, 'risk'), row('d', true, 'risk', { judge: { error: 'judge refused', cost_usd: 0 } })], [{ id: 'e', class: 'model_error: 529', cost_usd: 0.005 }]);
  assert.deepStrictEqual([s.attempts, s.scored, s.infra_errors], [5, 4, 1]);
  assert.deepStrictEqual(s.deterministic.all_checks, { n: 4, pass: 3, rate: 0.75 });
  assert.deepStrictEqual(s.deterministic.no_data_leak, { n: 0, pass: 0, rate: null });
  assert.deepStrictEqual(s.by_tag.news, { n: 2, pass: 1, rate: 0.5 });
  assert.deepStrictEqual([s.judge.cases_judged, s.judge.judge_errors], [2, 1]);
  assert.deepStrictEqual(s.judge.case_lines, { n: 2, pass: 1, rate: 0.5 });
  assert.deepStrictEqual(s.cost_usd, { answers: 0.045, judge: 0.04 });
  assert.strictEqual(s.noise_floor, 0.5);
});

console.log(`\n${passed} checks passed`);
