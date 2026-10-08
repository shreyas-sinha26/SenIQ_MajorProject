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
 *   + model, shared clauses — the first design: the language model's label replaces FinBERT's
 *                   for companies that share a clause
 *   + model       — as configured now (for the local model: it reads every story, and its
 *                   agreement with FinBERT is the reading's confidence)
 *   … not-about removed — the same, with a "not about" answer removing the tag
 *   company-aware FinBERT, aware + model — the same steps with the fine-tuned FinBERT doing
 *                   step 1 (only when FINBERT_TARGET_MODEL is set and the folder exists)
 * The model rows appear only when COMPANY_SENTIMENT_LLM is set (1 = Claude, paid calls;
 * ollama = the local model). For each way it prints how many pairs match the label, how many
 * are the costly kind of wrong (positive where the label says negative, or the reverse), and
 * the share of confidence that sits on matching readings — confidence being a reading's
 * weight in a ticker's score.
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
  const { classifyBatch, classifyTargets, targetEnabled, isEnabled } = require('../server/services/finbertClassifier');
  const { buildResolver, universeRows } = require('../server/services/entityResolver');
  const { subjectTickers, isRoundup } = require('../server/services/newsRelevance');
  const { readCompanies, settle, askModel } = require('../server/services/targetedSentiment');
  try {
    if (!isEnabled()) throw new Error('FinBERT is off — set FINBERT_CLASSIFY=1 in .env first');
    const { companies, executives } = universeRows();
    const { resolve, nameByTicker, surface } = buildResolver(companies, executives);
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
    // The model is asked once per (story, companies): the rows below differ in how its answer
    // is used, not in the answer, so a repeat question is served from memory.
    const asked = new Map();
    const ask = (story, tickers, nameOf) => {
      const key = `${story.id}|${tickers.join(',')}`;
      if (!asked.has(key)) asked.set(key, askModel(story, tickers, nameOf));
      return asked.get(key);
    };
    const deps = { companiesIn, classify: classifyBatch, nameOf: nameByTicker, ask, log: async () => {} };
    const aware = targetEnabled() ? { classifyTarget: classifyTargets, surface } : null; // the fine-tuned FinBERT, if installed
    const step1 = await readCompanies(input, { ...deps, budget: async () => 0 });
    const step1Aware = aware ? await readCompanies(input, { ...deps, ...aware, budget: async () => 0 }) : null;
    const { FEATURES, TARGETED } = require('../server/config');
    const llm = FEATURES.COMPANY_SENTIMENT_LLM; // false | 'claude' | 'ollama'
    const first = llm ? await readCompanies(input, { ...deps, scope: 'shared', combine: 'replace', removeNotAbout: false }) : null;
    // One pass as configured, with removals on: the kept-as-neutral variant is derived from it.
    const keep = (run) => run && run.map((pc) => pc && ({ notAbout: [],
      readings: { ...pc.readings, ...Object.fromEntries(pc.notAbout.map((t) => [t, { label: 'neutral', score: 0.5, confidence: TARGETED.AGREE.CLASH, model: 'llm' }])) } }));
    const removing = llm ? await readCompanies(input, { ...deps, removeNotAbout: true }) : null;
    const keeping = keep(removing);
    const removingAware = llm && aware ? await readCompanies(input, { ...deps, ...aware, removeNotAbout: true }) : null;
    const keepingAware = keep(removingAware);
    const stored = (a, pc) => {
      const s = settle(a.title, a.tickers, a.inHeadline, pc);
      return (t) => (s.tickers.includes(t) ? (s.readings[t] || a.whole) : { label: 'na', confidence: 0 });
    };
    const NA = { label: 'na', confidence: 0 };
    const ways = {
      'whole text': (a) => () => a.whole,
      'subjects': (a) => { const s = subjectTickers(a.title, a.tickers, a.inHeadline); return (t) => (s.includes(t) ? a.whole : NA); },
      'per company': (a, i) => stored(a, step1[i]),
    };
    if (aware) ways['company-aware FinBERT'] = (a, i) => stored(a, step1Aware[i]);
    if (llm) {
      ways[`+ ${llm}, shared clauses`] = (a, i) => stored(a, first[i]);
      ways[`+ ${llm}`] = (a, i) => stored(a, keeping[i]);
      ways['… not-about removed'] = (a, i) => stored(a, removing[i]);
      if (aware) {
        ways[`aware + ${llm}`] = (a, i) => stored(a, keepingAware[i]);
        ways['… … not-about removed'] = (a, i) => stored(a, removingAware[i]);
      }
    }

    const byId = new Map(stories.map((a, i) => [a.id, i]));
    const multi = (p) => stories[byId.get(p.id)].tickers.length >= 2;
    const W = 26;
    console.log(`\n${'reading'.padEnd(W)}${'all pairs'.padEnd(14)}${'2+ companies'.padEnd(15)}${'one company'.padEnd(14)}${'opposite'.padEnd(10)}confidence on matches`);
    const tables = [];
    for (const [name, way] of Object.entries(ways)) {
      const got = labelled.filter((p) => byId.has(p.id)).map((p) => { const i = byId.get(p.id); const r = way(stories[i], i)(p.ticker); return { p, said: r.label, conf: Number(r.confidence) || 0 }; });
      const weight = got.reduce((a, r) => a + r.conf, 0);
      const onMatches = weight ? `${Math.round((100 * got.filter((r) => r.said === r.p.label).reduce((a, r) => a + r.conf, 0)) / weight)}%` : '—';
      const frac = (rows) => { const ok = rows.filter((r) => r.said === r.p.label).length; return rows.length ? `${ok}/${rows.length} (${Math.round((100 * ok) / rows.length)}%)` : '—'; };
      const opposite = got.filter((r) => (r.said === 'positive' && r.p.label === 'negative') || (r.said === 'negative' && r.p.label === 'positive')).length;
      console.log(`${name.padEnd(W)}${frac(got).padEnd(14)}${frac(got.filter((r) => multi(r.p))).padEnd(15)}${frac(got.filter((r) => !multi(r.p))).padEnd(14)}${String(opposite).padEnd(10)}${onMatches}`);
      tables.push([name, got]);
    }
    // Where each way goes wrong: rows = the label given by hand, columns = what the reading said.
    const KINDS = ['positive', 'neutral', 'negative', 'na'];
    for (const [name, got] of tables) {
      console.log(`\n${name} — label (rows) against reading (columns):\n${''.padEnd(10)}${KINDS.map((k) => k.padEnd(10)).join('')}`);
      for (const want of KINDS) console.log(`${want.padEnd(10)}${KINDS.map((said) => String(got.filter((r) => r.p.label === want && r.said === said).length).padEnd(10)).join('')}`);
    }
    if (!llm) console.log('\nThe language model was not asked: set COMPANY_SENTIMENT_LLM=1 (Claude, paid calls) or =ollama (local) to score that step too.');
    else console.log(`\nLanguage model: ${llm === 'ollama' ? `${TARGETED.LLM.OLLAMA_MODEL} (local)` : TARGETED.LLM.MODEL}.`);
    console.log('These stories were kept out of rule-tuning, so the figures are not flattered by it. With about 100 pairs, a few points either way is noise.');
  } finally {
    await db.closePool();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
