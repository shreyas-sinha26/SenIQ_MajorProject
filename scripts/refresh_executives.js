#!/usr/bin/env node
/**
 * Re-check the curated CEOs in server/data/executives.json against Financial Modeling
 * Prep's company profile, and stamp each confirmed entry with today's date.
 *
 *   node scripts/refresh_executives.js            # dry run — prints the report only
 *   node scripts/refresh_executives.js --write    # also updates executives.json
 *   node scripts/refresh_executives.js AAPL MSFT  # limit to some tickers
 *
 * Scope: US equities only — FMP's free tier does not serve NSE symbols, so the Indian
 * entries are maintained by hand. One request per ticker (~100 of the 250/day free
 * budget). Needs FMP_API_KEY in .env.
 *
 * What it does per company (FMP returns a formal name like "Gregory Edward Abel", so the
 * comparison is on SURNAME against the headline-style names we curate, "Greg Abel"):
 *   - surname matches a current CEO     → asOf = today, source = 'fmp'
 *   - no match                          → CHANGE. With --write: the old CEO(s) get
 *                                         `until` = today (kept, so headlines still
 *                                         resolve) and FMP's name is added as CEO.
 *                                         Review the new name — shorten it to how
 *                                         headlines write it — before committing.
 *   - FMP has no CEO for the symbol     → reported, file untouched
 * Chairs/founders are never touched: FMP only reports the CEO.
 *
 * The server picks the file up on its next boot (seedUniverse).
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const FILE = path.join(__dirname, '..', 'server', 'data', 'executives.json');
const { UNIVERSE } = require('../server/data/universe');

const HONORIFICS = /^(mr|mrs|ms|miss|dr|sir|prof)\.?$/i;
const SUFFIXES = /^(jr|sr|ii|iii|iv|ph\.?d|m\.?d|j\.?d|mba|m\.?b\.?a|cfa|cpa|esq)\.?$/i;

// "Mr. C. Douglas McMillon Jr." → ["c.", "douglas", "mcmillon"]
function nameTokens(name) {
  return String(name || '')
    .split(',')[0] // drop trailing degrees: "Lisa T. Su, Ph.D."
    .split(/\s+/)
    .filter((t) => t && !HONORIFICS.test(t) && !SUFFIXES.test(t))
    .map((t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());
}
const surname = (name) => nameTokens(name).pop() || '';
const cleanName = (name) =>
  String(name || '').split(',')[0].split(/\s+/).filter((t) => t && !HONORIFICS.test(t) && !SUFFIXES.test(t)).join(' ');

const isCeo = (e) => !e.until && /CEO/i.test(e.role || '');

// One exec per line, fixed key order, so a refresh produces a small readable diff.
function serialize(data) {
  const KEYS = ['name', 'role', 'aliases', 'asOf', 'source', 'until'];
  const one = (e) => `{ ${KEYS.filter((k) => e[k] != null).map((k) => `${JSON.stringify(k)}: ${JSON.stringify(e[k]).replace(/","/g, '", "')}`).join(', ')} }`;
  const blocks = Object.entries(data).map(([t, list]) => `  ${JSON.stringify(t)}: [\n${list.map((e) => `    ${one(e)}`).join(',\n')}\n  ]`);
  return `{\n${blocks.join(',\n')}\n}\n`;
}

async function fetchCeo(ticker, apiKey) {
  const symbol = ticker.replace('.', '-'); // BRK.B → BRK-B
  const res = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  const p = Array.isArray(body) ? body[0] : body;
  if (!p || !p.symbol) return { error: 'no profile' };
  return { ceo: (p.ceo || '').trim() };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const only = new Set(args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase()));
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) { console.error('FMP_API_KEY is not set (.env).'); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const tickers = UNIVERSE.filter((c) => c.country === 'US' && c.assetClass === 'equity').map((c) => c.ticker)
    .filter((t) => !only.size || only.has(t));

  const confirmed = [];
  const changed = [];
  const skipped = [];
  for (const ticker of tickers) {
    let r;
    try { r = await fetchCeo(ticker, apiKey); } catch (e) { r = { error: e.message }; }
    await new Promise((ok) => setTimeout(ok, 250));
    if (r.error || !r.ceo) { skipped.push(`${ticker}: ${r.error || 'FMP lists no CEO'}`); continue; }

    const list = data[ticker] || (data[ticker] = []);
    const ceos = list.filter(isCeo);
    const hit = ceos.find((e) => surname(e.name) === surname(r.ceo));
    if (hit) {
      hit.asOf = today;
      hit.source = 'fmp';
      confirmed.push(ticker);
      continue;
    }
    changed.push(`${ticker}: file has ${ceos.map((e) => e.name).join(' / ') || '(no CEO)'} — FMP says ${r.ceo}`);
    for (const e of ceos) e.until = today;
    list.unshift({ name: cleanName(r.ceo), role: 'CEO', asOf: today, source: 'fmp' });
  }

  console.log(`Checked ${tickers.length} US tickers against FMP (${today}).`);
  console.log(`  confirmed: ${confirmed.length}`);
  console.log(`  changed:   ${changed.length}`);
  for (const line of changed) console.log(`    ${line}`);
  console.log(`  skipped:   ${skipped.length}`);
  for (const line of skipped) console.log(`    ${line}`);

  if (write) {
    fs.writeFileSync(FILE, serialize(data));
    console.log(`\nWrote ${path.relative(process.cwd(), FILE)} — review the diff, then restart the server to reseed.`);
  } else {
    console.log('\nDry run — nothing written. Re-run with --write to apply.');
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { nameTokens, surname, cleanName, serialize };
