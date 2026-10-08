#!/usr/bin/env node
/**
 * Write a sheet of (story, company) pairs for hand-labelling.
 *
 *   node scripts/sentiment_label_sheet.js samples/sentiment-labels.csv
 *
 * The per-company reading (targetedSentiment.js) can only be judged against labels a person
 * gave. This picks stored stories and lists one row per company the resolver finds in each,
 * with an empty `label` column to fill in:
 *   pos / neu / neg — what the story says about THAT company
 *   na              — the story is not about that company (a passing mention)
 * No model reading is shown, so the labels are not led by it.
 *
 * The stories come from a fixed third of the store (article id divisible by 3) and never
 * from HELD_BACK_FROM_LABELS — the stories read while the rules were being written. Rules
 * are tuned only on the other two thirds (the dry runs skip this third), so a score on
 * these labels is a score on stories the rules have not seen. Reads only; writes the file.
 */
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');

const LABEL_SET = (id) => Number(id) % 3 === 0;
// Stories printed and read during development (2026-10-08): not fair test material.
const HELD_BACK_FROM_LABELS = new Set([33746, 33686, 33663, 31075, 31071, 28750, 28747, 28737, 28710, 28650,
  28623, 27832, 27799, 27754, 27745, 27743, 26322, 26193, 26184, 26107, 24139, 21716, 21596, 21345, 9183, 9164,
  9151, 9089, 9074, 8910, 6584, 6532, 6527, 6492, 6476, 5934, 5846, 3930, 3906, 3898, 167, 200, 202, 510, 2517,
  2618, 3493, 3518, 3564, 3568, 3880, 3885, 3913, 6546, 9092, 9098, 9140, 10074, 10117, 14773, 20229, 26198,
  26274, 26316, 27762, 28657, 28700, 28709, 28748, 33695]);
const TARGET = { multi: 65, single: 35 }; // pairs from stories naming 2+ companies / exactly one

const csv = (v) => `"${String(v == null ? '' : v).replace(/\s+/g, ' ').trim().replace(/"/g, '""')}"`;
const order = (id) => crypto.createHash('sha1').update(`labels:${id}`).digest('hex'); // fixed shuffle

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('give the file to write, e.g. samples/sentiment-labels.csv');
  if (fs.existsSync(out)) throw new Error(`${out} exists — labels may be in it; choose another name`);
  const db = require('../server/db');
  const { buildResolver, universeRows } = require('../server/services/entityResolver');
  try {
    const { companies, executives } = universeRows();
    const { resolve } = buildResolver(companies, executives);
    const nameOf = new Map(companies.map((c) => [c.ticker, c.name]));
    const held = (await db.query('SELECT DISTINCT ticker, company_name FROM portfolio'))
      .map((h) => ({ ticker: h.ticker, name: h.company_name }));
    for (const h of held) if (!nameOf.has(h.ticker)) nameOf.set(h.ticker, h.name || h.ticker);

    const stories = (await db.query('SELECT id, title, summary, source, published_at FROM articles ORDER BY id'))
      .filter((a) => LABEL_SET(a.id) && !HELD_BACK_FROM_LABELS.has(Number(a.id)))
      .map((a) => ({ ...a, tickers: resolve(a.title || '', a.summary || '', held).tickers }))
      .filter((a) => a.tickers.length)
      .sort((a, b) => (order(a.id) < order(b.id) ? -1 : 1));

    const rows = [];
    const take = (pool, target) => {
      let n = 0;
      for (const a of pool) {
        if (n >= target) break;
        for (const t of a.tickers) rows.push([a.id, t, nameOf.get(t) || t, a.title, a.summary, a.source, '', '']);
        n += a.tickers.length;
      }
      return n;
    };
    const multi = take(stories.filter((a) => a.tickers.length >= 2), TARGET.multi);
    const single = take(stories.filter((a) => a.tickers.length === 1), TARGET.single);

    const head = ['article_id', 'ticker', 'company', 'title', 'summary', 'source', 'label', 'note'];
    fs.writeFileSync(out, [head, ...rows].map((r) => r.map(csv).join(',')).join('\n') + '\n');
    console.log(`${rows.length} pairs written to ${out}: ${multi} from stories naming 2+ companies, ${single} from single-company stories.`);
    console.log('Fill the label column with pos / neu / neg, or na when the story is not about that company.');
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
