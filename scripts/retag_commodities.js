#!/usr/bin/env node
/**
 * Remove stored commodity tags the resolver would no longer give.
 *
 *   node scripts/retag_commodities.js                 dry run: what would go, nothing written
 *   node scripts/retag_commodities.js --write         remove those tags
 *   node scripts/retag_commodities.js --write --backup samples/before.json
 *                                                     also save the removed rows first
 *
 * A story is tagged once, when it is stored, so a fix to the resolver ("Senco Gold" is a
 * jeweller, not gold; a commodity counts only when the headline is about it) leaves the old
 * tags in place. This re-reads every stored story tagged to a commodity with today's
 * resolver and removes the tag when it no longer comes out. Only commodity rows of
 * `article_sentiments` are touched, and nothing is added, so it can be run again safely.
 *
 * No model is used: the resolver here is the offline one built from data/universe.js.
 */
require('dotenv').config();
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const backupPath = args.includes('--backup') ? args[args.indexOf('--backup') + 1] : null;
  const db = require('../server/db');
  const { buildResolver, universeRows } = require('../server/services/entityResolver');
  try {
    const { companies, executives } = universeRows();
    const { resolve } = buildResolver(companies, executives);
    const commodities = companies.filter((c) => c.asset_class === 'commodity').map((c) => c.ticker);

    const rows = await db.query(
      `SELECT s.id, s.article_id, s.ticker, s.sentiment_label, s.sentiment_score, s.created_at, s.confidence, s.model,
              a.title, a.summary
         FROM article_sentiments s JOIN articles a ON a.id = s.article_id
        WHERE s.ticker = ANY($1) ORDER BY s.ticker, s.article_id`, [commodities]);
    const stale = rows.filter((r) => !resolve(r.title || '', r.summary || '').tickers.includes(r.ticker));

    console.log(`${rows.length} stored commodity tags; ${stale.length} no longer resolve:`);
    for (const r of stale) console.log(`  ${r.ticker}  #${r.article_id}  ${String(r.title).slice(0, 100)}`);
    if (!stale.length) return;

    if (!write) { console.log('Dry run: nothing written. Add --write to remove these tags.'); return; }
    if (backupPath) {
      fs.writeFileSync(backupPath, JSON.stringify(stale.map(({ summary, ...r }) => r), null, 1));
      console.log(`Removed rows saved: ${stale.length} → ${backupPath}`);
    }
    const res = await db.execute('DELETE FROM article_sentiments WHERE id = ANY($1)', [stale.map((r) => r.id)]);
    console.log(`Removed ${res.rowCount} tags.`);
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
