/**
 * Offline tests for outcome logging (services/outcomes.js): an outcome is kept when its
 * event is pruned, and still resolves its 1- and 3-day moves without the event. The
 * migrations are read as text and the database is a stand-in. No network, no database.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}

const MIGRATIONS = path.join(__dirname, '..', 'server', 'migrations');
const migrations = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ file: f, sql: fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '') }));

// Whether event_outcomes is still tied to events once every migration has run, in order.
function outcomesLinkedToEvents() {
  let linked = false;
  for (const { sql } of migrations) {
    for (const stmt of sql.split(';')) {
      const s = stmt.replace(/\s+/g, ' ');
      if (/CREATE TABLE (IF NOT EXISTS )?event_outcomes\b/i.test(s)) linked = /REFERENCES events\s*\(/i.test(s);
      else if (/ALTER TABLE event_outcomes\b/i.test(s) && /REFERENCES events\s*\(/i.test(s)) linked = true;
      else if (/ALTER TABLE event_outcomes\b.*DROP CONSTRAINT (IF EXISTS )?event_outcomes_event_id_fkey/i.test(s)) linked = false;
    }
  }
  return linked;
}

console.log('outcomes:');

check('once every migration has run, event_outcomes is no longer tied to events', () => {
  assert.strictEqual(outcomesLinkedToEvents(), false);
});

check('the first migration tied it with a cascade, which is why outcomes went with their events', () => {
  const first = migrations.find((m) => /CREATE TABLE IF NOT EXISTS event_outcomes/.test(m.sql));
  assert.ok(first, 'no migration creates event_outcomes');
  assert.match(first.sql, /REFERENCES events\(id\) ON DELETE CASCADE/);
});

check('pruning events deletes from events only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'events.js'), 'utf8');
  assert.match(src, /DELETE FROM events WHERE last_seen < now\(\)/);
  assert.ok(!/DELETE FROM event_outcomes/.test(src));
});

// A stand-in for db.js and priceService.js: the outcome below belongs to an event that has
// been pruned, so a query that reached for events would find nothing to resolve.
const executed = [];
let lastSelect = '';
const OUTCOME = {
  event_id: 41, primary_ticker: 'NVDA', price_at_event: 100, price_1d: null, price_3d: null,
  logged_at: new Date(Date.now() - 4 * 86_400_000).toISOString(), asset_class: 'equity',
};
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: {
    query: async (sql) => {
      lastSelect = sql;
      return /\bevents\b/.test(sql.replace(/event_outcomes/g, '')) ? [] : [OUTCOME];
    },
    execute: async (sql, params) => { executed.push({ sql, params }); return { rowCount: 1 }; },
  },
};
require.cache[require.resolve('../server/services/priceService')] = {
  id: require.resolve('../server/services/priceService'), filename: require.resolve('../server/services/priceService'), loaded: true,
  exports: { getQuotes: async () => ({ NVDA: { price: 104 } }) },
};
const { resolveOutcomes } = require('../server/services/outcomes');

check('an outcome whose event is gone still resolves its 1- and 3-day moves', async () => {
  const n = await resolveOutcomes();
  assert.ok(!/\bevents\b/.test(lastSelect.replace(/event_outcomes/g, '')), 'resolveOutcomes reads events');
  assert.strictEqual(n, 2);
  const day1 = executed.find((e) => /SET price_1d=/.test(e.sql));
  const day3 = executed.find((e) => /SET price_3d=/.test(e.sql));
  assert.deepStrictEqual(day1.params.slice(0, 3), [41, 104, 0.04]);
  assert.deepStrictEqual(day3.params, [41, 104, 0.04, true]);
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} outcome checks passed`);
})();
