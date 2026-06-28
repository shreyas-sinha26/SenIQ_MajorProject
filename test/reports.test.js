/**
 * Offline logic tests for E5 — the analyst voice. No DB, no Claude calls.
 * Covers the cost-guardrail decision, the "what changed since yesterday" diff, the
 * deterministic writer, and Claude-output parsing.
 */

const assert = require('node:assert');
const { guardCheck } = require('../server/services/reports');
const { buildDiff } = require('../server/services/grounding');
const { deterministicBrief, parseClaudeOutput } = require('../server/services/briefWriter');
const { sanitizeQuestion, deterministicAnswer } = require('../server/services/qa');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const base = { flagOn: true, hasKey: true, userCallsToday: 0, quota: 1, globalSpendToday: 0, ceiling: 5 };

console.log('guardCheck (E5 cost guardrails):');
check('all clear → allow', () => assert.strictEqual(guardCheck(base).allow, true));
check('flag off → block', () => assert.strictEqual(guardCheck({ ...base, flagOn: false }).reason, 'claude_reports_disabled'));
check('no api key → block', () => assert.strictEqual(guardCheck({ ...base, hasKey: false }).reason, 'no_api_key'));
check('user quota spent → block', () => assert.strictEqual(guardCheck({ ...base, userCallsToday: 1 }).reason, 'user_quota_exceeded'));
check('global kill-switch → block', () => assert.strictEqual(guardCheck({ ...base, globalSpendToday: 5 }).reason, 'global_kill_switch'));
check('kill-switch takes precedence over quota', () => assert.strictEqual(guardCheck({ ...base, userCallsToday: 1, globalSpendToday: 9 }).reason, 'global_kill_switch'));

console.log('\nbuildDiff (what changed since yesterday):');
const mkPacket = (events, holdings = []) => ({ top_events: events, portfolio: { top_holdings: holdings } });
const ev = (id, rest = {}) => ({ event_id: id, title: `E${id}`, impact_score: 0.3, exposure_pct: 20, direction: 'positive', ...rest });

check('no prior → has_prior false, all new', () => {
  const d = buildDiff(mkPacket([ev(1), ev(2)]), null);
  assert.strictEqual(d.has_prior, false);
  assert.strictEqual(d.new_events.length, 2);
});
check('new event detected', () => {
  const d = buildDiff(mkPacket([ev(1), ev(3)]), mkPacket([ev(1), ev(2)]));
  assert.deepStrictEqual(d.new_events.map((e) => e.event_id), [3]);
});
check('dropped event detected', () => {
  const d = buildDiff(mkPacket([ev(1)]), mkPacket([ev(1), ev(2)]));
  assert.deepStrictEqual(d.dropped_events.map((e) => e.event_id), [2]);
});
check('rank change detected', () => {
  const d = buildDiff(mkPacket([ev(2), ev(1)]), mkPacket([ev(1), ev(2)]));
  const rc = d.rank_changes.find((r) => r.event_id === 1);
  assert.ok(rc && rc.from_rank === 1 && rc.to_rank === 2);
});
check('sentiment swing on label flip', () => {
  const today = mkPacket([], [{ ticker: 'AAPL', sentiment_label: 'negative', sentiment_acute: 0.4 }]);
  const prev = mkPacket([], [{ ticker: 'AAPL', sentiment_label: 'positive', sentiment_acute: 0.65 }]);
  const d = buildDiff(today, prev);
  assert.strictEqual(d.sentiment_swings.length, 1);
  assert.strictEqual(d.sentiment_swings[0].to_label, 'negative');
});
check('no swing when stable', () => {
  const p = mkPacket([], [{ ticker: 'AAPL', sentiment_label: 'positive', sentiment_acute: 0.6 }]);
  assert.strictEqual(buildDiff(p, p).sentiment_swings.length, 0);
});

console.log('\ndeterministic writer + parsing:');
check('deterministic brief leads with most important', () => {
  const packet = { most_important: ev(1, { title: 'Big merger' }), top_events: [ev(1, { title: 'Big merger' })], changed: { has_prior: false }, portfolio: { top_holdings: [] }, smart_money: {} };
  const b = deterministicBrief(packet);
  assert.strictEqual(b.writer, 'deterministic');
  assert.ok(/Big merger/.test(b.headline));
  assert.ok(b.narrative.length > 0);
});
check('quiet day when no events', () => {
  const b = deterministicBrief({ most_important: null, top_events: [], changed: { has_prior: true }, portfolio: { top_holdings: [] }, smart_money: {} });
  assert.ok(/quiet/i.test(b.headline));
});
check('parseClaudeOutput splits HEADLINE marker', () => {
  const { headline, narrative } = parseClaudeOutput('HEADLINE: Tesla drags 18% of your book\n\nYour portfolio...');
  assert.strictEqual(headline, 'Tesla drags 18% of your book');
  assert.ok(narrative.startsWith('Your portfolio'));
});
check('parseClaudeOutput falls back to first sentence', () => {
  const { headline } = parseClaudeOutput('Markets were calm today. The rest follows.');
  assert.strictEqual(headline, 'Markets were calm today.');
});

console.log('\nQ&A (E6 — ask it anything):');
check('sanitizeQuestion trims + collapses whitespace', () => {
  assert.strictEqual(sanitizeQuestion('  why   is my\n portfolio down? '), 'why is my portfolio down?');
});
check('sanitizeQuestion empty → empty', () => assert.strictEqual(sanitizeQuestion('   '), ''));
check('sanitizeQuestion clamps very long input', () => {
  const long = 'a'.repeat(900);
  assert.ok(sanitizeQuestion(long).length <= 500);
});

const qaCtx = {
  portfolio: { holdings: [
    { ticker: 'AAPL', exposure_pct: 40, sentiment_label: 'negative' },
    { ticker: 'BTC', exposure_pct: 35, sentiment_label: 'positive' },
    { ticker: 'TCS', exposure_pct: 25, sentiment_label: 'neutral' },
  ] },
  most_important: { title: 'Tech selloff', exposure_pct: 40, direction: 'negative', impact_score: 0.3 },
};
check('deterministicAnswer "biggest risk" surfaces negative high-exposure name', () => {
  const a = deterministicAnswer('what is my biggest risk?', qaCtx);
  assert.ok(/AAPL/.test(a) && /risk|negative/i.test(a));
});
check('deterministicAnswer "improving" surfaces positive name', () => {
  const a = deterministicAnswer('which holdings are improving?', qaCtx);
  assert.ok(/BTC/.test(a));
});
check('deterministicAnswer leads with most important event', () => {
  assert.ok(/Tech selloff/.test(deterministicAnswer('why is my portfolio down?', qaCtx)));
});
check('deterministicAnswer with no holdings is graceful', () => {
  assert.ok(/add a few/i.test(deterministicAnswer('anything?', { portfolio: { holdings: [] } })));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
