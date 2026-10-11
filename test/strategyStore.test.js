/**
 * Offline tests for what may be saved and deployed (services/strategyStore.js) and for how
 * an engine refusal is worded (services/strategyClient.js). A stand-in database and a
 * stand-in engine: no network, no real database.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');

// ── Stand-in database: just the statements the store issues ──
const db = { strategies: [], deployments: [], statements: 0, lockKeys: [] };
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
  if (q.startsWith('SELECT id FROM paper_deployments WHERE user_id = $1 AND status = \'active\' AND name = $2')) {
    const [user_id, name, symbol, exchange, cash] = params;
    return db.deployments.find((r) => r.user_id === user_id && r.status === 'active' && r.name === name && r.symbol === symbol && r.exchange === exchange && r.initial_cash === cash) || null;
  }
  if (q.startsWith("UPDATE paper_deployments SET status = 'stopped'")) {
    const row = db.deployments.find((r) => r.id === Number(params[0]) && r.user_id === params[1] && r.status === 'active');
    if (row) { row.status = 'stopped'; row.stopped_at = new Date(2026, 9, 10); }
    return row || null;
  }
  throw new Error(`unexpected statement: ${q.slice(0, 80)}`);
}
// db.locked: one caller at a time per key, as the advisory lock gives; the client it hands
// over answers the same statements. `db.lockKeys` records the keys asked for.
const queues = new Map();
async function locked(key, fn) {
  db.lockKeys.push(key);
  const turn = (queues.get(key) || Promise.resolve()).then(() => fn({ query: async (sql, params) => { const row = await queryOne(sql, params); return { rows: row ? [row] : [] }; } }));
  queues.set(key, turn.catch(() => {}));
  return turn;
}
require.cache[require.resolve('../server/db')] = {
  id: require.resolve('../server/db'), filename: require.resolve('../server/db'), loaded: true,
  exports: { queryOne, locked, query: async () => [], execute: async () => ({ rowCount: 0 }) },
};

const { saveStrategy, deployPaper, stopPaper, presetProblem } = require('../server/services/strategyStore');
const { plainEngineError, engineFailure, checkSymbols, checkRun, parseSplits, shapeCatalog, ENGINE_OFFLINE } = require('../server/services/strategyClient');
const { runBacktest, runWalkForward } = require('../server/services/strategyRuns');

const reset = () => { db.strategies = []; db.deployments = []; db.statements = 0; db.lockKeys = []; nextId = 0; };

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
// `check`: what the engine's own build of a preset says ({ status, data }); `slowMs` makes
// every answer take that long, so several saves sent together all pass the first count.
function engineStub({ catalogStatus = 200, valid = true, check = { status: 200, data: { valid: true, error: null } }, slowMs = 0 } = {}) {
  const calls = [];
  const fn = async (path, opts = {}) => {
    calls.push(path);
    fn.bodies.push(opts.body);
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    if (path === '/api/strategies') return catalogStatus === 200 ? { status: 200, data: { strategies: CATALOG } } : { status: catalogStatus, data: {} };
    if (path === '/api/strategies/validate') return { status: 200, data: valid ? { valid: true, errors: [] } : { valid: false, errors: ['exit: needs at least one exit condition'] } };
    if (path === '/api/strategies/check') return check;
    if (path === '/api/backtest' || path === '/api/walk-forward') return { status: 200, data: { ran: path } };
    throw new Error(`unexpected engine call ${path}`);
  };
  fn.calls = calls;
  fn.bodies = [];
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
  assert.strictEqual(plainEngineError('some refusal nobody has met yet'), 'some refusal nobody has met yet');
  assert.strictEqual(plainEngineError(undefined), '');
  // v2 L2 of the QA pass on v2.18: the engine's own wording that still reached the page.
  assert.strictEqual(plainEngineError("invalid literal for int() with base 10: 'abc'"), 'A setting that must be a whole number was given "abc".');
  assert.strictEqual(plainEngineError('start_date: Input should be a valid date or datetime, input is too short'), 'start_date must be a date written YYYY-MM-DD.');
  assert.strictEqual(plainEngineError('fast period must be < slow period'), 'The fast period must be shorter than the slow period.');
  assert.strictEqual(plainEngineError('MACD fast must be < slow'), 'The fast period must be shorter than the slow period.');
  assert.strictEqual(plainEngineError('invalid strategy spec: entry.all: must be a non-empty list'), 'This strategy cannot run yet: the entry rule has no conditions');
  for (const text of ['lookback', 'exceeds cap', 'yfinance', 'no bars returned']) {
    assert.ok(!["interval '1d' lookback 7587d exceeds cap 1825d", 'no bars returned for US:ZZZZQQ 2025-10-10..2026-10-10', 'unsupported exchange for yfinance: MARS'].map(plainEngineError).join(' ').includes(text), `engine wording left in: ${text}`);
  }
});
check('unreachable is "offline" (503); a failure of the engine\'s own is not (502); a refusal keeps its reason', () => {
  assert.deepStrictEqual(engineFailure({ status: 503, data: { detail: 'strategy engine is offline' } }), { status: 503, error: ENGINE_OFFLINE });
  const failed = engineFailure({ status: 500, data: {} });
  assert.strictEqual(failed.status, 502);
  assert.ok(!/offline/i.test(failed.error) && /running/.test(failed.error));
  assert.deepStrictEqual(engineFailure({ status: 400, data: { detail: 'a reason of its own' } }), { status: 400, error: 'a reason of its own' });
  assert.deepStrictEqual(engineFailure({ status: 404, data: { detail: '"unknown strategy: \'X\'"' } }), { status: 404, error: 'There is no built-in strategy called "X".' });
  assert.deepStrictEqual(engineFailure({ status: 422, data: { detail: [{ loc: ['body', 'start_date'], msg: 'Input should be a valid date' }] } }), { status: 400, error: 'start_date must be a date written YYYY-MM-DD.' });
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
check('an entry may be written as the page shows it; the same symbol twice is refused', () => {
  assert.deepStrictEqual(checkSymbols(['nvda', 'RELIANCE:NSE']), { ok: true, symbols: [{ symbol: 'NVDA', exchange: 'US' }, { symbol: 'RELIANCE', exchange: 'NSE' }] });
  assert.match(checkSymbols([{ symbol: 'NVDA' }, { symbol: 'nvda', exchange: 'us' }]).error, /NVDA is on the watchlist twice/);
  assert.strictEqual(checkSymbols([{ symbol: 'TCS', exchange: 'NSE' }, { symbol: 'TCS', exchange: 'BSE' }]).ok, true); // two listings are two entries
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

check('settings that cannot go together are refused by the engine\'s own build, in plain words', async () => {
  reset();
  const engine = engineStub({ check: { status: 200, data: { valid: false, error: 'fast period must be < slow period' } } });
  const out = await saveStrategy(USER, { name: 'EMA 50/10', strategy: 'EMACrossover', params: { fast: 50, slow: 10 } }, { engine });
  assert.deepStrictEqual([out.ok, out.status, out.error], [false, 400, 'The fast period must be shorter than the slow period.']);
  assert.deepStrictEqual(engine.bodies[engine.calls.indexOf('/api/strategies/check')], { strategy: 'EMACrossover', params: { fast: 50, slow: 10 } });
  assert.strictEqual(db.strategies.length, 0);
  // An engine from before that check answers 404: the save goes ahead on the catalog check alone.
  const older = await saveStrategy(USER, { name: 'EMA 20/50', strategy: 'EMACrossover', params: { fast: 20, slow: 50 } }, { engine: engineStub({ check: { status: 404, data: {} } }) });
  assert.strictEqual(older.ok, true);
});
check('a spec and a preset together, or a name that is not text, are refused', async () => {
  reset();
  const both = await saveStrategy(USER, { name: 'Both', custom: VALID_SPEC, strategy: 'EMACrossover' }, { engine: engineStub() });
  assert.deepStrictEqual([both.ok, both.status], [false, 400]);
  assert.match(both.error, /not both/);
  for (const name of [12345, { a: 1 }, ['x']]) {
    const out = await saveStrategy(USER, { name, strategy: 'EMACrossover' }, { engine: engineStub() });
    assert.deepStrictEqual([out.ok, out.status, out.error], [false, 400, 'name must be text'], JSON.stringify(name));
  }
  assert.strictEqual(db.strategies.length, 0);
});
check('five saves sent together with one place left: one goes in', async () => {
  reset();
  for (let i = 0; i < 19; i++) db.strategies.push({ id: 1000 + i, user_id: USER, name: `old ${i}` });
  const engine = engineStub({ slowMs: 5 }); // all five pass the first count before any insert
  const outs = await Promise.all([1, 2, 3, 4, 5].map((i) => saveStrategy(USER, { name: `new ${i}`, strategy: 'EMACrossover', params: { fast: 20, slow: 50 } }, { engine })));
  assert.deepStrictEqual(outs.map((o) => o.ok).filter(Boolean).length, 1);
  assert.ok(outs.filter((o) => !o.ok).every((o) => o.status === 400 && /Limit reached \(20 saved strategies\)/.test(o.error)));
  assert.strictEqual(db.strategies.filter((r) => r.user_id === USER).length, 20);
  assert.ok(db.lockKeys.length === 5 && db.lockKeys.every((k) => k === `strategies:${USER}`));
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

check('four deploys sent together with two places left: two go in', async () => {
  const id = await withSaved();
  for (let i = 0; i < 8; i++) db.deployments.push({ id: 2000 + i, user_id: USER, status: 'active', name: 'other', symbol: `S${i}`, exchange: 'US', initial_cash: 100000 });
  const slow = async () => { await new Promise((r) => setTimeout(r, 5)); return { status: 200, data: {} }; }; // all four pass the first count
  const outs = await Promise.all(['AAPL', 'MSFT', 'NVDA', 'GOOGL'].map((symbol) => deployPaper(USER, { strategy_id: id, symbol }, { replay: slow })));
  assert.strictEqual(outs.filter((o) => o.ok).length, 2);
  assert.ok(outs.filter((o) => !o.ok).every((o) => o.status === 400 && /Limit reached \(10 active deployments\)/.test(o.error)));
  assert.strictEqual(db.deployments.filter((r) => r.user_id === USER && r.status === 'active').length, 10);
  assert.ok(db.lockKeys.filter((k) => k === `paper:${USER}`).length === 4);
});
check('the same strategy, symbol and cash a second time the same day is refused; a different cash is not', async () => {
  const id = await withSaved();
  const replay = okReplay();
  assert.strictEqual((await deployPaper(USER, { strategy_id: id, symbol: 'AAPL', initial_cash: 50000 }, { replay })).ok, true);
  const again = await deployPaper(USER, { strategy_id: id, symbol: 'aapl', initial_cash: '50000' }, { replay });
  assert.deepStrictEqual([again.ok, again.status], [false, 400]);
  assert.match(again.error, /already deployed on AAPL with that cash today/);
  assert.strictEqual((await deployPaper(USER, { strategy_id: id, symbol: 'AAPL', initial_cash: 60000 }, { replay })).ok, true);
  assert.strictEqual(db.deployments.length, 2);
});

section('\na one-off run, checked before the engine is asked:');
const RUN = { strategy: 'EMACrossover', params: { fast: 12, slow: 26 }, symbol: 'aapl', start_date: '2025-10-01', end_date: '2026-10-09' };
const noSeniq = async () => null;
check('a symbol, a market and two dates', () => {
  assert.deepStrictEqual(checkRun(RUN), { ok: true, symbol: 'AAPL', exchange: 'US' });
  assert.match(checkRun({ ...RUN, symbol: '<img src=x>' }).error, /does not look like a symbol/);
  assert.match(checkRun({ ...RUN, exchange: 'MARS' }).error, /Unknown market "MARS"/);
  assert.strictEqual(checkRun({ ...RUN, start_date: '2025-02-30' }).error, 'start_date must be a date written YYYY-MM-DD.');
  assert.strictEqual(checkRun({ ...RUN, end_date: 'abc' }).error, 'end_date must be a date written YYYY-MM-DD.');
  assert.strictEqual(checkRun({ ...RUN, start_date: '2026-10-10' }).error, 'The end date is before the start date.');
  assert.deepStrictEqual([undefined, '', '6', 12].map((x) => parseSplits(x).value), [4, 4, 6, 12]);
  for (const bad of [0, 1, 13, 'abc', 2.5, {}]) assert.strictEqual(parseSplits(bad).ok, false, String(bad));
});
check('a backtest with a bad symbol, date, capital or setting never reaches the engine\'s run', async () => {
  const cases = [
    [{ ...RUN, symbol: '<img src=x>' }, /does not look like a symbol/],
    [{ ...RUN, end_date: '2026-13-01' }, /end_date must be a date/],
    [{ ...RUN, initial_cash: 0 }, /Starting capital/],
    [{ ...RUN, params: { fast: 12.7 } }, /fast must be a whole number/],
    [{ ...RUN, params: { turbo: true } }, /has no setting called "turbo"/],
    [{ ...RUN, strategy: 'NoSuchStrategy' }, /There is no built-in strategy called "NoSuchStrategy"/],
    [{ ...RUN, strategy: undefined }, /are required/],
    [{ ...RUN, strategy: undefined, custom: 'spec' }, /custom must be a Builder spec/],
  ];
  for (const [body, text] of cases) {
    const engine = engineStub();
    const out = await runBacktest(body, { engine, seniqData: noSeniq });
    assert.deepStrictEqual([out.ok, out.status], [false, 400], JSON.stringify(body));
    assert.match(out.error, text);
    assert.ok(!engine.calls.includes('/api/backtest'));
  }
});
check('a good backtest goes to the engine with the symbol and market cleaned; a Builder spec skips the preset check', async () => {
  const engine = engineStub();
  const out = await runBacktest({ ...RUN, exchange: 'nasdaq', initial_cash: '50000' }, { engine, seniqData: noSeniq });
  assert.deepStrictEqual(out, { ok: true, data: { ran: '/api/backtest' } });
  assert.deepStrictEqual(engine.bodies[engine.calls.indexOf('/api/backtest')],
    { strategy: 'EMACrossover', custom: null, params: { fast: 12, slow: 26 }, symbol: 'AAPL', exchange: 'NASDAQ', start_date: '2025-10-01', end_date: '2026-10-09', seniq_data: null, initial_cash: '50000' });
  const custom = engineStub();
  const asked = [];
  await runBacktest({ custom: VALID_SPEC, symbol: 'AAPL', start_date: '2025-10-01', end_date: '2026-10-09' }, { engine: custom, seniqData: async (spec, symbol) => { asked.push(symbol); return { sentiment: [] }; } });
  assert.deepStrictEqual(custom.calls, ['/api/backtest']);
  assert.deepStrictEqual([asked, custom.bodies[0].seniq_data, custom.bodies[0].strategy], [['AAPL'], { sentiment: [] }, null]);
});
check('the robustness check refuses a fold count or a scheme it does not have, instead of using 4', async () => {
  for (const [extra, text] of [[{ n_splits: 0 }, /n_splits must be a whole number from 2 to 12/], [{ n_splits: 'abc' }, /n_splits/], [{ scheme: 'sideways' }, /scheme must be/]]) {
    const engine = engineStub();
    const out = await runWalkForward({ ...RUN, ...extra }, { engine, seniqData: noSeniq });
    assert.deepStrictEqual([out.ok, out.status, engine.calls.length], [false, 400, 0], JSON.stringify(extra));
    assert.match(out.error, text);
  }
  const engine = engineStub();
  assert.strictEqual((await runWalkForward({ ...RUN, n_splits: '6' }, { engine, seniqData: noSeniq })).ok, true);
  const sent = engine.bodies[engine.calls.indexOf('/api/walk-forward')];
  assert.deepStrictEqual([sent.n_splits, sent.scheme], [6, 'anchored']);
});

section('\nthe catalog as SenIQ gives it out:');
check('marketplace fields are left out; a list-only plan gets no settings', () => {
  const raw = { strategies: [{ name: 'EMACrossover', version: '1', label: 'EMA Crossover', description: 'd', params: [{ name: 'fast' }], category: 'Trend', style: 'Directional', instrument: 'Equity',
    trading_style: 'Swing Trading', min_capital: 50000, max_capital: 1000000, tags: ['trend'], backtest_defaults: {}, provider: { name: 'SenIQ', deployed_by: 0, algos_in_market: 8, active_since: '2026-01-01' } }], builder: { indicators: ['ema'] } };
  const full = shapeCatalog(raw);
  assert.deepStrictEqual(Object.keys(full.strategies[0]).sort(), ['backtest_defaults', 'category', 'description', 'label', 'name', 'params', 'style', 'tags', 'trading_style', 'version']);
  assert.deepStrictEqual(full.builder, { indicators: ['ema'] });
  const list = shapeCatalog(raw, { settings: false });
  assert.ok(!('params' in list.strategies[0]) && !('backtest_defaults' in list.strategies[0]) && list.settings_hidden === true);
  assert.ok(!/min_capital|algos_in_market|deployed_by|active_since/.test(JSON.stringify([full, list])));
  assert.deepStrictEqual(shapeCatalog(undefined).strategies, []);
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
