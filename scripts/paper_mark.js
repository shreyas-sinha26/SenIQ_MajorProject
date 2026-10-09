#!/usr/bin/env node
/**
 * Run the paper ledger job by hand.
 *
 *   node scripts/paper_mark.js              dry run: which deployments are due, nothing written
 *   node scripts/paper_mark.js --write      mark the deployments that are due
 *   node scripts/paper_mark.js --write --force
 *                                           also re-mark the ones already marked today
 *   node scripts/paper_mark.js --write --no-email
 *                                           record, but leave the fill emails unsent
 *
 * The same job the scheduler runs once a day when FEATURES_STRATEGIES=1
 * (services/paperLedger.js): replay each deployment, store the fills and the closing value
 * of every completed day not stored yet, then email the new fills. It needs the strategy
 * engine running. Rows are only ever added, so it can be run again safely.
 */
require('dotenv').config();

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const force = args.includes('--force');
  const db = require('../server/db');
  const { runPaperMarks, utcDay } = require('../server/services/paperLedger');
  try {
    if (!write) {
      const rows = await db.query(
        `SELECT id, name, symbol, status, last_marked_at, last_mark_error FROM paper_deployments
          WHERE ledger_closed_at IS NULL
            AND (last_marked_at IS NULL OR (last_marked_at AT TIME ZONE 'UTC')::date < $1::date)
          ORDER BY id`, [utcDay()]);
      console.log(`${rows.length} deployment(s) due (dry run; pass --write to mark them)`);
      for (const r of rows) {
        console.log(`  #${r.id} ${r.name} on ${r.symbol} [${r.status}] last marked ${r.last_marked_at ? r.last_marked_at.toISOString() : 'never'}${r.last_mark_error ? ` — last error: ${r.last_mark_error}` : ''}`);
      }
      return;
    }
    const r = await runPaperMarks({
      force,
      ...(args.includes('--no-email') ? { emailEnabledFn: () => false } : {}),
    });
    console.log(`${r.marked} of ${r.due} deployment(s) marked; ${r.fills} fill(s) and ${r.days} day(s) recorded`);
    console.log(`emails: ${r.emails.sent} sent, ${r.emails.skipped} skipped, ${r.emails.failed} failed`);
    for (const f of r.failed) console.log(`  failed #${f.id}: ${f.error}`);
    if (r.failed.length) process.exitCode = 1;
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
