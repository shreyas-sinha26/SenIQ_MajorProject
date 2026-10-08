#!/usr/bin/env node
/**
 * Score the sentiment readings against hand labels.
 *
 *   node scripts/score_sentiment_labels.js samples/sentiment-labels.csv
 *
 * Reads the sheet written by sentiment_label_sheet.js once its `label` column is filled
 * (pos / neu / neg, or na = the story is not about that company) and reads every labelled
 * story again, each way the pipeline can:
 *   whole text    — one FinBERT reading copied to every company named (how it was)
 *   subjects      — the same, but roundups and passing mentions left out (subjectTickers)
 *   per company   — FinBERT on each company's own sentences (targetedSentiment, step 1)
 *   + model       — and the language model for shared clauses; only when COMPANY_SENTIMENT_LLM
 *                   is set (1 = Claude, paid calls; ollama = the local model)
 * For each it prints how many pairs match the label, and how many are the costly kind of
 * wrong: positive where the label says negative, or the reverse.
 *
 * Reads the database and the file; writes nothing. Needs FINBERT_CLASSIFY=1.
 */
require('dotenv').config();
const fs = require('fs');

// A CSV with quoted fields ("" = a quote), as the sheet is written and as spreadsheets save it.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
const LABEL = { pos: 'positive', positive: 'positive', neu: 'neutral', neutral: 'neutral', neg: 'negative', negative: 'negative', na: 'na' };

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('give the labelled sheet, e.g. samples/sentiment-labels.csv');
  const [head, ...lines] = parseCsv(fs.readFileSync(file, 'utf8'));
  const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`no "${name}" column in ${file}`); return i; };
  const pairs = lines.map((r) => ({ id: Number(r[col('article_id')]), ticker: r[col('ticker')], raw: String(r[col('label')] || '').trim().toLowerCase() }));
  const bad = pairs.filter((p) => p.raw && !LABEL[p.raw]);
  if (bad.length) throw new Error(`labels must be pos / neu / neg / na — found "${bad[0].raw}" (story ${bad[0].id}, ${bad[0].ticker})`);
  const labelled = pairs.filter((p) => p.raw).map((p) => ({ ...p, label: LABEL[p.raw] }));
  console.log(`${labelled.length} of ${pairs.length} pairs are labelled.`);
  if (!labelled.length) { console.log('Nothing to score yet: fill the label column first.'); return; }

  const db = require('../server/db');
  const { classifyBatch, isEnabled } = require('../server/services/finbertClassifier');
  const { buildResolver, universeRows } = require('../server/services/entityResolver');
  const { subjectTickers, isRoundup } = require('../server/services/newsRelevance');
  const { readCompanies, settle } = require('../server/services/targetedSentiment');
  try {
    if (!isEnabled()) throw new Error('FinBERT is off — set FINBERT_CLASSIFY=1 in .env first');
    const { companies, executives } = universeRows();
    const { resolve, nameByTicker } = buildResolver(companies, executives);
    const held = (await db.query('SELECT DISTINCT ticker, company_name FROM portfolio')).map((h) => ({ ticker: h.ticker, name: h.company_name }));
    const companiesIn = (text) => resolve(text, '', held).tickers;

    const ids = [...new Set(labelled.map((p) => p.id))];
    const stories = (await db.query('SELECT id, title, summary FROM articles WHERE id = ANY($1) ORDER BY id', [ids]))
      .map((a) => ({ id: Number(a.id), title: a.title || '', summary: a.summary || '' }));
    const whole = await classifyBatch(stories.map((a) => `${a.title} ${a.summary}`.trim()));
    if (!whole) throw new Error('FinBERT could not be run');
    stories.forEach((a, i) => { a.whole = whole[i]; a.tickers = resolve(a.title, a.summary, held).tickers; a.inHeadline = companiesIn(a.title); });

    // The pipeline's own steps (scheduler.classifyArticles), with and without the model.
    const input = stories.map((a) => ({ ...a, tickers: isRoundup(a.title, a.inHeadline) ? [] : a.tickers }));
    const deps = { companiesIn, classify: classifyBatch, nameOf: nameByTicker };
    const step1 = await readCompanies(input, { ...deps, budget: async () => 0 });
    const { FEATURES, TARGETED } = require('../server/config');
    const llm = FEATURES.COMPANY_SENTIMENT_LLM; // false | 'claude' | 'ollama'
    const withModel = llm ? await readCompanies(input, deps) : null;
    const stored = (a, pc) => {
      const s = settle(a.title, a.tickers, a.inHeadline, pc);
      return (t) => (s.tickers.includes(t) ? (s.readings[t] || a.whole).label : 'na');
    };
    const ways = {
      'whole text': (a) => () => a.whole.label,
      'subjects': (a) => { const s = subjectTickers(a.title, a.tickers, a.inHeadline); return (t) => (s.includes(t) ? a.whole.label : 'na'); },
      'per company': (a, i) => stored(a, step1[i]),
    };
    if (withModel) ways[`+ ${llm}`] = (a, i) => stored(a, withModel[i]);

    const byId = new Map(stories.map((a, i) => [a.id, i]));
    const multi = (p) => stories[byId.get(p.id)].tickers.length >= 2;
    console.log(`\n${'reading'.padEnd(13)}${'all pairs'.padEnd(14)}${'2+ companies'.padEnd(15)}${'one company'.padEnd(14)}opposite direction`);
    const tables = [];
    for (const [name, way] of Object.entries(ways)) {
      const got = labelled.filter((p) => byId.has(p.id)).map((p) => { const i = byId.get(p.id); return { p, said: way(stories[i], i)(p.ticker) }; });
      const frac = (rows) => { const ok = rows.filter((r) => r.said === r.p.label).length; return rows.length ? `${ok}/${rows.length} (${Math.round((100 * ok) / rows.length)}%)` : '—'; };
      const opposite = got.filter((r) => (r.said === 'positive' && r.p.label === 'negative') || (r.said === 'negative' && r.p.label === 'positive')).length;
      console.log(`${name.padEnd(13)}${frac(got).padEnd(14)}${frac(got.filter((r) => multi(r.p))).padEnd(15)}${frac(got.filter((r) => !multi(r.p))).padEnd(14)}${opposite}`);
      tables.push([name, got]);
    }
    // Where each way goes wrong: rows = the label given by hand, columns = what the reading said.
    const KINDS = ['positive', 'neutral', 'negative', 'na'];
    for (const [name, got] of tables) {
      console.log(`\n${name} — label (rows) against reading (columns):\n${''.padEnd(10)}${KINDS.map((k) => k.padEnd(10)).join('')}`);
      for (const want of KINDS) console.log(`${want.padEnd(10)}${KINDS.map((said) => String(got.filter((r) => r.p.label === want && r.said === said).length).padEnd(10)).join('')}`);
    }
    if (!withModel) console.log('\nThe language model was not asked: set COMPANY_SENTIMENT_LLM=1 (Claude, paid calls) or =ollama (local) to score that step too.');
    else console.log(`\nLanguage model: ${llm === 'ollama' ? `${TARGETED.LLM.OLLAMA_MODEL} (local)` : TARGETED.LLM.MODEL}.`);
    console.log('These stories were kept out of rule-tuning, so the figures are not flattered by it. With about 100 pairs, a few points either way is noise.');
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
