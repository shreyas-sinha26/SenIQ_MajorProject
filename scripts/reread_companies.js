#!/usr/bin/env node
/**
 * Re-read stored multi-company stories per company.
 *
 *   node scripts/reread_companies.js                 dry run: what would change, nothing written
 *   node scripts/reread_companies.js --tuning        dry run on the tuning stories only (see below)
 *   node scripts/reread_companies.js --write         update the stored readings
 *   node scripts/reread_companies.js --write --backup samples/before.json
 *                                                    also save the old rows first
 *
 * A story is read once, when it is stored, so stories stored before the per-company reading
 * (targetedSentiment.js) still carry one whole-text reading copied to every company. This
 * reads them again the way a new story is read: each company from the sentences and clauses
 * that name it, and — only when COMPANY_SENTIMENT_LLM=1 — the language model for a clause
 * naming two or more. Only company tags already stored are touched; none is added. A tag
 * the model calls "not about" is removed. Run retag_roundups.js first: roundups are skipped.
 *
 * --tuning leaves out the third of the store kept for hand-labelling
 * (sentiment_label_sheet.js), so rules are never adjusted on stories they are scored on.
 *
 * Needs FINBERT_CLASSIFY=1 (the model runs on this machine; see finbertClassifier.js).
 */
require('dotenv').config();
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const tuning = args.includes('--tuning');
  const backupPath = args.includes('--backup') ? args[args.indexOf('--backup') + 1] : null;
  if (write && tuning) throw new Error('--tuning is for dry runs only');
  const db = require('../server/db');
  const { classifyBatch, isEnabled } = require('../server/services/finbertClassifier');
  const { buildResolver, universeRows } = require('../server/services/entityResolver');
  const { isRoundup } = require('../server/services/newsRelevance');
  const { readCompanies } = require('../server/services/targetedSentiment');
  try {
    if (!isEnabled()) throw new Error('FinBERT is off — set FINBERT_CLASSIFY=1 in .env first');
    const { companies, executives } = universeRows();
    const { resolve, nameByTicker } = buildResolver(companies, executives);
    const held = (await db.query('SELECT DISTINCT ticker, company_name FROM portfolio'))
      .map((h) => ({ ticker: h.ticker, name: h.company_name }));
    const companiesIn = (text) => resolve(text, '', held).tickers;

    const rows = await db.query(
      `SELECT s.id, s.article_id, s.ticker, s.sentiment_label, s.sentiment_score, s.created_at, s.confidence, s.model,
              a.title, a.summary
         FROM article_sentiments s JOIN articles a ON a.id = s.article_id
        WHERE s.ticker <> '__MARKET__' AND s.model = 'finbert'
        ORDER BY s.article_id, s.ticker`);
    const byStory = new Map();
    for (const r of rows) {
      if (tuning && Number(r.article_id) % 3 === 0) continue;
      if (!byStory.has(r.article_id)) byStory.set(r.article_id, []);
      byStory.get(r.article_id).push(r);
    }
    const stories = [...byStory.values()]
      .filter((tags) => tags.length >= 2 && !isRoundup(tags[0].title, companiesIn(tags[0].title)))
      .map((tags) => {
        const a = tags[0];
        const found = resolve(a.title || '', a.summary || '', held).tickers;
        return {
          tags, title: a.title || '', summary: a.summary || '',
          tickers: tags.map((r) => r.ticker).filter((t) => found.includes(t)),
          whole: { label: a.sentiment_label, score: Number(a.sentiment_score), confidence: Number(a.confidence), model: 'finbert' },
        };
      });

    const read = await readCompanies(stories, { companiesIn, classify: classifyBatch, nameOf: nameByTicker });
    const changes = []; // { row, to: reading | null (remove) }
    stories.forEach((s, i) => {
      if (!read[i]) return;
      for (const row of s.tags) {
        if (read[i].notAbout.includes(row.ticker)) { changes.push({ row, to: null }); continue; }
        const to = read[i].readings[row.ticker];
        if (to && (to.label !== row.sentiment_label || Math.abs(to.score - Number(row.sentiment_score)) >= 0.01 || to.model !== row.model)) changes.push({ row, to });
      }
    });

    const flips = changes.filter((c) => c.to && c.to.label !== c.row.sentiment_label);
    console.log(`${stories.length} stored stories name 2+ companies${tuning ? ' (tuning stories only)' : ''}; ${changes.length} readings would change`
      + ` (${flips.length} change label, ${changes.filter((c) => !c.to).length} removed as "not about", ${changes.filter((c) => c.to && c.to.model === 'llm').length} by the language model):`);
    let last = null;
    for (const c of changes) {
      if (c.row.article_id !== last) { last = c.row.article_id; console.log(`  #${last}  ${String(c.row.title).slice(0, 110)}`); }
      console.log(`      ${c.row.ticker.padEnd(11)} ${c.row.sentiment_label} ${c.row.sentiment_score} → ${c.to ? `${c.to.label} ${c.to.score}${c.to.model === 'llm' ? ' (model)' : ''}` : 'removed'}`);
    }
    if (!changes.length) return;

    if (!write) { console.log('Dry run: nothing written. Add --write to store these readings.'); return; }
    if (backupPath) {
      fs.writeFileSync(backupPath, JSON.stringify(changes.map(({ row: { title, summary, ...r } }) => r), null, 1));
      console.log(`Old rows saved: ${changes.length} → ${backupPath}`);
    }
    await db.tx(async (client) => {
      for (const { row, to } of changes) {
        if (!to) { await client.query('DELETE FROM article_sentiments WHERE id = $1', [row.id]); continue; }
        await client.query(
          'UPDATE article_sentiments SET sentiment_label = $2, sentiment_score = $3, confidence = $4, model = $5 WHERE id = $1',
          [row.id, to.label, to.score, to.confidence || 0, to.model]);
      }
    });
    console.log(`Updated ${changes.filter((c) => c.to).length} readings, removed ${changes.filter((c) => !c.to).length} tags.`);
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
