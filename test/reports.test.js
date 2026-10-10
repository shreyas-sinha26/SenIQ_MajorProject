/**
 * Offline logic tests for E5 — the analyst voice. No DB, no Claude calls.
 * Covers the cost-guardrail decision, the "what changed since yesterday" diff, the
 * deterministic writer, and Claude-output parsing.
 */

const assert = require('node:assert');
const { guardCheck, briefQuota } = require('../server/services/reports');
const { buildDiff } = require('../server/services/grounding');
const { deterministicBrief, parseClaudeOutput, packetForWriter, tidyHeadline, headlineGrounded } = require('../server/services/briefWriter');
const { sanitizeQuestion, deterministicAnswer } = require('../server/services/qa');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const base = { flagOn: true, hasKey: true, userCallsToday: 0, quota: 1, globalSpendToday: 0, ceiling: 5 };

console.log('guardCheck (E5 cost guardrails):');
check('all clear → allow', () => assert.strictEqual(guardCheck(base).allow, true));
check('the brief allowance follows the plan: Free none, Plus one, Pro two', () => {
  assert.deepStrictEqual(['free', 'plus', 'pro'].map(briefQuota), [0, 1, 2]);
  assert.deepStrictEqual([undefined, null, 'constructor', 'enterprise'].map(briefQuota), [0, 0, 0, 0]);
  // A Free account never reaches Claude: its brief is one it cannot open.
  assert.strictEqual(guardCheck({ ...base, userCallsToday: 0, quota: briefQuota('free') }).reason, 'user_quota_exceeded');
  assert.strictEqual(guardCheck({ ...base, userCallsToday: 1, quota: briefQuota('pro') }).allow, true);
});
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
check('smart money: each stock is named once, and one trade is "trade", not "trade(s)"', () => {
  const base = { most_important: ev(1, { title: 'Big merger' }), top_events: [ev(1, { title: 'Big merger' })], changed: { has_prior: false }, portfolio: { top_holdings: [] } };
  const three = deterministicBrief({ ...base, smart_money: { congress: [{}, {}, {}], institutions: [{ ticker: 'AAPL' }, { ticker: 'AAPL' }, { ticker: 'AAPL' }, { ticker: 'NVDA' }] } });
  assert.ok(/institutional moves on AAPL, NVDA\./.test(three.narrative), three.narrative);
  assert.ok(/3 recent congressional trades in your names/.test(three.narrative), three.narrative);
  const one = deterministicBrief({ ...base, smart_money: { congress: [{}], india_deals: [{ ticker: 'TCS' }], india_insiders: [{ ticker: 'TCS' }] } });
  assert.ok(/1 recent congressional trade in your names; 1 bulk or block deal on TCS; an insider trade disclosed on TCS\./.test(one.narrative), one.narrative);
  assert.ok(!/\(s\)/.test(three.narrative + one.narrative));
});
check('parseClaudeOutput splits HEADLINE marker', () => {
  const { headline, narrative } = parseClaudeOutput('HEADLINE: Tesla drags 18% of your book\n\nYour portfolio...');
  assert.strictEqual(headline, 'Tesla drags 18% of your book');
  assert.ok(narrative.startsWith('Your portfolio'));
});
check('parseClaudeOutput falls back to first sentence', () => {
  const { headline } = parseClaudeOutput('Markets were calm today. The rest follows.');
  assert.strictEqual(headline, 'Markets were calm today');
});
check('a headline that runs to a full sentence is cut to its first clause, or to 14 words', () => {
  assert.strictEqual(tidyHeadline('Tesla drags 18% of your book.'), 'Tesla drags 18% of your book');
  assert.strictEqual(
    tidyHeadline('Apple leads your portfolio today as a new iPhone launch story touches 41.8% of your exposure, while Reliance and TCS stay quiet and Bitcoin slips.'),
    'Apple leads your portfolio today as a new iPhone launch story touches 41.8%…');
  assert.strictEqual(
    tidyHeadline('Nvidia earnings beat — the biggest story for your portfolio today because it touches nearly a third of everything you hold'),
    'Nvidia earnings beat');
  const cut = tidyHeadline('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen');
  assert.strictEqual(cut, 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen…');
  assert.strictEqual(parseClaudeOutput('HEADLINE: "Quiet day."\n\nBody').headline, 'Quiet day');
});
check('HEADLINE on a line of its own, or in ** **, is still the marker (a real reply, 2026-10-10)', () => {
  // What Claude Haiku 4.5 returned when asked for "HEADLINE: <…>": the word, a line break, the headline.
  const real = 'HEADLINE\nCrypto rout and rising yields pressure your $25.9B Apple and Bitcoin stakes\n\nYour portfolio faces headwinds today as the story that matters most for you is US market weakness.';
  const p = parseClaudeOutput(real);
  assert.strictEqual(p.headline, 'Crypto rout and rising yields pressure your $25.9B Apple and Bitcoin stakes');
  assert.ok(p.narrative.startsWith('Your portfolio faces headwinds'));
  assert.ok(!/HEADLINE/.test(p.headline + p.narrative));
  assert.strictEqual(parseClaudeOutput('**HEADLINE:** Apple leads a quiet day\n\nBody.').headline, 'Apple leads a quiet day');
  assert.strictEqual(parseClaudeOutput('**HEADLINE: Apple leads a quiet day**\n\nBody.').headline, 'Apple leads a quiet day');
  assert.strictEqual(parseClaudeOutput('Headline: Apple leads a quiet day\nBody.').narrative, 'Body.');
});
check('a money amount in the headline must come from a story; a share of the portfolio is not money', () => {
  const packet = { top_events: [ev(1, { title: 'SpaceX seeks $40 billion to buy Nvidia chips' }), ev(2, { title: 'Bitcoin falls to $82,000' })] };
  assert.strictEqual(headlineGrounded('Crypto rout and rising yields pressure your $25.9B Apple and Bitcoin stakes', packet), false);
  assert.strictEqual(headlineGrounded('SpaceX seeks $40 billion for Nvidia chips', packet), true);
  assert.strictEqual(headlineGrounded('Bitcoin slips to $82,000 as yields climb', packet), true);
  assert.strictEqual(headlineGrounded('Apple weakness touches 25.9% of your portfolio', packet), true); // no money in it
  assert.strictEqual(headlineGrounded('Rupee story costs you ₹3 crore', packet), false);
  assert.strictEqual(headlineGrounded('', packet), true);
});
check('the writer never sees the engine\'s scores, only rank, share of the portfolio and words', () => {
  const packet = {
    user_id: 7, date: '2026-10-10',
    portfolio: { holdings_count: 2, top_holdings: [
      { ticker: 'AAPL', name: 'Apple', sector: 'Technology', exposure_pct: 41.8, sentiment_label: 'positive', sentiment_acute: 0.71, z: 1.62 },
      { ticker: 'TCS', name: 'TCS', sector: 'IT', exposure_pct: 20, sentiment_label: 'neutral', sentiment_acute: 0.5, z: null }] },
    top_events: [ev(1, { title: 'Big merger', impact_score: 0.173, exposure_pct: 41.8, last_seen: '2026-10-09T10:00:00Z' }), ev(2, { title: 'Second', impact_score: 0.09 })],
    smart_money: { congress: [{ politician: 'A', action: 'buy', ticker: 'AAPL', date: '2026-09-01' }] },
    changed: { has_prior: true, new_events: [{ event_id: 1, title: 'Big merger', impact_score: 0.173, exposure_pct: 41.8, direction: 'positive' }],
      dropped_events: [], rank_changes: [], sentiment_swings: [{ ticker: 'AAPL', from_label: 'neutral', to_label: 'positive', from_acute: 0.52, to_acute: 0.71 }] },
  };
  const w = packetForWriter(packet);
  const text = JSON.stringify(w);
  assert.ok(!/impact_score|sentiment_acute|from_acute|to_acute|"z"|0\.173|0\.71|1\.62|user_id|event_id/.test(text), text);
  assert.strictEqual(w.top_events[0].rank, 1);
  assert.strictEqual(w.most_important.title, 'Big merger');
  assert.strictEqual(w.most_important.exposure_pct, 41.8);
  assert.strictEqual(w.top_events[0].date, '2026-10-09');
  assert.strictEqual(w.portfolio.top_holdings[0].sentiment_vs_usual, 'well above its usual level');
  assert.ok(!('sentiment_vs_usual' in JSON.parse(text).portfolio.top_holdings[1]), 'no history → nothing said about "usual"');
  assert.deepStrictEqual(w.changed.sentiment_swings[0], { ticker: 'AAPL', from: 'neutral', to: 'positive', moved: 'more positive than yesterday' });
  assert.deepStrictEqual(w.smart_money, packet.smart_money);
  assert.strictEqual(packet.top_events[0].impact_score, 0.173, 'the stored packet is untouched');
  assert.deepStrictEqual(packetForWriter({}).top_events, []);
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

// The Claude path end to end, with the model's reply stood in: the reply is the one Claude
// Haiku 4.5 gave on 2026-10-10 (the word HEADLINE on its own line, and "$25.9B" made out of
// "25.9% of your portfolio").
(async () => {
  const { writeBrief } = require('../server/services/briefWriter');
  const llm = require('../server/services/llmClient');
  const real = 'HEADLINE\nCrypto rout and rising yields pressure your $25.9B Apple and Bitcoin stakes\n\nYour portfolio faces headwinds today as the story that matters most for you is US market weakness.';
  const getClient = llm.getClient;
  let shown = null;
  llm.getClient = () => ({ messages: { create: async (req) => { shown = req.messages[0].content; return { content: [{ type: 'text', text: real }], usage: { input_tokens: 10, output_tokens: 5 } }; } } });
  try {
    const packet = {
      date: '2026-10-10', portfolio: { holdings_count: 1, top_holdings: [{ ticker: 'AAPL', exposure_pct: 25.9, sentiment_label: 'negative', sentiment_acute: 0.31, z: -0.24 }] },
      top_events: [ev(1, { title: 'US stocks slip as yields rise', impact_score: 0.157, exposure_pct: 25.9, direction: 'negative' })],
      most_important: ev(1, { title: 'US stocks slip as yields rise', impact_score: 0.157, exposure_pct: 25.9, direction: 'negative' }),
      smart_money: {}, changed: { has_prior: false },
    };
    const b = await writeBrief(packet, { allowClaude: true });
    try {
      assert.strictEqual(b.writer, 'claude');
      // "$25.9B" is in no story → the code-written headline, the one a Free account sees
      assert.strictEqual(b.headline, 'US stocks slip as yields rise — 25.9% of your exposure, negative');
      assert.ok(b.narrative.startsWith('Your portfolio faces headwinds') && !/HEADLINE/.test(b.narrative));
      assert.ok(!/0\.157|impact_score|-0\.24|sentiment_acute/.test(shown), 'a raw score reached the model');
      passed++; console.log('  ✓ Claude path: a headline with money no story states is replaced; the body is kept; no score is sent');
    } catch (e) { console.error(`  ✗ Claude path with a real reply\n    ${e.message}`); process.exitCode = 1; }
  } finally { llm.getClient = getClient; }
  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
})();
