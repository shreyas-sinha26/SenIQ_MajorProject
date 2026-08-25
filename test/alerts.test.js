/**
 * Phase 9 — offline tests for instant alert email delivery + Pro narrative.
 * No DB, no network, no Claude/Ollama: every side-effecting dependency is injected.
 * Run: node test/alerts.test.js   (also chained into `npm test`)
 */
// db.js throws without a URL at require-time; middleware/tier.js pulls it in. A dummy URL
// is enough — no query ever runs (tierFn/getEmailFn/narrativeFn are all stubbed).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const {
  shouldEmail, dedupeEmailable, buildAlertEmail, deliverAlertEmails,
} = require('../server/services/alertNotifier');
const {
  buildFacts, deterministicNarrative, writeAlertNarrative, confidenceLabel, wordCount,
} = require('../server/services/alertNarrative');
const { guardCheck } = require('../server/services/reports');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// A holdings realtime alert as enriched by materiality.generateAlerts.
const ALERT = {
  user_id: 1, event_id: 10, ticker: 'AAPL', title: 'Apple recalls flagship device',
  direction: 'negative', score: 0.22, exposure_pct: 20, priority: 0.51, source_count: 3,
  alert_type: 'holding_negative', message: '⚠️ AAPL — Apple recalls flagship device', delivery: 'realtime',
};
const FACTS = buildFacts(ALERT);

// Fresh sink per test so counts don't leak between cases.
function mkSend() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { delivered: true }; } };
}
const baseDeps = (over = {}) => ({
  emailEnabledFn: () => true,
  tierFn: async () => ({ tier: 'plus' }),
  getEmailFn: async () => ({ email: 'user@example.com', name: 'User' }),
  narrativeFn: async () => ({ narrative: 'PRO_NARRATIVE_TEXT', writer: 'template' }),
  ...over,
});

(async () => {
  console.log('alerts.test.js — Phase 9 email delivery + Pro narrative');

  // ── Tier / delivery gate ──
  console.log('\nshouldEmail (tier + delivery gate):');
  check('Free never emails', () => assert.strictEqual(shouldEmail('free', 'realtime'), false));
  check('Plus realtime emails', () => assert.strictEqual(shouldEmail('plus', 'realtime'), true));
  check('Pro realtime emails', () => assert.strictEqual(shouldEmail('pro', 'realtime'), true));
  check('digest never emails (realtime-only)', () => assert.strictEqual(shouldEmail('plus', 'digest'), false));

  // ── Email body construction ──
  console.log('\nbuildAlertEmail (content):');
  check('subject follows the [SenIQ] Portfolio Alert: <headline> format', () => {
    const em = buildAlertEmail(FACTS, {});
    assert.match(em.subject, /^\[SenIQ\] Portfolio Alert: Apple recalls flagship device/);
  });
  check('body carries holdings, exposure, sentiment, impact, why + dashboard link', () => {
    const em = buildAlertEmail(FACTS, {});
    assert.match(em.text, /Affected holdings: AAPL/);
    assert.match(em.text, /Portfolio exposure: 20%/);
    assert.match(em.text, /Sentiment score: 22\/100 \(negative\)/);
    assert.match(em.text, /Impact score: 0\.51/);
    assert.match(em.text, /Why this fired:/);
    assert.match(em.text, /Open your dashboard:/);
    assert.ok(!/Analyst take/.test(em.text), 'no narrative section without a narrative');
  });
  check('Pro body appends the narrative', () => {
    const em = buildAlertEmail(FACTS, { narrative: 'ZZZ_TAKE' });
    assert.match(em.text, /Analyst take:/);
    assert.match(em.text, /ZZZ_TAKE/);
    assert.match(em.html, /ZZZ_TAKE/);
  });

  // ── Deduplication ──
  console.log('\ndedupe (never duplicate an alert):');
  check('dedupeEmailable collapses same (user, event)', () => {
    assert.strictEqual(dedupeEmailable([ALERT, { ...ALERT }]).length, 1);
    assert.strictEqual(dedupeEmailable([ALERT, { ...ALERT, event_id: 11 }]).length, 2);
  });

  // ── Delivery orchestration ──
  console.log('\ndeliverAlertEmails (orchestration):');

  await checkAsync('Free user receives NO email', async () => {
    const { sent, send } = mkSend();
    const s = await deliverAlertEmails([ALERT], baseDeps({ sendEmailFn: send, tierFn: async () => ({ tier: 'free' }) }));
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(s.skipped, 1);
  });

  await checkAsync('Plus user gets a standard email (no narrative, narrativeFn untouched)', async () => {
    const { sent, send } = mkSend();
    let narrativeCalled = false;
    const s = await deliverAlertEmails([ALERT], baseDeps({
      sendEmailFn: send, tierFn: async () => ({ tier: 'plus' }),
      narrativeFn: async () => { narrativeCalled = true; return { narrative: 'N' }; },
    }));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(narrativeCalled, false);
    assert.match(sent[0].subject, /^\[SenIQ\] Portfolio Alert:/);
    assert.ok(!/Analyst take/.test(sent[0].text));
    assert.strictEqual(s.sent, 1);
  });

  await checkAsync('Pro user gets an enhanced email with the narrative', async () => {
    const { sent, send } = mkSend();
    const s = await deliverAlertEmails([ALERT], baseDeps({
      sendEmailFn: send, tierFn: async () => ({ tier: 'pro' }),
      narrativeFn: async () => ({ narrative: 'PRO_NARRATIVE_TEXT' }),
    }));
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /Analyst take:/);
    assert.match(sent[0].text, /PRO_NARRATIVE_TEXT/);
    assert.strictEqual(s.sent, 1);
  });

  await checkAsync('duplicate alerts in one batch → exactly one email', async () => {
    const { sent, send } = mkSend();
    await deliverAlertEmails([ALERT, { ...ALERT }], baseDeps({ sendEmailFn: send }));
    assert.strictEqual(sent.length, 1);
  });

  await checkAsync('email failure is caught, logged, never thrown (engine survives)', async () => {
    const s = await deliverAlertEmails([ALERT], baseDeps({
      sendEmailFn: async () => { throw new Error('smtp down'); },
    }));
    assert.strictEqual(s.failed, 1);
    assert.strictEqual(s.sent, 0);
  });

  await checkAsync('Pro narrative failure still sends a plain email', async () => {
    const { sent, send } = mkSend();
    const s = await deliverAlertEmails([ALERT], baseDeps({
      sendEmailFn: send, tierFn: async () => ({ tier: 'pro' }),
      narrativeFn: async () => { throw new Error('claude + ollama both down'); },
    }));
    assert.strictEqual(sent.length, 1);
    assert.ok(!/Analyst take/.test(sent[0].text), 'degraded to plain body');
    assert.strictEqual(s.sent, 1);
  });

  await checkAsync('no provider configured → nothing sent, no crash', async () => {
    const { sent, send } = mkSend();
    const s = await deliverAlertEmails([ALERT], baseDeps({ emailEnabledFn: () => false, sendEmailFn: send }));
    assert.strictEqual(sent.length, 0);
    assert.deepStrictEqual(s, { sent: 0, skipped: 0, failed: 0 });
  });

  // ── Narrative fallback hierarchy (Claude → Ollama → template) ──
  console.log('\nwriteAlertNarrative (fallback hierarchy):');
  const claudeOk = async () => ({ writer: 'claude', model: 'claude-haiku-4-5', narrative: 'C', usage: { input: 5, output: 5 } });
  const ollamaOk = async () => ({ writer: 'ollama', model: 'llama', narrative: 'O', usage: { input: 0, output: 0 } });
  const boom = async () => { throw new Error('unavailable'); };

  await checkAsync('Claude used when allowed', async () => {
    const r = await writeAlertNarrative(FACTS, { allowClaude: true, claudeFn: claudeOk, ollamaFn: ollamaOk });
    assert.strictEqual(r.writer, 'claude');
  });
  await checkAsync('Claude fails → falls back to Ollama', async () => {
    const r = await writeAlertNarrative(FACTS, { allowClaude: true, claudeFn: boom, ollamaFn: ollamaOk });
    assert.strictEqual(r.writer, 'ollama');
  });
  await checkAsync('Claude + Ollama fail → deterministic template (never fails)', async () => {
    const r = await writeAlertNarrative(FACTS, { allowClaude: true, claudeFn: boom, ollamaFn: boom });
    assert.strictEqual(r.writer, 'template');
    assert.ok(r.narrative.length > 0);
  });
  await checkAsync('quota/kill-switch denies Claude (allowClaude=false) → Claude never called', async () => {
    let claudeCalled = false;
    const r = await writeAlertNarrative(FACTS, {
      allowClaude: false,
      claudeFn: async () => { claudeCalled = true; return claudeOk(); },
      ollamaFn: ollamaOk,
    });
    assert.strictEqual(claudeCalled, false);
    assert.strictEqual(r.writer, 'ollama');
  });

  // Reuse of the shared guardrail (proves the quota path is the existing one).
  console.log('\nguardCheck (reused quota/kill-switch):');
  check('over per-user daily quota → blocked', () =>
    assert.strictEqual(guardCheck({ flagOn: true, hasKey: true, userCallsToday: 5, quota: 5, globalSpendToday: 0, ceiling: 5 }).reason, 'user_quota_exceeded'));
  check('global kill-switch → blocked (precedence over quota)', () =>
    assert.strictEqual(guardCheck({ flagOn: true, hasKey: true, userCallsToday: 9, quota: 5, globalSpendToday: 5, ceiling: 5 }).reason, 'global_kill_switch'));

  // ── Deterministic template content ──
  console.log('\ndeterministicNarrative (template content):');
  check('covers all required elements + cites numbers', () => {
    const n = deterministicNarrative(FACTS);
    for (const label of ['What happened', 'Why it matters', 'Affected holdings', 'Expected short-term impact', 'Confidence', 'Key risks']) {
      assert.ok(n.includes(label), `missing "${label}"`);
    }
    assert.match(n, /20%/);           // exposure cited
    assert.ok(wordCount(n) > 40);     // substantive
    assert.ok(['high', 'moderate', 'low'].includes(confidenceLabel(FACTS)));
  });
  check('market/world alert renders without a ticker/exposure', () => {
    const marketFacts = buildFacts({ ticker: 'MARKET', title: 'Fed hikes rates', direction: 'neutral', priority: 0.7, source_count: 5, event_id: 20, user_id: 1 });
    const n = deterministicNarrative(marketFacts);
    assert.ok(n.includes('broad market') || n.includes('market'));
    assert.ok(n.length > 0);
  });

  console.log(`\n${passed} passed${process.exitCode ? ' — with failures' : ''}`);
})();
