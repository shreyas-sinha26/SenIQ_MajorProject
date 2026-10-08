#!/usr/bin/env node
/**
 * India smart money from the command line.
 *
 *   node scripts/india_smart_money.js import <file.csv> [--type bulk|block] [--dry-run]
 *       Load a bulk- or block-deal CSV downloaded from NSE's site by hand. The type is read
 *       from the file name (bulk.csv / block.csv) unless --type is given. --dry-run parses
 *       and prints without touching the database.
 *
 *   node scripts/india_smart_money.js poll
 *       Run the daily poll once, now (needs INDIA_SMART_MONEY=1): the deal files, then the
 *       newest unread insider filings.
 *
 *   node scripts/india_smart_money.js history SYMBOL [SYMBOL ...]
 *       Load insider trades from before May 2026 for the given symbols, from NSE's older
 *       per-symbol route.
 *
 * Both follow the poller's rules: rows already stored are skipped, the first file of a type
 * is stored without alerts, and a deal older than a week never alerts.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = rest.filter((a) => a.startsWith('--'));
  const args = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--type');
  const typeFlag = rest[rest.indexOf('--type') + 1];

  if (cmd === 'import') {
    const file = args[0];
    if (!file) throw new Error('usage: import <file.csv> [--type bulk|block] [--dry-run]');
    const named = /block/i.test(path.basename(file)) ? 'block' : /bulk/i.test(path.basename(file)) ? 'bulk' : null;
    const dealType = rest.includes('--type') ? typeFlag : named;
    if (dealType !== 'bulk' && dealType !== 'block') throw new Error('cannot tell bulk from block by the file name — add --type bulk or --type block');

    const { parseDeals } = require('../server/services/smartMoney/nseDeals');
    const deals = parseDeals(fs.readFileSync(file, 'utf8'), dealType);
    const matched = deals.filter((d) => d.investor_slug).length;
    console.log(`${deals.length} ${dealType} deal(s) in ${path.basename(file)}; ${matched} by a curated investor`);
    if (flags.includes('--dry-run')) {
      for (const d of deals.slice(0, 5)) console.log(`  ${d.deal_date} ${d.ticker} ${d.side} ${d.quantity} @ ${d.price} — ${d.client_name}`);
      return;
    }
    const db = require('../server/db');
    try {
      const { pollDealType } = require('../server/services/smartMoney/india');
      const r = await pollDealType(dealType, { fetch: async () => deals });
      console.log(`stored ${r.inserted} new, ${r.alerts} alert(s)${r.baseline ? ' (first file of this type — stored silently)' : ''}`);
    } finally { await db.closePool(); }
    return;
  }

  if (cmd === 'poll' || cmd === 'history') {
    if (cmd === 'history' && !args.length) throw new Error('usage: history SYMBOL [SYMBOL ...]');
    const db = require('../server/db');
    try {
      const India = require('../server/services/smartMoney/india');
      const r = cmd === 'history'
        ? await India.pollIndiaInsiders({ symbols: args.map((s) => s.toUpperCase()) })
        : await India.pollIndiaSmartMoney();
      console.log(JSON.stringify(r, null, 2));
    } finally { await db.closePool(); }
    return;
  }

  throw new Error('usage: india_smart_money.js import <file.csv> | poll | history SYMBOL ...');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
