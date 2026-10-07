/**
 * Builder-spec validation in the app — a mirror of the engine's validate_spec
 * (strategy-service/engine/strategy/schema_strategy.py).
 *
 * Why a second validator: a strategy DRAFT written by the Ask agent has to be checked before
 * the user sees it, and that must work when the engine is not running. The engine stays the
 * authority — when it is reachable, callers ask it too and its verdict wins.
 *
 * Deliberately a little STRICTER than the engine: indicator parameter names are checked per
 * indicator (the engine accepts any integer parameter and fails later, at run time), MACD's
 * fast must be below slow, unknown SenIQ parameters are rejected, and a declared factor must
 * be used. A draft that passes here should always pass there; the reverse need not hold.
 *
 * If the engine's vocabulary changes (a new indicator, operator or SenIQ metric), change it
 * here too — test/strategyDraft.test.js pins this list against the Builder presets.
 */

// Indicator → its integer parameters.
const INDICATORS = {
  sma: ['period'], ema: ['period'], rsi: ['period'], highest: ['period'], lowest: ['period'], roc: ['period'],
  macd: ['fast', 'slow'], macd_signal: ['fast', 'slow', 'signal'],
};
const BUILTIN_FACTORS = new Set(['price', 'close', 'volume']);
const SENIQ_METRICS = new Set([
  'sentiment_avg', 'sentiment_acute', 'sentiment_zscore', 'news_volume',
  'congress_net_buys', 'congress_buys', 'congress_sells', 'congress_buyers',
  'funds_holding', 'funds_net_adds', 'funds_new_positions',
]);
const COMPARISON_OPS = new Set(['gt', 'lt', 'gte', 'lte', 'crossover', 'crossunder']);
const COMBINATORS = new Set(['all', 'any']);
const RISK_KEYS = new Set(['stop_loss_pct', 'take_profit_pct']);
const MAX_FACTORS = 12;
const MAX_CONDITIONS = 20;
const MAX_DEPTH = 6;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/**
 * Validate a Builder spec. Returns { valid, errors, spec } where `spec` is a cleaned copy
 * (only known fields, defaults filled in) when valid, else null. Pure.
 */
function validateSpec(raw) {
  const errors = [];
  if (!isObj(raw)) return { valid: false, errors: ['spec must be an object'], spec: null };
  const name = String(raw.name || 'Custom strategy').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Custom strategy';

  // ── factors ──
  const rawFactors = Array.isArray(raw.factors) ? raw.factors : [];
  if (rawFactors.length > MAX_FACTORS) errors.push(`too many factors (max ${MAX_FACTORS})`);
  const factors = [];
  const ids = new Set();
  rawFactors.forEach((f, i) => {
    const at = `factors[${i}]`;
    if (!isObj(f)) return errors.push(`${at} must be an object`);
    const id = String(f.id || '').trim();
    if (!id) return errors.push(`${at}: id required`);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id)) return errors.push(`${at}: id must be a short name (letters, digits, underscore)`);
    if (ids.has(id)) return errors.push(`duplicate factor id "${id}"`);
    if (BUILTIN_FACTORS.has(id)) return errors.push(`factor id "${id}" is reserved (built-in)`);
    const source = String(f.source || 'technical').trim().toLowerCase();
    const params = isObj(f.params) ? f.params : {};

    if (source === 'seniq') {
      const metric = String(f.metric || '').trim().toLowerCase();
      if (!SENIQ_METRICS.has(metric)) return errors.push(`${at} (${id}): unknown SenIQ metric "${metric}" — use one of ${[...SENIQ_METRICS].sort().join(', ')}`);
      const clean = {};
      if (params.window_days != null) {
        const wd = Number(params.window_days);
        if (!Number.isInteger(wd) || wd < 1 || wd > 365) return errors.push(`${at} (${id}): window_days must be a whole number 1..365`);
        clean.window_days = wd;
      }
      if (params.politician != null) {
        const pol = String(params.politician).replace(/\s+/g, ' ').trim();
        if (!metric.startsWith('congress_')) return errors.push(`${at} (${id}): politician only applies to congress metrics`);
        if (!pol || pol.length > 80) return errors.push(`${at} (${id}): politician must be a name of 1..80 characters`);
        clean.politician = pol;
      }
      const extra = Object.keys(params).filter((k) => !['window_days', 'politician'].includes(k));
      if (extra.length) return errors.push(`${at} (${id}): unknown parameter ${extra.join(', ')}`);
      ids.add(id);
      return factors.push({ id, source: 'seniq', metric, params: clean });
    }

    if (source !== 'technical') return errors.push(`${at} (${id}): unknown source "${source}" (technical | seniq)`);
    const fn = String(f.fn || '').trim().toLowerCase();
    if (!INDICATORS[fn]) return errors.push(`${at} (${id}): unknown fn "${fn}" — use one of ${Object.keys(INDICATORS).sort().join(', ')}`);
    const clean = {};
    for (const [k, v] of Object.entries(params)) {
      if (!INDICATORS[fn].includes(k)) return errors.push(`${at} (${id}): ${fn} has no parameter "${k}" (it takes ${INDICATORS[fn].join(', ')})`);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 500) return errors.push(`${at} (${id}): ${k} must be a whole number 1..500`);
      clean[k] = n;
    }
    if (clean.fast != null && clean.slow != null && clean.fast >= clean.slow) return errors.push(`${at} (${id}): fast must be smaller than slow`);
    ids.add(id);
    return factors.push({ id, source: 'technical', fn, params: clean });
  });

  // ── rule trees ──
  let conditions = 0;
  const operand = (x, where) => {
    if (isNum(x)) return true;
    if (typeof x === 'string') {
      if (ids.has(x) || BUILTIN_FACTORS.has(x)) return true;
      errors.push(`${where}: unknown factor id "${x}"`);
      return false;
    }
    errors.push(`${where}: operand must be a factor id or a number`);
    return false;
  };
  const tree = (node, where, allowRisk, depth = 0) => {
    if (!isObj(node) || Object.keys(node).length !== 1) { errors.push(`${where}: each rule must be an object with exactly one key`); return null; }
    if (depth > MAX_DEPTH) { errors.push(`${where}: rules are nested too deeply`); return null; }
    const [key] = Object.keys(node);
    const value = node[key];
    if (COMBINATORS.has(key)) {
      if (!Array.isArray(value) || !value.length) { errors.push(`${where}.${key}: must be a non-empty list`); return null; }
      const kids = value.map((c, j) => tree(c, `${where}.${key}[${j}]`, allowRisk, depth + 1)).filter(Boolean);
      return kids.length ? { [key]: kids } : null;
    }
    if (RISK_KEYS.has(key)) {
      if (!allowRisk) { errors.push(`${where}: ${key} is only valid inside exit rules`); return null; }
      const pct = Number(value);
      if (!isNum(pct) || typeof value === 'boolean' || pct <= 0 || pct >= 100) { errors.push(`${where}.${key}: must be a number between 0 and 100`); return null; }
      return { [key]: pct };
    }
    if (COMPARISON_OPS.has(key)) {
      conditions++;
      if (!Array.isArray(value) || value.length !== 2) { errors.push(`${where}.${key}: needs [left, right]`); return null; }
      let ok = operand(value[0], `${where}.${key}[0]`);
      ok = operand(value[1], `${where}.${key}[1]`) && ok;
      if ((key === 'crossover' || key === 'crossunder') && typeof value[0] !== 'string') {
        errors.push(`${where}.${key}: the left side must be a factor (a cross needs history)`);
        ok = false;
      }
      return ok ? { [key]: [value[0], value[1]] } : null;
    }
    errors.push(`${where}: unknown operator "${key}" — use ${[...COMPARISON_OPS].join(', ')}, all, any, stop_loss_pct or take_profit_pct`);
    return null;
  };

  const entry = raw.entry ? tree(raw.entry, 'entry', false) : null;
  if (!entry) errors.push('entry: at least one valid entry condition is required');
  const exit = raw.exit ? tree(raw.exit, 'exit', true) : null;
  if (!exit) errors.push('exit: needs at least one exit condition or a stop-loss/take-profit');
  if (conditions > MAX_CONDITIONS) errors.push(`too many conditions (max ${MAX_CONDITIONS})`);

  // Every declared factor should be used — an unused one is usually a slip in the rules.
  const used = new Set(JSON.stringify([entry, exit]).match(/"[A-Za-z][A-Za-z0-9_]*"/g)?.map((s) => s.slice(1, -1)) || []);
  const unused = factors.filter((f) => !used.has(f.id)).map((f) => f.id);
  if (unused.length && !errors.length) errors.push(`unused factor(s): ${unused.join(', ')} — use them in a rule or remove them`);

  // ── sizing ──
  const rs = isObj(raw.sizing) ? raw.sizing : { type: 'percent_equity', value: 25 };
  const type = String(rs.type || 'percent_equity');
  const value = Number(rs.value ?? 25);
  if (type === 'percent_equity') { if (!(value > 0 && value <= 100)) errors.push('sizing.value: percent_equity must be in (0, 100]'); }
  else if (type === 'fixed_cash') { if (!(value > 0)) errors.push('sizing.value: fixed_cash must be > 0'); }
  else errors.push(`sizing.type: unknown "${type}" (percent_equity | fixed_cash)`);

  if (errors.length) return { valid: false, errors: errors.slice(0, 12), spec: null };
  return { valid: true, errors: [], spec: { name, factors, entry, exit, sizing: { type, value } } };
}

// How much history each SenIQ signal family really has. Written here, in code, so a draft's
// caveat cannot be softened or dropped by the model. Update when the data changes.
const DATA_DEPTH = {
  sentiment: 'News sentiment only goes back as far as SenIQ has been recording (weeks, not years). On most bars of a backtest it has no reading, and any rule that needs it is simply false there.',
  congress: 'Congress trades are dated by disclosure, up to 45 days after the trade. The loaded data covers 2026 only, a few trades per stock, so these rules fire rarely.',
  funds: 'Tracked-fund data is ten funds\' quarterly 13F filings, published up to 45 days after quarter end: about a year of history, US stocks only, and it changes at most four times a year.',
};
const familyOf = (metric) => (metric.startsWith('congress_') ? 'congress' : metric.startsWith('funds_') ? 'funds' : 'sentiment');

/** The data-depth notes that apply to a (validated) spec, one per SenIQ signal family used. Pure. */
function dataDepthNotes(spec) {
  const families = new Set(((spec && spec.factors) || []).filter((f) => f.source === 'seniq').map((f) => familyOf(f.metric)));
  return ['sentiment', 'congress', 'funds'].filter((k) => families.has(k)).map((k) => DATA_DEPTH[k]);
}

module.exports = { validateSpec, dataDepthNotes, INDICATORS, SENIQ_METRICS, COMPARISON_OPS, MAX_FACTORS, MAX_CONDITIONS };
