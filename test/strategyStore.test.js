/**
 * Offline tests for what may be saved and deployed (services/strategyStore.js) and for how
 * an engine refusal is worded (services/strategyClient.js). A stand-in database and a
 * stand-in engine: no network, no real database.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');

// ── Stand-in database: just the statements the store issues ──
const db = { strategies: [], deployments: [], statements: 0 };
let nextId = 0;
async function queryOne(sql, params = []) {
  db.statements++;
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q.startsWith('SELECT COUNT(*)::int AS n FROM user_strategies')) return { n: db.strategies.filter((r) => r.user_id === params[0]).length };
  if (q.startsWith('INSERT INTO user_strategies')) {
    const [user_id, name, kind, spec, strategy_name, strategyParams, symbols] = params;
    if (db.strategies.some((r) => r.user_id === user_id && r.name === name)) throw new Error('duplicate key value violates unique constraint "user_strategies_user_id_name_key"');
    const row = { id: ++nextId, user_id, name, kind, spec: spec && JSON.parse(spec), strategy_name, params: strategyParams && JSON.parse(strategyParams), symbols: JSON.parse(symbols) };
    db.strategies.push(row);
    return row;
  }
  if (q.startsWith('SELECT COUNT(*)::int AS n FROM paper_deployments')) return { n: db.deployments.filter((r) => r.user_id === params[0] && r.status === 'active').length };
  if (q.startsWith('SELECT * FROM user_strategies WHERE id = $1 AND user_id = $2')) return db.strategies.find((r) => r.id === Number(params[0]) && r.user_id === params[1]) || null;
  if (q.startsWith('INSERT INTO paper_deployments')) {
    const [user_id, name, kind, spec, strategy_name, strategyParams, symbol, exchange, initial_cash] = params;
    const row = { id: ++nextId, user_id, name, kind, spec, strategy_name, params: strategyParams, symbol, exchange, initial_cash, deployed_at: new Date(2026, 9, 10), status: 'active', stopped_at: null };
    db.deployments.push(row);
    return row;
  }
  if (q.startsWith("UPDATE paper_deployments SET status = 'stopped'")) {
    const row = db.deployments.find((r) => r.id === Number(params[0]) && r.user_id === params[1] && r.status === 'active');
    if (row) { row.status = 'stopped'; row.stopped_at = new Date(2026, 9, 10); }
    return row || null;
  }
  throw new Error(`unexpected statement: ${q.slice(0, 80)}`);
}
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: { queryOne, query: async () => [], execute: async () => ({ rowCount: 0 }) },
};

const { saveStrategy, deployPaper, stopPaper, presetProblem } = require('../server/services/strategyStore');
const { plainEngineError, engineFailure, checkSymbols, ENGINE_OFFLINE } = require('../server/services/strategyClient');

const reset = () => { db.strategies = []; db.deployments = []; db.statements = 0; nextId = 0; };

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

// The catalog as the engine lists it (two entries are enough).
const CATALOG = [
  { name: 'EMACrossover', label: 'EMA Crossover', params: [
    { name: 'fast', type: 'int', default: 12, min: 2, max: 200 },
    { name: 'slow', type: 'int', default: 26, min: 5, max: 400 }] },
  { name: 'RSIMeanReversion', label: 'RSI Mean Reversion', params: [
    { name: 'period', type: 'int', default: 14, min: 2, max: 100 },
    { name: 'oversold', type: 'float', default: 30, min: 1, max: 50 }] },
];
const VALID_SPEC = { name: 'Mine', factors: [{ id: 'f1', fn: 'ema', params: { period: 20 } }], entry: { all: [{ gt: ['close', 'f1'] }] }, exit: { any: [{ lt: ['close', 'f1'] }] } };
// A stand-in engine: answers the catalog and the spec check; counts what it was asked.
function engineStub({ catalogStatus = 200, valid = true } = {}) {
  const calls = [];
  const fn = async (path) => {
    calls.push(path);
    if (path === '/api/strategies') return catalogStatus === 200 ? { status: 200, data: { strategies: CATALOG } } : { status: catalogStatus, data: {} };
    if (path === '/api/strategies/validate') return { status: 200, data: valid ? { valid: true, errors: [] } : { valid: false, errors: ['exit: needs at least one exit condition'] } };
    throw new Error(`unexpected engine call ${path}`);
  };
  fn.calls = calls;
  return fn;
}

section('an engine refusal, in the user\'s terms:');
check('the refusals users met are reworded; an unknown one is passed on as it is', () => {
  assert.match(plainEngineError("interval '1d' lookback 7587d exceeds cap 1825d — narrow the date range or use a coarser interval"), /too long: price history here covers at most 5 years, and this asks for about 20\.8/);
  assert.strictEqual(plainEngineError('end 2025-01-01 before start 2026-01-01'), 'The end date is before the start date.');
  assert.strictEqual(plainEngineError('no bars returned for US:ZZZZQQ 2025-10-10..2026-10-10'), 'No price data for ZZZZQQ on US between 2025-10-10 and 2026-10-10. Check the symbol and the market.');
  assert.match(plainEngineError('unsupported exchange for yfinance: MARS'), /^Unknown market "MARS"\. Use US, NSE, BSE, CRYPTO or COMMODITY\.$/);
  assert.match(plainEngineError('unsupported commodity for yfinance: XYZ'), /No price history for the commodity "XYZ"/);
  assert.strictEqual(plainEngineError('"unknown strategy: \'NoSuchStrategy\'"'), 'There is no built-in strategy called "NoSuchStrategy".');
  assert.strictEqual(plainEngineError('OHLC out of [low,high] for CRYPTO:BTC @ 2026-10-10 00:00:00+05:30'), 'The price data for BTC has a faulty bar on 2026-10-10. Try a range that ends before that date.');
  assert.match(plainEngineError('date range 3d too short for 4 splits (need at least 5 days)'), /too short for the robustness check/);
  assert.strictEqual(plainEngineError('fast must be < slow'), 'fast must be < slow');
  assert.strictEqual(plainEngineError(undefined), '');
  for (const text of ['lookback', 'exceeds cap', 'yfinance', 'no bars returned']) {
    assert.ok(!["interval '1d' lookback 7587d exceeds cap 1825d", 'no bars returned for US:ZZZZQQ 2025-10-10..2026-10-10', 'unsupported exchange for yfinance: MARS'].map(plainEngineError).join(' ').includes(text), `engine wording left in: ${text}`);
  }
});
check('unreachable is "offline" (503); a failure of the engine\'s own is not (502); a refusal keeps its reason', () => {
  assert.deepStrictEqual(engineFailure({ status: 503, data: { detail: 'strategy engine is offline' } }), { status: 503, error: ENGINE_OFFLINE });
  const failed = engineFailure({ status: 500, data: {} });
  assert.strictEqual(failed.status, 502);
  assert.ok(!/offline/i.test(failed.error) && /running/.test(failed.error));
  assert.deepStrictEqual(engineFailure({ status: 400, data: { detail: 'fast must be < slow' } }), { status: 400, error: 'fast must be < slow' });
  assert.deepStrictEqual(engineFailure({ status: 404, data: { detail: '"unknown strategy: \'X\'"' } }), { status: 404, error: 'There is no built-in strategy called "X".' });
  assert.deepStrictEqual(engineFailure({ status: 422, data: { detail: [{ loc: ['body', 'start_date'], msg: 'Input should be a valid date' }] } }), { status: 400, error: 'start_date: Input should be a valid date' });
  assert.deepStrictEqual(engineFailure({ status: 400, data: {} }, 'replay failed'), { status: 400, error: 'replay failed' });
});

section('\na watchlist about to be saved:');
check('symbols are upper-cased, the market defaults to US, and the list is kept whole', () => {
  assert.deepStrictEqual(checkSymbols([{ symbol: ' nvda ' }, { symbol: 'btc', exchange: 'crypto' }, { symbol: 'M&M', exchange: 'NSE' }]),
    { ok: true, symbols: [{ symbol: 'NVDA', exchange: 'US' }, { symbol: 'BTC', exchange: 'CRYPTO' }, { symbol: 'M&M', exchange: 'NSE' }] });
  assert.deepStrictEqual(checkSymbols(undefined), { ok: true, symbols: [] });
  assert.deepStrictEqual(checkSymbols([]), { ok: true, symbols: [] });
});
check('a misspelt market, a non-symbol and a sixth entry are refused with the reason, not dropped', () => {
  assert.match(checkSymbols([{ symbol: 'TSLA', exchange: 'NASDQ' }]).error, /Unknown market "NASDQ" for TSLA/);
  assert.match(checkSymbols([{ symbol: 'not a symbol!' }]).error, /does not look like a symbol/);
  assert.match(checkSymbols([{}]).error, /\(empty\)/);
  assert.match(checkSymbols(Array.from({ length: 6 }, (_, i) => ({ symbol: `S${i}` }))).error, /at most 5 symbols; this one has 6/);
  assert.match(checkSymbols('NVDA').error, /must be a list/);
});

section('\na built-in strategy and its settings:');
check('the name must be in the catalog and each setting one it has, of the right kind, in bounds', () => {
  assert.strictEqual(presetProblem(CATALOG, 'EMACrossover', { fast: 20, slow: 50 }), null);
  assert.strictEqual(presetProblem(CATALOG, 'EMACrossover', {}), null);
  assert.strictEqual(presetProblem(CATALOG, 'EMACrossover', undefined), null);
  assert.strictEqual(presetProblem(CATALOG, 'RSIMeanReversion', { oversold: 27.5, period: '14' }), null);
  assert.strictEqual(presetProblem(CATALOG, 'NoSuchStrategy', {}), 'There is no built-in strategy called "NoSuchStrategy".');
  assert.match(presetProblem(CATALOG, 'EMACrossover', { speed: 3 }), /has no setting called "speed"\. It has: fast, slow\./);
  assert.strictEqual(presetProblem(CATALOG, 'EMACrossover', { fast: 'quick' }), 'fast must be a number.');
  assert.strictEqual(presetProblem(CATALOG, 'EMACrossover', { fast: 2.5 }), 'fast must be a whole number.');
  assert.strictEqual(presetProblem(CATALOG, 'EMACrossover', { fast: 1 }), 'fast is 1; it must be at least 2.');
  assert.strictEqual(presetProblem(CATALOG, 'EMACrossover', { slow: 9999 }), 'slow is 9999; it must be at most 400.');
  assert.match(presetProblem(CATALOG, 'EMACrossover', [20, 50]), /params must be an object/);
});

section('\nsaving:');
const USER = 7;
check('a preset the engine does not have is refused and nothing is stored', async () => {
  reset();
  const out = await saveStrategy(USER, { name: 'Bogus', strategy: 'NoSuchStrategy', params: {} }, { engine: engineStub() });
  assert.deepStrictEqual([out.ok, out.status, out.error], [false, 400, 'There is no built-in strategy called "NoSuchStrategy".']);
  assert.strictEqual(db.strategies.length, 0);
});
check('a preset with a setting out of bounds is refused; a good one is stored with its watchlist', async () => {
  reset();
  const bad = await saveStrategy(USER, { name: 'Fast', strategy: 'EMACrossover', params: { fast: 0 } }, { engine: engineStub() });
  assert.deepStrictEqual([bad.ok, bad.status], [false, 400]);
  const good = await saveStrategy(USER, { name: 'EMA 20/50', strategy: 'EMACrossover', params: { fast: 20, slow: 50 }, symbols: [{ symbol: 'aapl' }, { symbol: 'btc', exchange: 'crypto' }] }, { engine: engineStub() });
  assert.strictEqual(good.ok, true);
  assert.deepStrictEqual(good.data.symbols, [{ symbol: 'AAPL', exchange: 'US' }, { symbol: 'BTC', exchange: 'CRYPTO' }]);
  assert.strictEqual(db.strategies.length, 1);
});
check('a bad watchlist is refused before the engine is asked anything', async () => {
  reset();
  const engine = engineStub();
  const out = await saveStrategy(USER, { name: 'X', strategy: 'EMACrossover', symbols: [{ symbol: 'TSLA', exchange: 'MARS' }] }, { engine });
  assert.deepStrictEqual([out.ok, out.status, engine.calls.length, db.strategies.length], [false, 400, 0, 0]);
  assert.match(out.error, /Unknown market "MARS"/);
});
check('engine offline → 503 "offline"; an engine failure → 502, not "offline"; neither stores', async () => {
  reset();
  const off = await saveStrategy(USER, { name: 'X', strategy: 'EMACrossover' }, { engine: engineStub({ catalogStatus: 503 }) });
  assert.deepStrictEqual([off.status, off.error], [503, ENGINE_OFFLINE]);
  const failed = await saveStrategy(USER, { name: 'X', strategy: 'EMACrossover' }, { engine: engineStub({ catalogStatus: 500 }) });
  assert.strictEqual(failed.status, 502);
  assert.ok(!/offline/i.test(failed.error));
  assert.strictEqual(db.strategies.length, 0);
});
check('a Builder spec is still checked by the engine; a duplicate name is a plain 400', async () => {
  reset();
  const invalid = await saveStrategy(USER, { custom: VALID_SPEC }, { engine: engineStub({ valid: false }) });
  assert.deepStrictEqual([invalid.ok, invalid.status], [false, 400]);
  assert.match(invalid.error, /invalid strategy: exit: needs at least one exit condition/);
  assert.strictEqual((await saveStrategy(USER, { custom: VALID_SPEC }, { engine: engineStub() })).ok, true);
  const dup = await saveStrategy(USER, { custom: VALID_SPEC }, { engine: engineStub() });
  assert.deepStrictEqual([dup.ok, dup.status], [false, 400]);
  assert.match(dup.error, /already have a strategy named “Mine”/);
});

section('\ndeploying:');
const okReplay = () => { const fn = async (row) => { fn.rows.push(row); return { status: 200, data: { fills: [], report: { equity_curve: [] } } }; }; fn.rows = []; return fn; };
async function withSaved() {
  reset();
  const saved = await saveStrategy(USER, { name: 'EMA 20/50', strategy: 'EMACrossover', params: { fast: 20, slow: 50 } }, { engine: engineStub() });
  db.statements = 0;
  return saved.data.id;
}
check('a symbol, market, cash or strategy id that cannot be right is refused before any replay', async () => {
  const id = await withSaved();
  const replay = okReplay();
  const cases = [
    [{ strategy_id: id, symbol: 'not a symbol!' }, 400, /does not look like a symbol/],
    [{ strategy_id: id, symbol: 'AAPL', exchange: 'MARS' }, 400, /Unknown market "MARS"\. Use US, NSE, BSE, CRYPTO or COMMODITY\./],
    [{ strategy_id: id, symbol: 'AAPL', initial_cash: '1e30' }, 400, /between 1,000 and 100,000,000/],
    [{ strategy_id: id, symbol: 'AAPL', initial_cash: 0 }, 400, /between 1,000 and 100,000,000/],
    [{ strategy_id: 'abc', symbol: 'AAPL' }, 404, /saved strategy not found/],
    [{ strategy_id: '1; DROP TABLE users', symbol: 'AAPL' }, 404, /saved strategy not found/],
    [{ strategy_id: 99999999999999999999, symbol: 'AAPL' }, 404, /saved strategy not found/],
    [{ symbol: 'AAPL' }, 400, /strategy_id and symbol are required/],
  ];
  for (const [body, status, text] of cases) {
    const out = await deployPaper(USER, body, { replay });
    assert.deepStrictEqual([out.ok, out.status], [false, status], JSON.stringify(body));
    assert.match(out.error, text);
  }
  assert.deepStrictEqual([replay.rows.length, db.deployments.length, db.statements], [0, 0, 0]); // not one statement reached the database
});
check('a symbol with no price data is refused with the reason, and nothing is stored', async () => {
  const id = await withSaved();
  const out = await deployPaper(USER, { strategy_id: id, symbol: 'ZZZZQQ', exchange: 'US' },
    { replay: async () => ({ status: 400, data: { detail: 'no bars returned for US:ZZZZQQ 2025-09-05..2026-10-10' } }) });
  assert.deepStrictEqual([out.ok, out.status], [false, 400]);
  assert.strictEqual(out.error, 'This cannot be deployed: No price data for ZZZZQQ on US between 2025-09-05 and 2026-10-10. Check the symbol and the market.');
  assert.strictEqual(db.deployments.length, 0);
});
check('a saved strategy the engine cannot run is refused (404 from the engine is not "not found")', async () => {
  const id = await withSaved();
  const out = await deployPaper(USER, { strategy_id: id, symbol: 'AAPL' },
    { replay: async () => ({ status: 404, data: { detail: '"unknown strategy: \'EMACrossover\'"' } }) });
  assert.deepStrictEqual([out.ok, out.status, db.deployments.length], [false, 400, 0]);
  assert.match(out.error, /^This cannot be deployed: There is no built-in strategy called/);
});
check('engine offline: no deployment is created unchecked', async () => {
  const id = await withSaved();
  const off = await deployPaper(USER, { strategy_id: id, symbol: 'AAPL' }, { replay: async () => ({ status: 503, data: {} }) });
  assert.deepStrictEqual([off.ok, off.status, db.deployments.length], [false, 503, 0]);
  assert.match(off.error, /offline/);
  const failed = await deployPaper(USER, { strategy_id: id, symbol: 'AAPL' }, { replay: async () => ({ status: 500, data: {} }) });
  assert.deepStrictEqual([failed.status, db.deployments.length], [502, 0]);
});
check('a deployment that replays is stored: symbol and market upper-cased, the trial run as its first day', async () => {
  const id = await withSaved();
  const replay = okReplay();
  const out = await deployPaper(USER, { strategy_id: id, symbol: ' btc ', exchange: 'crypto', initial_cash: '50000' }, { replay });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual([out.data.symbol, out.data.exchange, out.data.initial_cash, out.data.status], ['BTC', 'CRYPTO', '50000', 'active']);
  const trial = replay.rows[0];
  assert.deepStrictEqual([trial.symbol, trial.exchange, trial.strategy_name, trial.status], ['BTC', 'CRYPTO', 'EMACrossover', 'active']);
  assert.deepStrictEqual(trial.params, { fast: 20, slow: 50 });
  assert.ok(trial.deployed_at instanceof Date);
  assert.strictEqual(db.deployments.length, 1);
  const dflt = await deployPaper(USER, { strategy_id: String(id), symbol: 'AAPL' }, { replay });
  assert.deepStrictEqual([dflt.ok, dflt.data.exchange, dflt.data.initial_cash], [true, 'US', '100000']);
});

section('\nstopping:');
check('an id no deployment can have is "not found" without asking the database', async () => {
  reset();
  for (const id of ['abc', '0', '-1', '1.5', 0, -3, 1e30, null, undefined]) {
    const out = await stopPaper(USER, id);
    assert.deepStrictEqual([out.ok, out.status], [false, 404], String(id));
  }
  assert.strictEqual(db.statements, 0);
});
check('an active deployment of one\'s own stops; someone else\'s does not', async () => {
  const id = await withSaved();
  const dep = (await deployPaper(USER, { strategy_id: id, symbol: 'AAPL' }, { replay: okReplay() })).data;
  assert.strictEqual((await stopPaper(USER + 1, dep.id)).status, 404);
  const out = await stopPaper(USER, String(dep.id));
  assert.deepStrictEqual([out.ok, out.data.status], [true, 'stopped']);
  assert.strictEqual((await stopPaper(USER, dep.id)).status, 404); // already stopped
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} strategy store checks passed`);
})();
