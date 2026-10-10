#!/usr/bin/env node
/**
 * News retention from the command line (server/services/retention.js).
 *
 *   node scripts/retention.js [plan]
 *       What a run would remove today and what it would keep back. Reads only.
 *
 *   node scripts/retention.js prune --write
 *       Archive the stories, add their readings to sentiment_daily, then remove them.
 *       Without --write it prints the plan and changes nothing.
 *
 *   node scripts/retention.js check <archive file>
 *       Read an archive back and count the stories in it.
 *
 * Options for plan and prune:
 *   --as-of YYYY-MM-DD   run as if it were that day (for trying it on a copy of the database)
 *   --unused-days N      instead of RETENTION.UNUSED_DAYS
 *   --used-days N        instead of RETENTION.USED_DAYS
 *   --archive-dir PATH   instead of RETENTION.ARCHIVE_DIR
 *
 * The daily job does the same as `prune --write`, and only when RETENTION=1.
 */
require('dotenv').config();

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

function option(flags, name) {
  const i = flags.indexOf(`--${name}`);
  return i >= 0 ? flags[i + 1] : undefined;
}

function wholeDays(flags, name) {
  const raw = option(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} needs a whole number of days, 1 or more`);
  return n;
}

function printPlan(p) {
  console.log(`As of ${day(p.now)}: ${p.total} stories stored.`);
  console.log(`  unused stories held since before ${day(p.cutoffs.unused)}:   ${p.unused} to remove`);
  console.log(`  other stories held since before ${day(p.cutoffs.used)}:    ${p.used} to remove`);
  if (p.keptForIpo) console.log(`  kept back, linked to an issue that is not finished:   ${p.keptForIpo}`);
  if (p.keptForEvent) console.log(`  kept back, part of an event still in the feed:        ${p.keptForEvent}`);
  if (!p.ids.length) { console.log('Nothing to remove.'); return; }
  console.log(`  held since ${day(p.oldest)} to ${day(p.newest)}`);
  console.log(`  ${p.readings} sentiment readings would be added to ${p.tickerDays} ticker-days in sentiment_daily`);
  for (const i of p.ipoIssues) console.log(`  IPO: ${i.name} (${i.market}) loses ${i.stories} linked ${i.stories === 1 ? 'story' : 'stories'}${i.saved ? '' : '; its news summary would be saved first'}`);
}

async function main() {
  const [first, ...rest] = process.argv.slice(2);
  const cmd = !first || first.startsWith('--') ? 'plan' : first;
  const flags = cmd === first ? rest : process.argv.slice(2);
  const retention = require('../server/services/retention');

  if (cmd === 'check') {
    if (!flags[0]) throw new Error('check needs an archive file');
    const r = await retention.readArchive(flags[0]);
    console.log(`${r.lines} stories in ${flags[0]}`);
    return;
  }
  if (cmd !== 'plan' && cmd !== 'prune') throw new Error(`unknown command "${cmd}" — plan, prune or check`);

  const asOf = option(flags, 'as-of');
  if (asOf !== undefined && !(/^\d{4}-\d{2}-\d{2}$/.test(asOf) && !Number.isNaN(Date.parse(asOf)))) throw new Error('--as-of needs a date, YYYY-MM-DD');
  const opts = {
    now: asOf ? new Date(`${asOf}T12:00:00Z`) : new Date(),
    unusedDays: wholeDays(flags, 'unused-days'),
    usedDays: wholeDays(flags, 'used-days'),
    archiveDir: option(flags, 'archive-dir'),
  };
  const write = cmd === 'prune' && flags.includes('--write');
  const r = await retention.prune({ ...opts, write, log: console.log });
  printPlan(r);
  if (r.written) {
    console.log(`Removed ${r.deleted} stories. ${r.readingsRolled} readings added to ${r.tickerDays} ticker-days; ${r.ipoSummaries} IPO news ${r.ipoSummaries === 1 ? 'summary' : 'summaries'} saved.`);
    console.log(`Archive: ${r.archive.file} (${r.archive.lines} stories, ${r.archive.bytes} bytes, sha256 ${r.archive.sha256.slice(0, 16)}…)`);
  } else if (r.ids.length) {
    console.log(cmd === 'prune' ? 'Nothing was changed: add --write to do it.' : 'Nothing was changed: this is the plan. `prune --write` does it.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
