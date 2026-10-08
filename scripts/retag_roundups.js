#!/usr/bin/env node
/**
 * Remove stored company tags from roundup stories.
 *
 *   node scripts/retag_roundups.js                 dry run: what would go, nothing written
 *   node scripts/retag_roundups.js --write         remove those tags and re-grade the stories
 *   node scripts/retag_roundups.js --write --backup samples/before.json
 *                                                  also save the removed rows first
 *
 * A story is tagged once, when it is stored, so the rule that a roundup ("Market wrap: …
 * top gainers and losers") is about the market and not about each company it lists
 * (newsRelevance.subjectTickers) leaves the old tags in place — and with them the market's
 * tone stored as each company's sentiment. This applies today's rule to every stored story:
 * a company tag the rule drops is removed, and the story is graded again the way a new one
 * would be (a wrap or watch-list that named companies becomes a market story, with a
 * __MARKET__ reading).
 * Tags the rule keeps are not touched, so it can be run again safely.
 *
 * No model is used: the reading a story already has is kept.
 */
require('dotenv').config();
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const backupPath = args.includes('--backup') ? args[args.indexOf('--backup') + 1] : null;
  const db = require('../server/db');
  const { buildResolver, universeRows } = require('../server/services/entityResolver');
  const { classifyArticle, subjectTickers } = require('../server/services/newsRelevance');
  try {
    const { companies, executives } = universeRows();
    const { resolve } = buildResolver(companies, executives);
    const held = (await db.query('SELECT DISTINCT ticker, company_name FROM portfolio'))
      .map((h) => ({ ticker: h.ticker, name: h.company_name }));

    const rows = await db.query(
      `SELECT s.id, s.article_id, s.ticker, s.sentiment_label, s.sentiment_score, s.created_at, s.confidence, s.model,
              a.title, a.source, a.platform, a.relevance_tier, a.importance, a.is_relevant
         FROM article_sentiments s JOIN articles a ON a.id = s.article_id
        ORDER BY s.article_id, s.ticker`);
    const stories = new Map();
    for (const r of rows) {
      if (!stories.has(r.article_id)) stories.set(r.article_id, []);
      stories.get(r.article_id).push(r);
    }

    const stale = [];   // company tags to remove
    const regrade = []; // { id, tier, importance, isRelevant, market: reading to store as __MARKET__ | null }
    for (const [id, tags] of stories) {
      const a = tags[0];
      const stored = tags.map((r) => r.ticker);
      const kept = subjectTickers(a.title, stored, resolve(a.title || '', '', held).tickers);
      const gone = tags.filter((r) => !kept.includes(r.ticker));
      if (!gone.length) continue;
      stale.push(...gone);
      const rel = classifyArticle(a, kept, { aboutMarket: !kept.some((t) => t !== '__MARKET__') });
      const broad = rel.tier === 'market' || rel.tier === 'world' || a.platform === 'macro';
      regrade.push({ id, title: a.title, was: a.relevance_tier, rel, market: broad && !kept.includes('__MARKET__') ? gone[0] : null });
    }

    console.log(`${rows.length} stored tags on ${stories.size} stories; ${stale.length} company tags on ${regrade.length} roundup stories would go:`);
    for (const g of regrade) {
      const gone = stale.filter((r) => r.article_id === g.id);
      console.log(`  #${g.id}  ${g.was} → ${g.rel.tier}  [${gone.map((r) => `${r.ticker} ${r.sentiment_score}`).join(', ')}]  ${String(g.title).slice(0, 100)}`);
    }
    if (!stale.length) return;

    if (!write) { console.log('Dry run: nothing written. Add --write to remove these tags.'); return; }
    if (backupPath) {
      fs.writeFileSync(backupPath, JSON.stringify(stale.map(({ title, source, platform, ...r }) => r), null, 1));
      console.log(`Removed rows saved: ${stale.length} → ${backupPath}`);
    }
    await db.tx(async (client) => {
      for (const g of regrade) {
        if (g.market) {
          await client.query(
            `INSERT INTO article_sentiments (article_id, ticker, sentiment_label, sentiment_score, confidence, model)
             VALUES ($1, '__MARKET__', $2, $3, $4, $5) ON CONFLICT (article_id, ticker) DO NOTHING`,
            [g.id, g.market.sentiment_label, g.market.sentiment_score, g.market.confidence, g.market.model]);
        }
        await client.query('UPDATE articles SET relevance_tier = $2, importance = $3, is_relevant = $4 WHERE id = $1',
          [g.id, g.rel.tier, g.rel.importance, g.rel.isRelevant]);
      }
      const res = await client.query('DELETE FROM article_sentiments WHERE id = ANY($1)', [stale.map((r) => r.id)]);
      console.log(`Removed ${res.rowCount} tags; re-graded ${regrade.length} stories.`);
    });
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
