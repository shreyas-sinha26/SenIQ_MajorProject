#!/usr/bin/env node
/**
 * Remove stored company tags that came only from an executive's OTHER venture.
 *
 *   node scripts/retag_executives.js                 dry run: what would go, nothing written
 *   node scripts/retag_executives.js --write         remove those tags
 *   node scripts/retag_executives.js --write --backup samples/before.json
 *                                                     also save the removed rows first
 *
 * A story is tagged once, when it is stored. Since the resolver learned that "Musk's SpaceX
 * files to go public" is not Tesla news (OTHER_VENTURES in entityResolver.js), the stories
 * tagged that way before still count toward the company's score. This re-reads every stored
 * story tagged to such an executive's company and removes the tag when BOTH hold: today's
 * resolver no longer gives it, and the story names one of the other ventures. The second
 * condition keeps this to the one rule: a tag that would differ today for any other reason
 * is left alone. Only `article_sentiments` rows are touched and nothing is added, so it can
 * be run again safely.
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
  const { buildResolver, universeRows, OTHER_VENTURES } = require('../server/services/entityResolver');
  try {
    const { companies, executives } = universeRows();
    const { resolve } = buildResolver(companies, executives);
    // ticker → the pattern of its executive's other ventures
    const ventures = new Map();
    for (const e of executives) {
      const re = OTHER_VENTURES[e.full_name.toLowerCase()];
      if (re) ventures.set(e.ticker, re);
    }
    if (!ventures.size) { console.log('No executive with other ventures is listed. Nothing to do.'); return; }

    const rows = await db.query(
      `SELECT s.id, s.article_id, s.ticker, s.sentiment_label, s.sentiment_score, s.created_at, s.confidence, s.model,
              a.title, a.summary
         FROM article_sentiments s JOIN articles a ON a.id = s.article_id
        WHERE s.ticker = ANY($1) ORDER BY s.ticker, s.article_id`, [[...ventures.keys()]]);
    const stale = rows.filter((r) => ventures.get(r.ticker).test(`${r.title || ''} ${r.summary || ''}`)
      && !resolve(r.title || '', r.summary || '').tickers.includes(r.ticker));

    console.log(`${rows.length} stored tags on ${[...ventures.keys()].join(', ')}; ${stale.length} came only from another venture:`);
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
