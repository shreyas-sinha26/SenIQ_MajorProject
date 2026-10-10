/**
 * Offline tests for the checks that stand between a request and the database: route ids,
 * plan names, and what a database error is allowed to print. No network, no database.
 * Run: node test/inputs.test.js   (also chained into `npm test`)
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const util = require('node:util');
const { isId, idParam } = require('../server/middleware/idParam');
const { isTier, tierConfig } = require('../server/middleware/tier');
const { hideRowData } = require('../server/db');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('inputs:');

check('a route id is a plain positive whole number', () => {
  for (const ok of ['1', '42', '999999999', 7]) assert.strictEqual(isId(ok), true, String(ok));
  // Each of these reached Postgres before and came back as a 500.
  for (const bad of ['abc', '', '0', '-1', '1.5', '1e3', '0x10', ' 5', '5 ', '01', '1000000000', '99999999999999999999', 0, -3, 1.5, 1e9, NaN, null, undefined, {}, ['1']]) {
    assert.strictEqual(isId(bad), false, JSON.stringify(bad));
  }
});

check('a bad route id is answered 404 and never reaches the handler', () => {
  const calls = [];
  const res = { status(code) { calls.push(code); return this; }, json(body) { calls.push(body); return this; } };
  let reached = false;
  idParam('Alert not found')({}, res, () => { reached = true; }, 'abc');
  assert.deepStrictEqual(calls, [404, { error: 'Alert not found' }]);
  assert.strictEqual(reached, false);
  idParam()({}, res, () => { reached = true; }, '12');
  assert.strictEqual(reached, true);
});

check('a plan name is one of ours, not anything an object answers to', () => {
  for (const ok of ['free', 'plus', 'pro']) assert.strictEqual(isTier(ok), true, ok);
  // TIERS['constructor'] and TIERS['__proto__'] are truthy: both passed the old check.
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'enterprise', 'PRO', '', null, undefined, 1, {}]) {
    assert.strictEqual(isTier(bad), false, JSON.stringify(bad));
  }
  assert.strictEqual(tierConfig('constructor').label, 'Free');
  assert.strictEqual(tierConfig('pro').label, 'Pro');
});

check('a database error prints without the row it refused', () => {
  const err = Object.assign(new Error('new row for relation "users" violates check constraint'), {
    code: '23514', constraint: 'users_subscription_tier_check',
    detail: 'Failing row contains (45, someone@example.test, $2a$10$secrethashsecrethash, ...).',
    where: "unnamed portal parameter $1 = 'secret'",
  });
  hideRowData(err);
  const printed = util.inspect(err);
  assert.ok(!printed.includes('secrethash') && !printed.includes('someone@example.test') && !printed.includes("'secret'"), printed);
  assert.ok(printed.includes('users_subscription_tier_check') && printed.includes('23514'));   // what a log needs is still there
  assert.ok(err.detail.includes('Failing row'));                                              // and code can still read it
  assert.ok(!JSON.stringify(err).includes('secrethash'));
  assert.strictEqual(hideRowData(null), null);
});

console.log(`\n${passed} input checks passed`);
