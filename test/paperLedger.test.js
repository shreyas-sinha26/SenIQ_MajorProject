/**
 * Offline tests for the paper ledger (services/paperLedger.js): what a replay adds to the
 * stored record, which fills are emailed, and the daily job end to end against a stand-in
 * database and a stand-in engine. No network, no real database, no email.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');

// ── Stand-in database: just the statements the ledger issues ──
const db = { deployments: [], fills: [], equity: [], users: [], emailLog: [] };
let fillId = 0;
async function run(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q.startsWith('SELECT * FROM paper_deployments WHERE ledger_closed_at IS NULL')) {
    const [today, force] = params;
    return db.deployments.filter((d) => !d.ledger_closed_at
      && (force || !d.last_marked_at || d.last_marked_at.toISOString().slice(0, 10) < today));
  }
  if (q.startsWith('UPDATE paper_deployments SET last_mark_error')) {
    db.deployments.find((d) => d.id === params[0]).last_mark_error = params[1];
    return [];
  }
  if (q.startsWith('UPDATE paper_deployments SET last_marked_at')) {
    const d = db.deployments.find((x) => x.id === params[0]);
    d.last_marked_at = NOW; d.last_mark_error = null;
    if (params[1]) d.ledger_note = params[1];
    if (params[2]) d.ledger_closed_at = NOW;
    return [];
  }
  if (q.startsWith('SELECT filled_at, filled_on::text AS filled_on, side FROM paper_fills')) {
    return db.fills.filter((f) => f.deployment_id === params[0]);
  }
  if (q.startsWith('SELECT max(day)::text AS day FROM paper_equity')) {
    const days = db.equity.filter((e) => e.deployment_id === params[0]).map((e) => e.day).sort();
    return [{ day: days[days.length - 1] || null }];
  }
  if (q.startsWith('INSERT INTO paper_fills')) {
    const [deployment_id, filled_at, filled_on, side, quantity, price, charges, notify] = params;
    if (db.fills.some((f) => f.deployment_id === deployment_id && f.filled_at === filled_at && f.side === side)) return [];
    db.fills.push({ id: ++fillId, deployment_id, filled_at, filled_on, side, quantity, price, charges, notify });
    return [];
  }
  if (q.startsWith('INSERT INTO paper_equity')) {
    const [deployment_id, day, equity, cash, positions_value] = params;
    if (!db.equity.some((e) => e.deployment_id === deployment_id && e.day === day)) db.equity.push({ deployment_id, day, equity, cash, positions_value });
    return [];
  }
  if (q.startsWith("UPDATE paper_fills SET notify = 'skipped' WHERE notify = 'pending'")) {
    for (const f of db.fills) if (f.notify === 'pending' && f.filled_on < params[0]) f.notify = 'skipped';
    return [];
  }
  if (q.startsWith('UPDATE paper_fills SET notify = $2')) {
    for (const f of db.fills) if (params[0].includes(f.id)) f.notify = params[1];
    return [];
  }
  if (/FROM paper_fills f JOIN paper_deployments d/.test(q)) {
    return db.fills.filter((f) => f.notify === 'pending').map((f) => {
      const d = db.deployments.find((x) => x.id === f.deployment_id);
      return { ...f, user_id: d.user_id, name: d.name, symbol: d.symbol, exchange: d.exchange };
    });
  }
  if (q.startsWith('SELECT email, email_verified, email_alerts, subscription_tier FROM users')) {
    return db.users.filter((u) => u.id === params[0]);
  }
  if (q.startsWith('INSERT INTO email_log')) { db.emailLog.push(params); return []; }
  throw new Error(`unexpected statement: ${q.slice(0, 80)}`);
}
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: {
    query: run,
    queryOne: async (sql, params) => (await run(sql, params))[0] || null,
    execute: async (sql, params) => ({ rowCount: (await run(sql, params)).length }),
  },
};

const {
  planLedger, notifyState, recipientBlock, buildFillEmail, runPaperMarks, addDays,
} = require('../server/services/paperLedger');

const NOW = new Date('2026-10-09T01:15:00Z');
const TODAY = '2026-10-09';

const fill = (day, side, quantity = 10, price = '100.00') => ({ timestamp: `${day}T09:30:00-04:00`, symbol: 'AAPL', side, quantity, price, charges: '1.00' });
const point = (day, equity) => ({ timestamp: `${day}T09:30:00-04:00`, equity: String(equity), cash: '0', positions_value: String(equity), exposed: true });
const replayOf = (fills, days) => ({ fills, report: { equity_curve: days } });
const deployment = (over = {}) => ({
  id: 1, user_id: 7, name: 'EMA cross', kind: 'registry', strategy_name: 'EMACrossover', symbol: 'AAPL',
  exchange: 'US', initial_cash: '100000', deployed_at: new Date(2026, 9, 1), status: 'active', stopped_at: null,
  last_marked_at: null, last_mark_error: null, ledger_closed_at: null, ledger_note: null, ...over,
});
const reset = () => { db.deployments = []; db.fills = []; db.equity = []; db.users = []; db.emailLog = []; fillId = 0; };

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

section('planLedger:');

check('an empty ledger takes every completed fill and day', () => {
  const plan = planLedger(
    replayOf([fill('2026-10-05', 'BUY'), fill('2026-10-07', 'SELL')], [point('2026-10-05', 100000), point('2026-10-06', 101000), point('2026-10-07', 102000)]),
    { fills: [], lastDay: null }, TODAY);
  assert.deepStrictEqual(plan.fills.map((f) => `${f.filled_on} ${f.side}`), ['2026-10-05 BUY', '2026-10-07 SELL']);
  assert.deepStrictEqual(plan.equity.map((p) => p.day), ['2026-10-05', '2026-10-06', '2026-10-07']);
  assert.strictEqual(plan.note, null);
});

check('a fill and a day dated today are left for a later run', () => {
  const plan = planLedger(
    replayOf([fill('2026-10-08', 'BUY'), fill(TODAY, 'SELL')], [point('2026-10-08', 100000), point(TODAY, 99000)]),
    { fills: [], lastDay: null }, TODAY);
  assert.deepStrictEqual(plan.fills.map((f) => f.filled_on), ['2026-10-08']);
  assert.deepStrictEqual(plan.equity.map((p) => p.day), ['2026-10-08']);
});

check('only what is newer than the record is added', () => {
  const plan = planLedger(
    replayOf([fill('2026-10-05', 'BUY'), fill('2026-10-07', 'SELL')], [point('2026-10-05', 100000), point('2026-10-06', 101000), point('2026-10-07', 102000)]),
    { fills: [{ filled_at: '2026-10-05T09:30:00-04:00', filled_on: '2026-10-05', side: 'BUY' }], lastDay: '2026-10-06' }, TODAY);
  assert.deepStrictEqual(plan.fills.map((f) => `${f.filled_on} ${f.side}`), ['2026-10-07 SELL']);
  assert.deepStrictEqual(plan.equity.map((p) => p.day), ['2026-10-07']);
  assert.strictEqual(plan.note, null);
});

check('a revised history cannot add an older trade, and leaves a note', () => {
  // Recorded: bought on the 6th. Today's replay says it bought on the 5th instead.
  const plan = planLedger(
    replayOf([fill('2026-10-05', 'BUY'), fill('2026-10-07', 'SELL')], []),
    { fills: [{ filled_at: '2026-10-06T09:30:00-04:00', filled_on: '2026-10-06', side: 'BUY' }], lastDay: null }, TODAY);
  assert.deepStrictEqual(plan.fills.map((f) => `${f.filled_on} ${f.side}`), ['2026-10-07 SELL']);
  assert.match(plan.note, /no longer matches the recorded trades/);
});

check('a changed price alone is not a mismatch', () => {
  const plan = planLedger(
    replayOf([fill('2026-10-05', 'BUY', 9, '99.10')], []),
    { fills: [{ filled_at: '2026-10-05T09:30:00-04:00', filled_on: '2026-10-05', side: 'BUY' }], lastDay: null }, TODAY);
  assert.strictEqual(plan.note, null);
  assert.strictEqual(plan.fills.length, 0);
});

check('an intraday curve stores the last value of each day', () => {
  const plan = planLedger(replayOf([], [
    { ...point('2026-10-07', 100000), timestamp: '2026-10-07T10:00:00-04:00' },
    { ...point('2026-10-07', 100500), timestamp: '2026-10-07T15:55:00-04:00' },
  ]), { fills: [], lastDay: null }, TODAY);
  assert.deepStrictEqual(plan.equity.map((p) => p.equity), ['100500']);
});

section('who is emailed:');

check('a fill is emailed only when recent and the deployment is running', () => {
  assert.strictEqual(notifyState({ filled_on: '2026-10-08' }, { status: 'active' }, TODAY), 'pending');
  assert.strictEqual(notifyState({ filled_on: addDays(TODAY, -3) }, { status: 'active' }, TODAY), 'pending');
  assert.strictEqual(notifyState({ filled_on: addDays(TODAY, -4) }, { status: 'active' }, TODAY), 'none');
  assert.strictEqual(notifyState({ filled_on: '2026-10-08' }, { status: 'stopped' }, TODAY), 'none');
});

check('recipient rules: Pro, verified, alert emails on', () => {
  const ok = { email: 'a@b.co', email_verified: true, email_alerts: true, subscription_tier: 'pro' };
  assert.strictEqual(recipientBlock(ok), null);
  assert.strictEqual(recipientBlock({ ...ok, subscription_tier: 'plus' }), 'not_pro');
  assert.strictEqual(recipientBlock({ ...ok, email_verified: false }), 'unverified');
  assert.strictEqual(recipientBlock({ ...ok, email_alerts: false }), 'unsubscribed');
  assert.strictEqual(recipientBlock(null), 'no_address');
});

check('the email names the trade, says it is simulated, and escapes the strategy name', () => {
  const one = buildFillEmail([{ filled_on: '2026-10-08', name: 'A <b>', side: 'BUY', quantity: 12, symbol: 'RELIANCE', exchange: 'NSE', price: '2890.5' }], { unsubscribeUrl: 'https://x/unsub' });
  assert.match(one.subject, /Paper trade: A <b> bought 12 RELIANCE:NSE/);
  assert.match(one.text, /bought 12 RELIANCE:NSE at 2,890\.50/);
  assert.match(one.text, /simulated/);
  assert.ok(!one.html.includes('A <b>') && one.html.includes('A &lt;b&gt;'));
  assert.match(one.html, /https:\/\/x\/unsub/);
  const two = buildFillEmail([
    { filled_on: '2026-10-08', name: 'A', side: 'BUY', quantity: 1, symbol: 'AAPL', exchange: 'US', price: '1' },
    { filled_on: '2026-10-08', name: 'B', side: 'SELL', quantity: 2, symbol: 'MSFT', exchange: 'US', price: '2' },
  ]);
  assert.match(two.subject, /2 paper trades filled/);
  assert.match(two.text, /B: sold 2 MSFT at 2\.00/);
});

section('the daily job:');

const proUser = { id: 7, email: 'pro@example.com', email_verified: true, email_alerts: true, subscription_tier: 'pro' };
const engine = (data) => async () => ({ status: 200, data });

check('first run records history without emailing it; a fresh fill is emailed once', async () => {
  reset();
  db.deployments.push(deployment());
  db.users.push(proUser);
  const sent = [];
  const sendEmailFn = async (m) => { sent.push(m); return { delivered: true }; };
  const day1 = replayOf([fill('2026-10-02', 'BUY'), fill('2026-10-08', 'SELL')], [point('2026-10-02', 100000), point('2026-10-08', 104000)]);

  const r = await runPaperMarks({ today: TODAY, replayFn: engine(day1), sendEmailFn, emailEnabledFn: () => true });
  assert.deepStrictEqual([r.due, r.marked, r.fills, r.days], [1, 1, 2, 2]);
  assert.deepStrictEqual(db.fills.map((f) => f.notify), ['none', 'sent']); // the 2nd is a week old; the 8th is fresh
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'pro@example.com');
  assert.strictEqual(sent[0].kind, 'paper_fill');
  assert.match(sent[0].subject, /sold 10 AAPL/);

  // Same day again: already marked, nothing due, nothing re-sent.
  const again = await runPaperMarks({ today: TODAY, replayFn: engine(day1), sendEmailFn, emailEnabledFn: () => true });
  assert.strictEqual(again.due, 0);
  assert.strictEqual(sent.length, 1);

  // Next day, same replay: due again, but the record already holds everything.
  const next = await runPaperMarks({ today: '2026-10-10', replayFn: engine(day1), sendEmailFn, emailEnabledFn: () => true });
  assert.deepStrictEqual([next.due, next.marked, next.fills, next.days], [1, 1, 0, 0]);
  assert.strictEqual(db.fills.length, 2);
  assert.strictEqual(sent.length, 1);
});

check('engine offline: nothing stored, the error is kept, and the deployment stays due', async () => {
  reset();
  db.deployments.push(deployment(), deployment({ id: 2 }));
  let calls = 0;
  const offline = async () => { calls++; return { status: 503, data: { detail: 'strategy engine is offline' } }; };
  const r = await runPaperMarks({ today: TODAY, replayFn: offline });
  assert.strictEqual(calls, 1); // the second deployment is not tried against a dead engine
  assert.deepStrictEqual(r.failed, [{ id: 1, error: 'strategy engine is offline' }]);
  assert.strictEqual(db.deployments[0].last_mark_error, 'strategy engine is offline');
  assert.strictEqual(db.deployments[0].last_marked_at, null);
  assert.strictEqual(db.fills.length + db.equity.length, 0);
  const retry = await runPaperMarks({ today: TODAY, replayFn: engine(replayOf([], [point('2026-10-08', 100000)])) });
  assert.deepStrictEqual([retry.due, retry.marked], [2, 2]);
  assert.strictEqual(db.deployments[0].last_mark_error, null);
});

check('an engine without a fills list is refused, not read as "no trades"', async () => {
  reset();
  db.deployments.push(deployment());
  const r = await runPaperMarks({ today: TODAY, replayFn: engine({ report: { equity_curve: [point('2026-10-08', 100000)] } }) });
  assert.strictEqual(r.marked, 0);
  assert.match(r.failed[0].error, /older than the ledger/);
  assert.strictEqual(db.equity.length, 0);
});

check('a stopped deployment is recorded through its stop date, then left alone', async () => {
  reset();
  db.deployments.push(deployment({ status: 'stopped', stopped_at: new Date(2026, 9, 7) }));
  db.users.push(proUser);
  const sent = [];
  const r = await runPaperMarks({
    today: TODAY, replayFn: engine(replayOf([fill('2026-10-07', 'BUY')], [point('2026-10-07', 100000)])),
    sendEmailFn: async (m) => { sent.push(m); return { delivered: true }; }, emailEnabledFn: () => true,
  });
  assert.strictEqual(r.marked, 1);
  assert.ok(db.deployments[0].ledger_closed_at);
  assert.strictEqual(sent.length, 0); // a stopped deployment's fills are history
  const later = await runPaperMarks({ today: '2026-10-10', replayFn: engine(replayOf([], [])) });
  assert.strictEqual(later.due, 0);
});

check('a user who may not be emailed: fills settle as skipped and the refusal is logged', async () => {
  reset();
  db.deployments.push(deployment());
  db.users.push({ ...proUser, subscription_tier: 'plus' });
  const sent = [];
  const r = await runPaperMarks({
    today: TODAY, replayFn: engine(replayOf([fill('2026-10-08', 'BUY')], [])),
    sendEmailFn: async (m) => { sent.push(m); return { delivered: true }; }, emailEnabledFn: () => true,
  });
  assert.deepStrictEqual(r.emails, { sent: 0, skipped: 1, failed: 0 });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(db.fills[0].notify, 'skipped');
  assert.strictEqual(db.emailLog.length, 1);
});

check('an undelivered email stays pending and is retried while the fill is fresh', async () => {
  reset();
  db.deployments.push(deployment());
  db.users.push(proUser);
  const replay = engine(replayOf([fill('2026-10-08', 'BUY')], []));
  const r = await runPaperMarks({ today: TODAY, replayFn: replay, sendEmailFn: async () => ({ delivered: false, reason: 'network' }), emailEnabledFn: () => true });
  assert.strictEqual(r.emails.failed, 1);
  assert.strictEqual(db.fills[0].notify, 'pending');
  const sent = [];
  await runPaperMarks({ today: '2026-10-10', replayFn: replay, sendEmailFn: async (m) => { sent.push(m); return { delivered: true }; }, emailEnabledFn: () => true });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(db.fills[0].notify, 'sent');
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} paper ledger checks passed`);
})();
