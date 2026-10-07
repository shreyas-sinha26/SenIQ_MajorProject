#!/usr/bin/env node
/**
 * Ask eval runner.
 *
 *   node eval/ask/run.js --check
 *       FREE, offline. Validates cases.json, replays every case through the scope pre-check
 *       (the one routing decision made before any model call), and self-tests the grader on
 *       a known-good and a known-bad answer. No database, no network, no model.
 *
 *   node eval/ask/run.js --run --yes-spend --max-usd 2 [--judge] [--reps 1] [--only id,id]
 *       PAID. Sends each case through the app's real entry point (answerQuestion) with the
 *       real model, grades it, and writes eval/ask/runs/<timestamp>/. Refuses to start
 *       without --yes-spend and stops once --max-usd is reached.
 *       --judge adds the rubric judge (a second, paid model call per case).
 *       Needs DATABASE_URL and ANTHROPIC_API_KEY. Creates the fixture user
 *       (fixture.user_email in cases.json) and its holdings if they do not exist.
 *
 *   node eval/ask/run.js --judge-selftest --yes-spend
 *       PAID, three small calls. Feeds the judge an empty answer, "I don't know", and a
 *       confident answer to a different question; all three must fail the grounded line.
 *
 * Output per run: results.jsonl (one graded row per case and rep, with the full answer, tool
 * results and judge verdicts), errors.jsonl (attempts that never produced an answer to
 * grade), summary.json. Infra errors are never counted as wrong answers.
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

// The judge is a different model from the one under test (Haiku writes the answers), so it
// is not grading its own style. Prices are $ per million tokens.
const JUDGE = { MODEL: 'claude-sonnet-5-5', MAX_TOKENS: 4000, EFFORT: 'medium', PRICE: { input: 2.0, output: 10.0 } };

const doc = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ── --check (free, offline) ──
function check() {
  const { TOOLS, scopeCheck } = require(path.join(ROOT, 'server/services/qaTools'));
  const { STRATEGY_TOOLS } = require(path.join(ROOT, 'server/services/strategyTools'));
  const { UNIVERSE } = require(path.join(ROOT, 'server/data/universe'));
  let bad = 0;
  const report = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${text}`); };

  console.log('cases.json:');
  const problems = lib.validateCases(doc, [...TOOLS, ...STRATEGY_TOOLS].map((t) => t.name));
  report(problems.length === 0, `${doc.cases.length} cases valid`);
  problems.forEach((p) => console.log(`      ${p}`));

  console.log('scope pre-check routing (no model call):');
  // Same universe the app builds in qa.js loadUniverse(): active non-commodity companies,
  // plus any holding outside the list.
  const universe = UNIVERSE.filter((c) => c.assetClass !== 'commodity').map((c) => ({ ticker: c.ticker, name: c.name, aliases: c.aliases || [] }));
  const known = new Set(universe.map((c) => c.ticker));
  for (const h of doc.fixture.holdings) if (!known.has(h.ticker)) universe.push({ ticker: h.ticker, name: h.company_name || '', aliases: [] });
  const held = new Set(doc.fixture.holdings.map((h) => h.ticker));
  const wrong = [];
  for (const c of doc.cases) {
    const refused = scopeCheck(c.question, universe, held).refuse;
    if (refused !== (c.expect.writer === 'scope')) wrong.push(`${c.id} (expected ${c.expect.writer}, pre-check ${refused ? 'refused' : 'passed it on'})`);
  }
  report(wrong.length === 0, `${doc.cases.length - wrong.length}/${doc.cases.length} route as expected`);
  wrong.forEach((w) => console.log(`      ${w}`));

  console.log('grader self-test (known-good must pass, known-bad must fail):');
  const c = doc.cases.find((x) => x.expect.writer === 'claude' && (x.expect.tools_any || []).length);
  const evidence = ['{"portfolio_change_pct":-0.8,"contributions":[{"ticker":"AAPL","contribution_pct":-1.2}]}'];
  const good = { writer: 'claude', answer: 'Your priced holdings moved -0.8% today. AAPL was the largest drag at -1.2 points.', tools_used: [c.expect.tools_any[0]], grounding: { grounded: true, unsupported: [] }, evidence };
  const nulls = [
    ['empty answer from the wrong writer', { writer: 'deterministic', answer: '', tools_used: [], grounding: null, evidence: [] }],
    ['no expected tool called', { ...good, tools_used: [] }],
    ['ungrounded figure', { ...good, grounding: { grounded: false, unsupported: [{ type: 'number', text: '9.9%' }] } }],
    ['advice wording', { ...good, answer: 'You should sell AAPL now.' }],
    ['a markdown table', { ...good, answer: '| a | b |\n| 1 | 2 |' }],
  ];
  report(lib.gradeDeterministic(c, good).pass, 'known-good answer passes');
  for (const [name, run] of nulls) report(!lib.gradeDeterministic(c, run).pass, `known-bad fails: ${name}`);
  const scopeCase = doc.cases.find((x) => x.expect.writer === 'scope');
  report(lib.gradeDeterministic(scopeCase, { writer: 'scope', answer: 'not tracked', tools_used: [], grounding: null, evidence: [] }).pass, 'a correct scope refusal passes');
  report(lib.infraFailure(c, { writer: 'deterministic', guard: 'no_api_key' }) !== null, 'a degraded run is an infra error, not a wrong answer');

  console.log(bad ? `\n${bad} problem(s)` : '\nall checks passed — nothing was spent');
  process.exit(bad ? 1 : 0);
}

// ── Paid paths ──
function requireSpend() {
  if (!flag('yes-spend')) fail('This makes paid model calls. Re-run with --yes-spend (and --max-usd N) once you have decided to spend.');
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  if (!process.env.ANTHROPIC_API_KEY) fail('ANTHROPIC_API_KEY is not set in .env.');
}

async function judgeOne(client, c, run) {
  const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema');
  const lines = lib.rubricLines(doc, c);
  try {
    const resp = await client.messages.parse({
      model: JUDGE.MODEL,
      max_tokens: JUDGE.MAX_TOKENS,
      system: lib.JUDGE_SYSTEM,
      output_config: { effort: JUDGE.EFFORT, format: jsonSchemaOutputFormat(lib.judgeSchema(lines.map((l) => l.id))) },
      messages: [{ role: 'user', content: lib.judgePrompt(c, run, lines) }],
    });
    const cost_usd = lib.costUsd(resp.usage, JUDGE.PRICE);
    const base = { model: resp.model, usage: resp.usage, cost_usd };
    if (resp.stop_reason === 'refusal') return { ...base, error: 'judge refused' };
    if (resp.stop_reason === 'max_tokens') return { ...base, error: 'judge reply truncated' };
    if (!String(resp.model || '').startsWith(JUDGE.MODEL)) return { ...base, error: `judge served by ${resp.model}, not ${JUDGE.MODEL}` };
    return { ...base, ...lib.readVerdicts(resp.parsed_output, lines) };
  } catch (err) {
    return { error: `judge call failed: ${err.status || ''} ${err.message}`.trim(), cost_usd: 0 };
  }
}

async function ensureFixture() {
  const { queryOne, execute } = require(path.join(ROOT, 'server/db'));
  const f = doc.fixture;
  let user = await queryOne('SELECT id FROM users WHERE email = $1', [f.user_email]);
  if (!user) {
    // No password hash: the fixture account exists only to own a portfolio and cannot sign in.
    user = await queryOne(
      "INSERT INTO users (email, name, subscription_tier, email_verified) VALUES ($1, 'Ask eval fixture', $2, false) RETURNING id",
      [f.user_email, f.tier || 'pro']);
    console.log(`  created fixture user ${f.user_email}`);
  }
  for (const h of f.holdings) {
    await execute(
      `INSERT INTO portfolio (user_id, ticker, company_name, asset_class, exchange, quantity)
       SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM portfolio WHERE user_id = $1 AND ticker = $2)`,
      [user.id, h.ticker, h.company_name || '', h.asset_class || 'equity', h.exchange || null, h.quantity ?? null]);
  }
  return Number(user.id);
}

async function run() {
  requireSpend();
  const maxUsd = Number(opt('max-usd', NaN));
  if (!(maxUsd > 0)) fail('Set a spending ceiling: --max-usd N (for example --max-usd 2).');
  const reps = Math.max(1, Math.min(5, Number(opt('reps', 1)) || 1));
  const only = opt('only', '') ? new Set(opt('only', '').split(',')) : null;
  const useJudge = flag('judge');
  const cases = doc.cases.filter((c) => !only || only.has(c.id));
  if (!cases.length) fail('No cases selected.');

  const config = require(path.join(ROOT, 'server/config'));
  // CLAUDE_REPORTS is hard-coded off in config.js. --yes-spend is the explicit decision to
  // spend, so it is switched on for THIS PROCESS ONLY; the app's own setting is untouched.
  config.FEATURES.CLAUDE_REPORTS = true;
  const { answerQuestion } = require(path.join(ROOT, 'server/services/qa'));
  const Anthropic = require('@anthropic-ai/sdk');
  const judgeClient = useJudge ? new Anthropic() : null;

  console.log(`Ask eval: ${cases.length} cases × ${reps} rep(s), judge ${useJudge ? JUDGE.MODEL : 'off'}, ceiling $${maxUsd}`);
  console.log(`  answers by ${config.QA.MODEL}; the app's own $${config.REPORTS.GLOBAL_DAILY_USD_CEILING}/day kill-switch also applies`);
  const userId = await ensureFixture();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(HERE, 'runs', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  const errors = [];
  let spent = 0;
  let stoppedAt = null;

  outer:
  for (let rep = 1; rep <= reps; rep++) {
    for (const c of cases) {
      if (spent >= maxUsd) { stoppedAt = `${c.id} (rep ${rep})`; break outer; }
      const started = Date.now();
      let r;
      try {
        // dailyLimit is lifted for the fixture user only: the eval asks more than a real
        // user's quota in one sitting. The spend ceiling above is what bounds it.
        r = await answerQuestion(userId, c.question, c.history || [], { tier: doc.fixture.tier || 'pro', dailyLimit: 1e9, trace: true });
      } catch (err) {
        errors.push({ id: c.id, rep, class: 'harness_error', error: err.message });
        console.log(`  ! ${c.id} harness error: ${err.message}`);
        continue;
      }
      const trace = r.trace || {};
      const cost = trace.cost_usd || 0;
      spent += cost;
      const runView = { writer: r.writer, answer: r.answer, tools_used: r.tools_used, grounding: r.grounding, guard: r.guard, evidence: trace.evidence || [], trace };

      const infra = lib.infraFailure(c, runView);
      if (infra) {
        errors.push({ id: c.id, rep, class: infra, cost_usd: cost });
        console.log(`  ! ${c.id} not scored — ${infra}`);
        // A kill-switch, a missing key or a rejected key will hit every remaining case the same way.
        if (/guard: (no_api_key|claude_reports_disabled|global_kill_switch)|model_error: 40[13]\b|authentication/i.test(infra)) { stoppedAt = `${c.id} (${infra})`; break outer; }
        continue;
      }
      if (r.writer === 'claude' && trace.model && !String(trace.model).startsWith(config.QA.MODEL)) {
        errors.push({ id: c.id, rep, class: `served_model_mismatch: ${trace.model}`, cost_usd: cost });
        console.log(`  ! ${c.id} not scored — served by ${trace.model}`);
        continue;
      }

      const row = {
        id: c.id, rep, tags: c.tags, question: c.question,
        status: trace.stop_reason === 'max_tokens' ? 'truncated' : 'ok',
        writer: r.writer, tools_used: r.tools_used, answer: r.answer,
        deterministic: lib.gradeDeterministic(c, runView),
        grounding: r.grounding,
        evidence: runView.evidence,
        model: trace.model, stop_reason: trace.stop_reason, rounds: trace.rounds, usage: trace.usage, cost_usd: cost,
        wall_ms: Date.now() - started,
      };
      if (useJudge && r.writer === 'claude') {
        row.judge = await judgeOne(judgeClient, c, runView);
        spent += row.judge.cost_usd || 0;
      }
      rows.push(row);
      fs.appendFileSync(path.join(outDir, 'results.jsonl'), JSON.stringify(row) + '\n');
      const j = row.judge ? (row.judge.error ? ' judge:error' : ` judge:${row.judge.pass ? 'pass' : 'fail'}`) : '';
      console.log(`  ${row.deterministic.pass ? '✓' : '✗'} ${c.id} [${r.writer}]${j}  $${spent.toFixed(3)} so far`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'errors.jsonl'), errors.map((e) => JSON.stringify(e)).join('\n') + (errors.length ? '\n' : ''));
  // Truncated answers are shown but not averaged in as wrong.
  const scored = rows.filter((r) => r.status === 'ok');
  const summary = {
    ...lib.summarize(scored, errors, { reps }),
    truncated: rows.length - scored.length,
    stopped_early: stoppedAt,
    spent_usd: Math.round(spent * 10000) / 10000,
    models: { answers: config.QA.MODEL, judge: useJudge ? JUDGE.MODEL : null },
    cases_file_version: doc.version,
    strategies_mode: !!config.FEATURES.STRATEGIES,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${JSON.stringify(summary, null, 2)}\n\nwritten to ${path.relative(ROOT, outDir)}`);
  if (stoppedAt) console.log(`stopped early at ${stoppedAt}`);
  process.exit(0);
}

async function judgeSelfTest() {
  requireSpend();
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const c = doc.cases.find((x) => x.id === 'move-01') || doc.cases[0];
  const evidence = ['{"portfolio_change_pct":-0.8,"contributions":[{"ticker":"AAPL","change_pct":-2,"weight_pct":60,"contribution_pct":-1.2}],"unpriced":["RELIANCE","TCS"]}'];
  const probes = [
    ['empty answer', ''],
    ['"I don\'t know"', "I don't know."],
    ['confident answer to a different question', 'Nvidia reported record data-centre revenue of $57 billion last quarter and raised its guidance, so the stock should keep climbing.'],
  ];
  let bad = 0;
  let spent = 0;
  for (const [name, answer] of probes) {
    const j = await judgeOne(client, c, { answer, evidence });
    spent += j.cost_usd || 0;
    // Each probe must fail at least one case-specific line (it never states the day's move).
    const failed = !j.error && j.verdicts.some((v) => v.scope === 'case' && v.verdict === 'fail');
    if (!failed) bad++;
    console.log(`  ${failed ? '✓' : '✗'} judge fails: ${name}${j.error ? ` (${j.error})` : ''}`);
  }
  console.log(`\nspent $${spent.toFixed(4)}${bad ? ` — ${bad} probe(s) the judge did not fail; fix the judge prompt before trusting it` : ''}`);
  process.exit(bad ? 1 : 0);
}

if (flag('run')) run().catch((e) => fail(e.stack || e.message));
else if (flag('judge-selftest')) judgeSelfTest().catch((e) => fail(e.stack || e.message));
else check();
