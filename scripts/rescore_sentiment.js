#!/usr/bin/env node
/**
 * Re-read stored stories with FinBERT.
 *
 *   node scripts/rescore_sentiment.js                 dry run: what would change, nothing written
 *   node scripts/rescore_sentiment.js --write         update the stored readings
 *   node scripts/rescore_sentiment.js --write --backup samples/before.json
 *                                                     also save the old readings first
 *
 * Switching scorers changes the scale of a ticker's sentiment history, so the stories
 * already stored are re-read once to keep that history on one scale. Only readings made by
 * the word list are touched (model = 'lexicon'); a story read by FinBERT already is left
 * alone, so the script can be run again safely. A story tagged to several tickers gets the
 * same reading for each — FinBERT reads the text, not the company.
 *
 * Needs FINBERT_CLASSIFY=1 (the model runs on this machine; see finbertClassifier.js).
 */
require('dotenv').config();
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const backupPath = args.includes('--backup') ? args[args.indexOf('--backup') + 1] : null;
  const db = require('../server/db');
  const { classifyBatch, isEnabled } = require('../server/services/finbertClassifier');
  try {
    if (!isEnabled()) throw new Error('FinBERT is off — set FINBERT_CLASSIFY=1 in .env first');
    const articles = await db.query(
      `SELECT a.id, a.title, a.summary
         FROM articles a
        WHERE EXISTS (SELECT 1 FROM article_sentiments s WHERE s.article_id = a.id AND s.model = 'lexicon')
        ORDER BY a.id`);
    if (!articles.length) { console.log('Nothing to re-read: no story still carries a word-list reading.'); return; }

    const old = await db.query(
      `SELECT article_id, ticker, sentiment_label, sentiment_score, confidence, model
         FROM article_sentiments WHERE model = 'lexicon' ORDER BY article_id, ticker`);
    if (write && backupPath) {
      fs.writeFileSync(backupPath, JSON.stringify(old));
      console.log(`Old readings saved: ${old.length} rows → ${backupPath}`);
    }

    const readings = await classifyBatch(articles.map((a) => `${a.title} ${a.summary || ''}`.trim()));
    if (!readings) throw new Error('FinBERT could not be run — nothing changed');
    const byArticle = new Map(articles.map((a, i) => [String(a.id), readings[i]]));

    const moved = { same: 0, changed: 0, flipped: 0 };
    const to = { positive: 0, neutral: 0, negative: 0 };
    for (const row of old) {
      const r = byArticle.get(String(row.article_id));
      to[r.label]++;
      if (r.label === row.sentiment_label) moved.same++;
      else if (r.label !== 'neutral' && row.sentiment_label !== 'neutral') moved.flipped++;
      else moved.changed++;
    }
    console.log(`${articles.length} stories, ${old.length} readings (one per ticker a story is tagged to).`);
    console.log(`Label unchanged: ${moved.same} · to or from neutral: ${moved.changed} · positive↔negative: ${moved.flipped}`);
    console.log(`New split — positive ${to.positive}, neutral ${to.neutral}, negative ${to.negative}`);

    if (!write) { console.log('Dry run: nothing written. Add --write to update the stored readings.'); return; }
    let updated = 0;
    for (const [id, r] of byArticle) {
      const res = await db.execute(
        `UPDATE article_sentiments SET sentiment_label = $2, sentiment_score = $3, confidence = $4, model = 'finbert'
          WHERE article_id = $1 AND model = 'lexicon'`,
        [id, r.label, r.score, r.confidence]);
      updated += res.rowCount;
    }
    console.log(`Updated ${updated} readings.`);
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
