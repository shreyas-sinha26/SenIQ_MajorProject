#!/usr/bin/env node
/**
 * IPO Watch from the command line.
 *
 *   node scripts/ipo_watch.js poll [--dry-run]
 *       Run the daily calendar poll once, now: one request to each source, then store what
 *       came back. --dry-run fetches and prints without touching the database.
 *
 *   node scripts/ipo_watch.js link [--days N]
 *       Link stored stories from the last N days (default 30) to the issues they are about.
 *
 *   node scripts/ipo_watch.js alias "<issue name>" [alias ...]
 *       Set the other names the news uses for an issue ("Jio" for Jio Platforms). An alias
 *       matches only in a story that is plainly about an IPO. No aliases given clears them.
 *
 *   node scripts/ipo_watch.js symbols
 *       Look up the ticker of each recently listed issue that has none (one request each).
 *
 *   node scripts/ipo_watch.js graduate
 *       Add listed issues whose ticker a price confirms to the company reference, so they
 *       can be searched and held. Makes no request.
 *
 *   node scripts/ipo_watch.js retone
 *       Re-score stories already read wherever a rule now covers them (a subscription figure
 *       in the headline). Runs no model.
 *
 *   node scripts/ipo_watch.js returns
 *       Fill in the listing-day, 1-week and 1-month closes that have come due for listed
 *       issues with a ticker (one request each) — Indian issues, then US ones, whose whole
 *       outcome comes from prices.
 */
require('dotenv').config();

async function main() {
  const [cmd, ...flags] = process.argv.slice(2);
  if (cmd === 'graduate') {
    const r = await require('../server/services/ipoWatch/registry').graduate();
    console.log(`${r.graduated} compan${r.graduated === 1 ? 'y' : 'ies'} added to the reference, ${r.existing} already there, ${r.clashes} ticker clash(es) skipped`);
    return;
  }
  if (cmd === 'retone') {
    const r = await require('../server/services/ipoWatch/arc').reapplyRules();
    console.log(`${r.changed} of ${r.checked} read stories re-scored from their own figures; ${r.cleared} reading(s) removed where the issue is not in the headline, ${r.requeued} queued to be read`);
    return;
  }
  if (cmd === 'returns') {
    const { resolveReturns, resolveUsOutcomes } = require('../server/services/ipoWatch/returns');
    const r = await resolveReturns();
    console.log(`India: returns updated for ${r.updated} of ${r.due} issue(s) due${r.error ? ` — stopped: ${r.error}` : ''}`);
    const u = await resolveUsOutcomes();
    console.log(`US: outcomes updated for ${u.updated} of ${u.due} issue(s) due${u.error ? ` — stopped: ${u.error}` : ''}`);
    return;
  }
  if (cmd === 'link' || cmd === 'alias' || cmd === 'symbols') {
    const { linkArticles, setAliases, linkSymbols } = require('../server/services/ipoWatch/registry');
    const { IPO_WATCH } = require('../server/config');
    if (cmd === 'link') {
      const n = flags.indexOf('--days');
      const r = await linkArticles({ days: n >= 0 ? Number(flags[n + 1]) : IPO_WATCH.LINK_BACKFILL_DAYS });
      console.log(`${r.linked} story link(s) added from ${r.checked} stories checked`);
    } else if (cmd === 'alias') {
      if (!flags.length) throw new Error('usage: alias "<issue name>" [alias ...]');
      const r = await setAliases(flags[0], flags.slice(1));
      console.log(`${r.name}: ${r.aliases.length ? r.aliases.join(', ') : 'no aliases'}`);
    } else {
      const r = await linkSymbols();
      console.log(`ticker found for ${r.found} of ${r.due} listed issue(s)${r.error ? ` — stopped: ${r.error}` : ''}`);
    }
    return;
  }
  if (cmd !== 'poll') throw new Error('usage: poll [--dry-run] | link [--days N] | alias "<issue name>" [alias ...] | symbols | returns | retone | graduate');
  const { pollCalendar, stageOf, marketDate } = require('../server/services/ipoWatch');
  const today = marketDate();
  const dry = flags.includes('--dry-run');
  let seen = [];
  const r = await pollCalendar({ today, ...(dry ? { save: async (issues) => { seen = issues; return 0; }, saveGmp: async () => 0, saveSubscriptions: async () => 0, saveGmpHistory: async () => 0, saveOutcomes: async () => 0 } : {}) });
  for (const f of r.failed) console.warn(`⚠️  ${f.source}: ${f.error}`);
  if (dry) {
    for (const i of seen) console.log(`${stageOf(i, today).padEnd(9)} ${i.board.padEnd(9)} ${i.open_date || '—'.padEnd(10)} → ${i.listing_date || '—'.padEnd(10)}  ${i.gmp == null ? '' : `GMP ₹${i.gmp}  `}${i.subscription ? `${i.subscription.total}x  ` : ''}${i.listing_gain_pct != null ? `listed ${i.listing_gain_pct}%  ` : ''}${i.name}`);
    console.log(`${seen.length} issue(s) parsed, nothing stored`);
  } else {
    console.log(`${r.stored} issue(s), ${r.gmp} GMP reading(s) for today and ${r.gmpHistory} for earlier days, ${r.subscriptions} subscription reading(s), ${r.outcomes} new outcome(s) stored from ${r.sources} source(s)`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
