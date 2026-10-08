/**
 * Offline tests for per-company sentiment (targetedSentiment.js): cutting a story into
 * units, which units belong to which company, when a language model is asked, and what
 * happens to its reply. No model runs here — FinBERT and the language model are stand-ins.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline:offline@localhost:5432/offline';

const assert = require('node:assert');
const T = require('../server/services/targetedSentiment');
const { TARGETED } = require('../server/config');
const { buildResolver, universeRows } = require('../server/services/entityResolver');

const { companies, executives } = universeRows();
const { resolve } = buildResolver(companies, executives);
const companiesIn = (text) => resolve(text, '').tickers;
const plan = (title, summary = '') => T.planStory(title, summary, resolve(title, summary).tickers.concat(companiesIn(summary)), companiesIn);

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  });
}
const section = (t) => pending.push(async () => console.log(t));

// Stand-in FinBERT: "positive" for a text with a rising word, "negative" for a falling one.
const reading = (label, score) => ({ label, score, confidence: 0.9, model: 'finbert' });
const fakeFinbert = async (texts) => texts.map((t) => (/advanced|rose|surge|jump/i.test(t) ? reading('positive', 0.95)
  : /weighed|fell|slip|drag/i.test(t) ? reading('negative', 0.05) : reading('neutral', 0.5)));
const WALL = {
  title: 'Wall Street slips as AI stocks drag despite gains in consumer names',
  summary: 'Tech heavyweights led by AMD and Nvidia weighed on markets, while General Mills, Nike and Kroger advanced.',
};

section('units:');
check('sentences, and clauses at a contrast word', () => {
  assert.deepStrictEqual(T.splitUnits('A rises; B falls', 'C gained 2%. D slid, while E held firm but F dropped.'),
    ['A rises', 'B falls', 'C gained 2%.', 'D slid', 'E held firm', 'F dropped.']);
  assert.deepStrictEqual(T.splitUnits('Profit up despite weak demand and higher costs'), ['Profit up despite weak demand and higher costs']);
});

section('which text is read for which company:');
check('a story naming one company is left alone', () => {
  assert.strictEqual(T.planStory('Kotak Bank Q2 profit rises 18%', '', ['KOTAKBANK'], companiesIn), null);
  assert.strictEqual(T.planStory('Rate hike ahead', '', ['__MARKET__'], companiesIn), null);
});
check('each company gets the clause that names it', () => {
  const p = plan(WALL.title, WALL.summary);
  assert.strictEqual(p.texts.NKE, 'General Mills, Nike and Kroger advanced.');
  assert.strictEqual(p.texts.AMD, 'Tech heavyweights led by AMD and Nvidia weighed on markets');
  assert.strictEqual(p.texts.NVDA, p.texts.AMD);
  assert.deepStrictEqual(p.shared.sort(), ['AMD', 'NVDA']); // they share a clause; Nike is alone in its own
});
check('companies that sit in the same units keep the whole-text reading', () => {
  const p = plan('Kotak, IndusInd, Axis Bank shares jump on strong Q2 business updates', 'Lenders report strong credit and deposit growth.');
  assert.deepStrictEqual(Object.values(p.texts), [null, null, null]);
  assert.deepStrictEqual(p.shared.sort(), ['AXISBANK', 'INDUSINDBK', 'KOTAKBANK']);
});
check('a company with its own sentence is read from it, the others stay shared', () => {
  const p = plan('Meta Platforms surges 12% on report of AI cloud service plans to rival Amazon, Microsoft',
    "Meta Platforms' shares rose nearly 12% after reports of a new cloud business.");
  assert.ok(p.texts.META.includes('shares rose nearly 12%'));
  assert.ok(!p.texts.AMZN.includes('shares rose'));
  assert.deepStrictEqual(p.shared.sort(), ['AMZN', 'META', 'MSFT']);
});

section('reading the companies:');
check('FinBERT reads each company\'s own text; the model is not asked when it is off', async () => {
  const [r] = await T.readCompanies([{ ...WALL, tickers: ['AMD', 'NVDA', 'NKE'], whole: reading('negative', 0.19) }],
    { companiesIn, classify: fakeFinbert, budget: async () => 0 });
  assert.deepStrictEqual([r.readings.NKE.label, r.readings.AMD.label, r.readings.NVDA.label], ['positive', 'negative', 'negative']);
  assert.deepStrictEqual(r.notAbout, []);
});
check('a story FinBERT did not read, or with one company, is left as it is', async () => {
  const out = await T.readCompanies([
    { ...WALL, tickers: ['AMD', 'NKE'], whole: null },
    { ...WALL, tickers: ['AMD', 'NKE'], whole: { label: 'negative', score: 0.2, confidence: 0.5, model: 'lexicon' } },
    { title: 'Nike advanced', summary: '', tickers: ['NKE'], whole: reading('positive', 0.9) },
  ], { companiesIn, classify: fakeFinbert, budget: async () => 5 });
  assert.deepStrictEqual(out, [null, null, null]);
});
check('FinBERT failing mid-run leaves every story as it is', async () => {
  const out = await T.readCompanies([{ ...WALL, tickers: ['AMD', 'NKE'], whole: reading('negative', 0.19) }],
    { companiesIn, classify: async () => null, budget: async () => 5 });
  assert.deepStrictEqual(out, [null]);
});
const META = {
  title: 'HDFC Bank, ICICI Bank remain top bets as valuations stay attractive, says Kotak',
  summary: 'Kotak Institutional Equities supports leading private banks.',
  tickers: ['HDFCBANK', 'ICICIBANK', 'KOTAKBANK'], whole: reading('positive', 0.97),
};
check('the model\'s answer replaces the shared companies\' readings; "not about" drops the tag', async () => {
  const asked = [];
  const [r] = await T.readCompanies([META], {
    companiesIn, classify: fakeFinbert, budget: async () => 5, log: async () => {}, scope: 'shared', removeNotAbout: true,
    ask: async (story, tickers) => { asked.push(tickers.slice().sort()); return { text: 'Here you go: {"HDFCBANK": "positive", "ICICIBANK": "Positive", "KOTAKBANK": "not about"}', usage: { input: 200, output: 30 } }; },
  });
  assert.deepStrictEqual(asked, [['HDFCBANK', 'ICICIBANK', 'KOTAKBANK']]);
  assert.deepStrictEqual(r.notAbout, ['KOTAKBANK']);
  assert.deepStrictEqual(Object.keys(r.readings).sort(), ['HDFCBANK', 'ICICIBANK']);
  assert.deepStrictEqual(r.readings.HDFCBANK, { label: 'positive', score: 0.9, confidence: 0.8, model: 'llm' });
});
check('the local model\'s "not about" keeps the tag, as a neutral reading', async () => {
  const [r] = await T.readCompanies([META], {
    companiesIn, classify: fakeFinbert, budget: async () => 5, scope: 'shared', removeNotAbout: false,
    ask: async () => ({ text: '{"HDFCBANK": "positive", "KOTAKBANK": "not_about"}', usage: null }),
  });
  assert.deepStrictEqual(r.notAbout, []);
  assert.deepStrictEqual(r.readings.KOTAKBANK, { label: 'neutral', score: 0.5, confidence: 0.8, model: 'llm' });
  assert.deepStrictEqual(TARGETED.LLM.REMOVE_NOT_ABOUT, { claude: true, ollama: false });
});
check('scope decides who the model is asked about', async () => {
  const asked = async (scope, story) => { let seen = null; await T.readCompanies([story], { companiesIn, classify: fakeFinbert, budget: async () => 5, scope, ask: async (s, tickers) => { seen = tickers.slice().sort(); return { text: '{}', usage: null }; } }); return seen; };
  const wall = { ...WALL, tickers: ['AMD', 'NVDA', 'NKE'], whole: reading('negative', 0.19) };
  const one = { title: 'Nike advanced', summary: '', tickers: ['NKE'], whole: reading('positive', 0.9) };
  assert.deepStrictEqual(await asked('shared', wall), ['AMD', 'NVDA']);
  assert.deepStrictEqual(await asked('multi', wall), ['AMD', 'NKE', 'NVDA']);
  assert.deepStrictEqual([await asked('shared', one), await asked('multi', one), await asked('all', one)], [null, null, ['NKE']]);
});
check('a failed call or a junk reply keeps FinBERT\'s reading', async () => {
  const base = { companiesIn, classify: fakeFinbert, budget: async () => 5, log: async () => {} };
  const [down] = await T.readCompanies([META], { ...base, ask: async () => { throw new Error('down'); } });
  assert.strictEqual(down.readings.KOTAKBANK.model, 'finbert');
  const [junk] = await T.readCompanies([META], { ...base, ask: async () => ({ text: 'I cannot say.', usage: { input: 1, output: 1 } }) });
  assert.deepStrictEqual([junk.readings.KOTAKBANK.model, junk.notAbout.length], ['finbert', 0]);
});
check('the daily cap stops the calls, and every call made is logged', async () => {
  let calls = 0; let logged = 0;
  await T.readCompanies([META, META, META], {
    companiesIn, classify: fakeFinbert, budget: async () => 2, log: async () => { logged++; },
    ask: async () => { calls++; return { text: '{}', usage: { input: 1, output: 1 } }; },
  });
  assert.deepStrictEqual([calls, logged], [2, 2]);
});

section('what is stored:');
check('read per company: every company named, less the passing mentions, each with its reading', () => {
  const pc = { readings: { HDFCBANK: reading('positive', 0.9) }, notAbout: ['KOTAKBANK'] };
  assert.deepStrictEqual(T.settle('Wall Street slips', ['HDFCBANK', 'KOTAKBANK'], [], pc), { tickers: ['HDFCBANK'], readings: pc.readings });
});
check('not read per company: only the story\'s subjects, on the whole-text reading', () => {
  assert.deepStrictEqual(T.settle('Wall Street slips as AI stocks drag', ['AMD', 'NKE'], [], null), { tickers: [], readings: {} });
  assert.deepStrictEqual(T.settle('Nike beats estimates', ['NKE'], ['NKE'], null), { tickers: ['NKE'], readings: {} });
});

section('the model\'s reply:');
check('only the tickers asked about and only known answers are kept', () => {
  assert.deepStrictEqual(T.parseReply('{"A": "negative", "B": "bullish", "C": "neutral"}', ['A', 'B']), { A: 'negative' });
  assert.deepStrictEqual(T.parseReply('not json', ['A']), {});
  assert.deepStrictEqual(T.parseReply('{"A": ', ['A']), {});
});
check('labels land on FinBERT\'s bands, and the prompt carries clamped text and the company names', () => {
  assert.deepStrictEqual(TARGETED.LLM.SCORE, { positive: 0.9, neutral: 0.5, negative: 0.1 });
  const p = T.buildPrompt({ title: 'T', summary: 'x'.repeat(5000) }, ['NKE'], { NKE: 'Nike' });
  assert.ok(p.includes('- NKE: Nike') && p.length < 800);
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${passed} per-company sentiment checks passed`);
})();
