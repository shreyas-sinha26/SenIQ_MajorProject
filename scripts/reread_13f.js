#!/usr/bin/env node
/**
 * Read the stored 13F filings again from EDGAR.
 *
 *   node scripts/reread_13f.js                      dry run: each filing's stored and re-read sums, nothing written
 *   node scripts/reread_13f.js --write --backup samples/13f-before.json
 *                                                   save the stored rows first, then replace them
 *
 * A filing is read once, when it is first seen, and never again. The reader used to add a
 * fund's options to its shares (a <putCall> row is reported at the value of the shares under
 * it), so a filing stored before that was fixed carries sums that are too large. This reads
 * each stored filing again with the reader as it is now and replaces its holdings, its
 * count and its total. The filings themselves (accession, period, filing date) are kept,
 * and so is each one's id.
 *
 * Oldest first within a fund, so a filing's "new / added / reduced" is worked out against
 * the one before it as just re-read. A filing EDGAR does not return is left as it is.
 * No alert is raised: nothing here is new.
 */
require('dotenv').config();
const fs = require('fs');

const HOLDING_COLUMNS = ['id', 'institution_id', 'filing_id', 'cusip', 'ticker', 'issuer_name', 'shares', 'value', 'pct_of_portfolio', 'change_type', 'created_at'];
const billions = (v) => `$${(Number(v) / 1e9).toFixed(2)} billion`;

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const backupPath = args.includes('--backup') ? args[args.indexOf('--backup') + 1] : null;
  if (write && !backupPath) throw new Error('--write needs --backup <file>: the stored rows are saved before they are replaced');
  const db = require('../server/db');
  const { fetchHoldings } = require('../server/services/smartMoney/edgar');
  const { diffChangeType } = require('../server/services/smartMoney');
  try {
    const filings = await db.query(
      `SELECT f.id, f.institution_id, f.accession, f.period_of_report::text AS period, f.holdings_count, f.total_value,
              i.name, i.cik
         FROM institution_filings f JOIN institutions i ON i.id = f.institution_id
        ORDER BY i.id, f.period_of_report NULLS FIRST, f.id`);

    // Read everything before anything is written: a run that EDGAR cuts short changes nothing.
    const plan = [];
    const lastByFund = new Map(); // institution id → the shares by CUSIP of its previous filing
    for (const f of filings) {
      let holdings = [];
      try {
        holdings = await fetchHoldings(f.cik, f.accession, f.period);
      } catch (err) {
        console.log(`${f.name} ${f.period}: not read (${err.message}), left as it is`);
      }
      if (!holdings.length) {
        // Left as stored, so the next filing is compared with the stored rows.
        const stored = await db.query('SELECT cusip, shares FROM institution_holdings WHERE filing_id = $1', [f.id]);
        lastByFund.set(f.institution_id, Object.fromEntries(stored.map((r) => [r.cusip, Number(r.shares)])));
        plan.push({ f, holdings: null });
        continue;
      }
      const total = holdings.reduce((s, h) => s + h.value, 0);
      const prior = lastByFund.get(f.institution_id) || null;
      const rows = holdings.map((h) => ({
        ...h,
        pct: total > 0 ? (h.value / total) * 100 : 0,
        change_type: diffChangeType(prior, h.cusip, h.shares),
      }));
      lastByFund.set(f.institution_id, Object.fromEntries(holdings.map((h) => [h.cusip, h.shares])));
      plan.push({ f, holdings: rows, total });
      const same = rows.length === f.holdings_count && Math.abs(total - Number(f.total_value)) < 1;
      console.log(`${f.name} ${f.period}: ${f.holdings_count} holdings, ${billions(f.total_value)} stored → ${rows.length}, ${billions(total)}${same ? ' (same)' : ''}`);
    }

    const readable = plan.filter((p) => p.holdings);
    console.log(`\n${readable.length} of ${plan.length} filings read again; ${readable.reduce((s, p) => s + p.holdings.length, 0)} holdings in them.`);
    if (!write) {
      console.log('Dry run: nothing written. Use --write --backup <file> to replace the stored rows.');
      return;
    }

    const ids = readable.map((p) => p.f.id);
    const old = await db.query(
      `SELECT ${HOLDING_COLUMNS.map((c) => (c === 'created_at' ? 'created_at::text AS created_at' : c)).join(', ')}
         FROM institution_holdings WHERE filing_id = ANY($1) ORDER BY id`, [ids]);
    fs.writeFileSync(backupPath, JSON.stringify({
      saved_at: new Date().toISOString(),
      filings: readable.map(({ f }) => ({ id: f.id, accession: f.accession, period_of_report: f.period, holdings_count: f.holdings_count, total_value: f.total_value })),
      holding_columns: HOLDING_COLUMNS,
      holdings: old.map((r) => HOLDING_COLUMNS.map((c) => r[c])),
    }));
    console.log(`Stored rows saved: ${old.length} → ${backupPath}`);

    let removed = 0;
    let inserted = 0;
    await db.tx(async (client) => {
      for (const { f, holdings, total } of readable) {
        removed += (await client.query('DELETE FROM institution_holdings WHERE filing_id = $1', [f.id])).rowCount;
        inserted += (await client.query(
          `INSERT INTO institution_holdings (institution_id, filing_id, cusip, ticker, issuer_name, shares, value, pct_of_portfolio, change_type)
           SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::real[], $9::text[])`,
          [f.institution_id, f.id, holdings.map((h) => h.cusip), holdings.map((h) => h.ticker), holdings.map((h) => h.issuer_name),
           holdings.map((h) => h.shares), holdings.map((h) => h.value), holdings.map((h) => h.pct), holdings.map((h) => h.change_type)])).rowCount;
        await client.query('UPDATE institution_filings SET holdings_count = $2, total_value = $3 WHERE id = $1', [f.id, holdings.length, total]);
      }
    });
    console.log(`Replaced: ${removed} rows removed, ${inserted} rows written, across ${readable.length} filings.`);
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
