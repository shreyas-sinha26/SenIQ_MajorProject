/**
 * Offline tests for Postgres DATE columns on the US smart-money paths. `pg` turns a DATE into
 * a JS Date at LOCAL midnight, so east of GMT its UTC day (what JSON and toISOString() show)
 * is the day before. Every query that hands a DATE to the browser or to Ask must select it
 * as text. The stand-in database below does what `pg` does: a DATE column comes back as a
 * local-midnight Date unless the statement casts it with `col::text AS col`. The clock is
 * pinned to IST (UTC+5:30), where the bug shows. No network, no real database.
 */
process.env.TZ = 'Asia/Kolkata';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');

const DATE_COLUMNS = ['period_of_report', 'filed_at', 'transaction_date', 'disclosure_date', 'max_filed', 'brief_date'];
const FILING = { id: 7, accession: '0001-26-000001', period_of_report: '2025-12-31', filed_at: '2026-02-14', holdings_count: 40, total_value: '1000' };
const TRADE = { politician: 'Jane Doe', chamber: 'house', party: 'D', state: 'CA', ticker: 'AAPL', asset_description: 'Apple Inc', transaction_type: 'purchase', transaction_date: '2026-06-01', disclosure_date: '2026-06-25', amount_range: '$1,001 - $15,000', amount_min: 1001, amount_max: 15000, is_sample: false };

// What `pg` hands back for a stored row, given the statement that selected it.
function asPg(sql, row) {
  const out = { ...row };
  for (const col of DATE_COLUMNS) {
    if (out[col] == null) continue;
    const cast = new RegExp(`${col}(\\))?::text AS ${col}\\b`).test(sql) || new RegExp(`\\)::text AS ${col}\\b`).test(sql);
    if (!cast) { const [y, m, d] = out[col].split('-').map(Number); out[col] = new Date(y, m - 1, d); }
  }
  return out;
}
async function run(sql) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/max\(filed_at\)/.test(q)) return [asPg(q, { n: 1, max_filed: FILING.filed_at })];
  if (/FROM institution_holdings h/.test(q) && /f\.filed_at/.test(q)) return [asPg(q, { name: 'Fund A', ticker: 'AAPL', change_type: 'added', shares: '10', value: '100', period_of_report: FILING.period_of_report, filed_at: FILING.filed_at })];
  if (/FROM institutions i LEFT JOIN LATERAL/.test(q)) return [asPg(q, { cik: '1', name: 'Fund A', slug: 'fund-a', manager: 'A', following: false, ...FILING })];
  if (q.startsWith('SELECT * FROM institutions WHERE slug')) return [{ id: 1, cik: '1', name: 'Fund A', slug: 'fund-a', manager: 'A' }];
  if (/FROM institution_filings WHERE institution_id/.test(q)) return [asPg(q, FILING)];
  if (/FROM congress_trades/.test(q)) return [asPg(q, TRADE)];
  if (/FROM daily_briefs/.test(q)) return [asPg(q, { id: 3, user_id: 1, brief_date: '2026-06-28', headline: 'h', packet: {} })];
  return []; // holdings, follows, India tables — not under test
}
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: {
    query: run,
    queryOne: async (sql, params) => (await run(sql, params))[0] || null,
    execute: async (sql, params) => ({ rowCount: (await run(sql, params)).length }),
  },
};

const { EXECUTORS } = require('../server/services/qaTools');
const { smartMoneyContext } = require('../server/services/grounding');
const router = require('../server/routes/smartMoney');
const { getLatestBrief, generateBriefForUser } = require('../server/services/reports');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

// Call a route's handler directly (past the auth middleware) and return the body as the
// browser receives it, i.e. after a JSON round trip.
function get(path, req = {}) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve, reject) => {
    const res = { status() { return res; }, json(body) { resolve(JSON.parse(JSON.stringify(body))); } };
    Promise.resolve(handler({ user: { id: 1 }, query: {}, params: {}, tierCfg: {}, ...req }, res, reject)).catch(reject);
  });
}
// public/js/app.js fmtDate()
const fmtDate = (s) => new Date(s).toISOString().slice(0, 10);

section('the stand-in reproduces the bug:');
check('an uncast DATE prints one day early in IST', () => {
  const row = asPg('SELECT filed_at FROM institution_filings', FILING);
  assert.ok(row.filed_at instanceof Date);
  assert.strictEqual(fmtDate(JSON.parse(JSON.stringify(row.filed_at))), '2026-02-13');
});
check('a ::text cast keeps the stored day', () => {
  const row = asPg('SELECT filed_at::text AS filed_at FROM institution_filings', FILING);
  assert.strictEqual(fmtDate(row.filed_at), '2026-02-14');
});

section('\nsmart-money routes send the stored day:');
check('/institutions', async () => {
  const { institutions } = await get('/institutions');
  assert.strictEqual(institutions[0].period_of_report, '2025-12-31');
  assert.strictEqual(institutions[0].filed_at, '2026-02-14');
  assert.strictEqual(fmtDate(institutions[0].period_of_report), '2025-12-31');
});
check('/institutions/:slug', async () => {
  const { filing } = await get('/institutions/:slug', { params: { slug: 'fund-a' } });
  assert.deepStrictEqual(filing, { accession: FILING.accession, period_of_report: '2025-12-31', filed_at: '2026-02-14', holdings_count: 40, total_value: '1000' });
});
check('/congress', async () => {
  const { trades } = await get('/congress', { query: { scope: 'all' } });
  assert.strictEqual(trades[0].transaction_date, '2026-06-01');
  assert.strictEqual(trades[0].disclosure_date, '2026-06-25');
  assert.strictEqual(fmtDate(trades[0].disclosure_date), '2026-06-25');
});

section('\nAsk and the brief quote the stored day:');
check('get_smart_money', async () => {
  const r = await EXECUTORS.get_smart_money({ ticker: 'AAPL' }, { userId: 1, heldSet: new Set(['AAPL']) });
  const text = JSON.stringify(r);
  for (const d of ['2026-06-01', '2026-06-25', '2025-12-31', '2026-02-14']) assert.ok(text.includes(d), `missing ${d}`);
  for (const d of ['2026-05-31', '2026-06-24', '2025-12-30', '2026-02-13']) assert.ok(!text.includes(d), `off by one: ${d}`);
});
check('smartMoneyContext', async () => {
  const r = await smartMoneyContext(1);
  assert.strictEqual(JSON.parse(JSON.stringify(r)).congress[0].date, '2026-06-01');
});

section('\ndaily brief:');
// public/js/app.js renderDailyBrief()
const briefDay = (s, tz) => { const prev = process.env.TZ; process.env.TZ = tz; try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); } finally { process.env.TZ = prev; } };
check('latest and cached briefs carry the stored day, shown the same in any browser timezone', async () => {
  const latest = JSON.parse(JSON.stringify(await getLatestBrief(1)));
  const cached = JSON.parse(JSON.stringify(await generateBriefForUser(1, { now: new Date('2026-06-28T10:00:00Z') })));
  assert.strictEqual(latest.brief_date, '2026-06-28');
  assert.strictEqual(cached.brief_date, '2026-06-28');
  assert.strictEqual(cached.cached, true);
  for (const tz of ['Asia/Kolkata', 'UTC', 'America/Los_Angeles']) assert.strictEqual(briefDay(latest.brief_date, tz), 'Jun 28');
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} DATE column checks passed`);
})();
