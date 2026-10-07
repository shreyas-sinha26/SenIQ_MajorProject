/**
 * Company filings — the primary-source half of Ask's retrieval.
 *
 * News is what someone reported; a filing is what the company itself told the market, on a
 * known date. SenIQ keeps SEC 8-Ks ("current reports": results, executive changes, material
 * agreements, impairments…) for US-listed stocks that someone holds.
 *
 * Kept APART from news on purpose (own tables, migration 0022): filings do not feed the
 * sentiment score, story clustering or alerts.
 *
 * Lazy and bounded: only held tickers, a few per poll, a few filings each, every request
 * spaced out with the SEC-mandated User-Agent. A failed fetch never breaks the poll — the
 * ticker is simply retried later.
 *
 * Coverage is narrow and the tools say so: US-listed equities only. Indian stocks, crypto
 * and commodities have no filings here.
 */

const { DISCLOSURES, SMART_MONEY, FEATURES } = require('../config');
const { UNIVERSE } = require('../data/universe');
const { fetchWithTimeout } = require('./ingest/util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 8-K item codes → plain words. From the SEC's Form 8-K item list.
const ITEM_LABELS = {
  '1.01': 'Entered a material agreement',
  '1.02': 'Ended a material agreement',
  '1.03': 'Bankruptcy or receivership',
  '1.04': 'Mine safety report',
  '1.05': 'Material cybersecurity incident',
  '2.01': 'Completed an acquisition or disposal',
  '2.02': 'Results of operations (earnings)',
  '2.03': 'New debt or financial obligation',
  '2.04': 'Obligation accelerated or increased',
  '2.05': 'Exit or restructuring costs',
  '2.06': 'Material impairment',
  '3.01': 'Delisting notice or listing-rule failure',
  '3.02': 'Unregistered sale of shares',
  '3.03': 'Change to shareholder rights',
  '4.01': 'Change of auditor',
  '4.02': 'Earlier financial statements can no longer be relied on',
  '5.01': 'Change in control',
  '5.02': 'Director or officer change, or pay arrangement',
  '5.03': 'Bylaw or fiscal-year change',
  '5.04': 'Employee benefit plan trading suspension',
  '5.05': 'Code of ethics change or waiver',
  '5.07': 'Shareholder vote results',
  '5.08': 'Shareholder director nominations',
  '7.01': 'Regulation FD disclosure',
  '8.01': 'Other event',
  '9.01': 'Financial statements and exhibits',
};
// Items that say nothing about WHAT happened; left out of a title when anything else is present.
const FILLER_ITEMS = new Set(['9.01']);

// ── Pure helpers ──

/** "2.02,9.01" → ['2.02', '9.01'] (known order kept, junk dropped). Pure. */
function parseItems(raw) {
  return String(raw || '').split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^\d\.\d{2}$/.test(s));
}

/** Item codes → a plain-language title. Pure. */
function titleForItems(items, form = '8-K') {
  const real = items.filter((i) => !FILLER_ITEMS.has(i));
  const labels = (real.length ? real : items).map((i) => ITEM_LABELS[i] || `Item ${i}`);
  return labels.length ? labels.join('; ') : `${form} filing`;
}

/**
 * The 8-Ks in an EDGAR submissions reply, newest first, no older than `sinceDays`.
 * EDGAR returns parallel arrays (form[i], accessionNumber[i], …). Pure apart from `now`.
 */
function eightKsFrom(submissions, { sinceDays = DISCLOSURES.LOOKBACK_DAYS, limit = DISCLOSURES.MAX_FILINGS_PER_TICKER, now = Date.now() } = {}) {
  const r = submissions && submissions.filings && submissions.filings.recent;
  if (!r || !Array.isArray(r.form)) return [];
  const cutoff = new Date(now - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    if (!DISCLOSURES.FORMS.includes(r.form[i])) continue;
    const filed = r.filingDate && r.filingDate[i];
    if (!filed || filed < cutoff) continue;
    const items = parseItems(r.items && r.items[i]);
    out.push({
      accession: r.accessionNumber[i],
      form: r.form[i],
      items,
      title: titleForItems(items, r.form[i]),
      filed_at: filed,
      report_date: (r.reportDate && r.reportDate[i]) || null,
      primary_document: (r.primaryDocument && r.primaryDocument[i]) || null,
    });
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', reg: '®', trade: '™', copy: '©', bull: '•' };

/** Filing HTML → readable text: scripts, styles, hidden XBRL and tags removed, entities decoded. Pure. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head|ix:header)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const clip = (text, n) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * The part of an 8-K's main document worth keeping: everything from the first "Item N.NN"
 * on (the cover page before it is boilerplate), up to the signature block. Pure.
 */
function mainBody(text) {
  const t = String(text || '');
  const start = t.search(/\bItem\s+\d\.\d{2}/i);
  let body = start >= 0 ? t.slice(start) : t;
  // Stop at the signature block or the forward-looking-statements boilerplate, whichever comes
  // first: the risk-factor paragraph matches almost any search ("results", "demand", "revenue").
  const end = body.search(/\n\s*SIGNATURES?\s*\n|Pursuant to the requirements of the Securities Exchange Act|\n\s*(Cautionary (Note|Statement)[^\n]{0,60})?Forward[- ]Looking Statements?\b/i);
  if (end > 200) body = body.slice(0, end);
  return body;
}

/** One stored excerpt from the main document and (when there is one) the press release. Pure. */
function buildExcerpt(mainText, exhibitText) {
  const main = clip(mainBody(mainText), DISCLOSURES.MAIN_TEXT_CHARS);
  // Exhibits open with EDGAR's own document header ("EX-99.1 2 a8-kex991.htm EX-99.1 Exhibit 99.1").
  const body = String(exhibitText || '').replace(/^\s*EX-99\S*\s+\d+\s+\S+\.html?\s+(?:EX-99\S*\s+)?(?:Exhibit\s+99\S*\s+)?/i, '');
  const exhibit = clip(body, DISCLOSURES.EXHIBIT_TEXT_CHARS);
  return exhibit ? `${main}\n\nPRESS RELEASE: ${exhibit}` : main;
}

/** The press-release exhibit in a filing's file list (EX-99.1 before other EX-99s), or null. Pure. */
function pickExhibit(indexItems, primaryDocument) {
  const files = (indexItems || []).map((f) => f && f.name).filter((n) => n && /\.html?$/i.test(n) && n !== primaryDocument);
  const ex99 = files.filter((n) => /ex-?_?99/i.test(n));
  return ex99.find((n) => /99[-_.]?0?1\b|991/i.test(n)) || ex99[0] || null;
}

const secTicker = (t) => String(t || '').toUpperCase().replace(/\./g, '-');
const NON_US = new Set(UNIVERSE.filter((c) => c.country && c.country !== 'US').map((c) => c.ticker));

/** Is this holding a US-listed stock (the only kind with SEC filings)? Pure. */
function isUsEquity(h) {
  if (!h || (h.asset_class && h.asset_class !== 'equity')) return false;
  if (NON_US.has(h.ticker)) return false;
  const ex = String(h.exchange || '').toUpperCase();
  return !ex || DISCLOSURES.US_EXCHANGES.includes(ex);
}

// ── EDGAR ──
async function secGet(url, { json = false } = {}) {
  await sleep(SMART_MONEY.SEC_RATE_DELAY_MS);
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': SMART_MONEY.SEC_USER_AGENT, 'Accept-Encoding': 'gzip, deflate' } }, 12000);
  if (!res.ok) throw new Error(`EDGAR ${res.status}`);
  if (json) return res.json();
  const len = Number(res.headers.get('content-length') || 0);
  if (len > DISCLOSURES.MAX_DOC_BYTES) throw new Error('document too large');
  const text = await res.text();
  if (text.length > DISCLOSURES.MAX_DOC_BYTES) throw new Error('document too large');
  return text;
}

// SEC's ticker → CIK list (one ~1 MB file); cached for a day.
let cikCache = null;
let cikAt = 0;
async function cikMap() {
  if (cikCache && Date.now() - cikAt < 24 * 3_600_000) return cikCache;
  const data = await secGet('https://www.sec.gov/files/company_tickers.json', { json: true });
  cikCache = new Map(Object.values(data).map((c) => [String(c.ticker).toUpperCase(), String(c.cik_str)]));
  cikAt = Date.now();
  return cikCache;
}

async function fetchFilingText(cik, f) {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${f.accession.replace(/-/g, '')}`;
  const url = f.primary_document ? `${base}/${f.primary_document}` : `${base}/`;
  let main = '';
  let exhibit = '';
  if (f.primary_document) main = htmlToText(await secGet(url));
  try {
    const index = await secGet(`${base}/index.json`, { json: true });
    const name = pickExhibit(index.directory && index.directory.item, f.primary_document);
    if (name) exhibit = htmlToText(await secGet(`${base}/${name}`));
  } catch { /* the press release is a bonus; the filing still stands without it */ }
  return { url, excerpt: buildExcerpt(main, exhibit) };
}

/**
 * Fetch new 8-Ks for held US stocks. Bounded per call (see config.DISCLOSURES).
 * Returns { checked, inserted, skipped? }. Never throws for a per-ticker failure.
 */
async function syncDisclosures() {
  if (!FEATURES.DISCLOSURES) return { skipped: 'disabled' };
  const { query, queryOne, execute } = require('../db');
  // Held US equities that are due: never checked, or last checked long enough ago.
  const due = await query(
    `SELECT DISTINCT ON (p.ticker) p.ticker, p.asset_class, p.exchange, s.source_id
       FROM portfolio p
       LEFT JOIN disclosure_sync s ON s.ticker = p.ticker
      WHERE p.asset_class = 'equity'
        AND (s.ticker IS NULL
             OR (s.source_id IS NOT NULL AND s.last_checked < now() - ($1 || ' hours')::interval)
             OR (s.source_id IS NULL AND s.last_checked < now() - ($2 || ' days')::interval))
      ORDER BY p.ticker, s.last_checked NULLS FIRST`,
    [String(DISCLOSURES.RECHECK_HOURS), String(DISCLOSURES.UNLISTED_RECHECK_DAYS)]
  );
  const tickers = due.filter(isUsEquity).slice(0, DISCLOSURES.MAX_TICKERS_PER_RUN);
  if (!tickers.length) return { checked: 0, inserted: 0 };

  const mark = (ticker, cik, error) => execute(
    `INSERT INTO disclosure_sync (ticker, source_id, last_checked, last_error) VALUES ($1, $2, now(), $3)
     ON CONFLICT (ticker) DO UPDATE SET source_id = COALESCE(EXCLUDED.source_id, disclosure_sync.source_id), last_checked = now(), last_error = EXCLUDED.last_error`,
    [ticker, cik, error]
  );

  let ciks;
  try { ciks = await cikMap(); } catch (err) { return { checked: 0, inserted: 0, error: `ticker list unavailable: ${err.message}` }; }

  let inserted = 0;
  for (const h of tickers) {
    const cik = h.source_id || ciks.get(secTicker(h.ticker)) || null;
    if (!cik) { await mark(h.ticker, null, 'not listed with the SEC'); continue; }
    try {
      const subs = await secGet(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, { json: true });
      // Every 8-K in the lookback is considered each time; ones already stored are skipped, and
      // at most MAX_FILINGS_PER_TICKER new ones are fetched, so a busy filer fills in over a few polls.
      let fetched = 0;
      for (const f of eightKsFrom(subs, { limit: 100 })) {
        if (fetched >= DISCLOSURES.MAX_FILINGS_PER_TICKER) break;
        if (await queryOne("SELECT 1 FROM disclosures WHERE source = 'sec' AND accession = $1", [f.accession])) continue;
        fetched++;
        const { url, excerpt } = await fetchFilingText(cik, f);
        const r = await execute(
          `INSERT INTO disclosures (source, ticker, accession, form, items, title, filed_at, report_date, url, excerpt)
           VALUES ('sec', $1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (source, accession) DO NOTHING`,
          [h.ticker, f.accession, f.form, f.items, f.title, f.filed_at, f.report_date, url, excerpt]
        );
        inserted += r.rowCount;
      }
      await mark(h.ticker, cik, null);
    } catch (err) {
      await mark(h.ticker, cik, String(err.message).slice(0, 200));
    }
  }
  return { checked: tickers.length, inserted };
}

// ── Reading (Ask / API) ──
const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'why', 'how', 'about', 'any', 'are', 'was', 'did', 'does', 'has', 'have', 'this', 'that', 'from', 'into', 'its', 'say', 'said', 'tell', 'give', 'latest', 'recent', 'filing', 'filings', 'filed', 'company', 'sec']);
/** Query → content words for full-text search. Pure. */
function filingTerms(q) {
  const words = String(q || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 8);
}

const toCard = (r, chars) => ({
  id: `d${r.id}`,
  ticker: r.ticker,
  form: r.form,
  filed: r.filed,
  event_date: r.event_date || undefined,
  what: r.title,
  items: r.items,
  excerpt: clip(r.snippet || r.excerpt, chars),
  url: r.url,
});

/**
 * Filings for a set of tickers, newest first, or best match first when `query` is given.
 * `tickers` MUST already be restricted to what the caller may see. Returns { results, covered }
 * where `covered` are the tickers SenIQ has ever checked with the regulator — so "no filings"
 * can be told apart from "not a US-listed stock".
 */
async function listDisclosures({ tickers, query: q, days = DISCLOSURES.LOOKBACK_DAYS, limit = DISCLOSURES.LIST_LIMIT }) {
  const { query } = require('../db');
  const window = String(Math.max(1, Math.min(DISCLOSURES.LOOKBACK_DAYS, Number(days) || DISCLOSURES.LOOKBACK_DAYS)));
  const terms = filingTerms(q);
  const cols = "id, ticker, form, items, title, to_char(filed_at, 'YYYY-MM-DD') AS filed, to_char(report_date, 'YYYY-MM-DD') AS event_date, url, excerpt";
  const rows = terms.length
    ? await query(
      `SELECT ${cols},
              ts_headline('english', excerpt, to_tsquery('english', $3), 'MaxWords=45, MinWords=20, MaxFragments=1') AS snippet
         FROM disclosures
        WHERE ticker = ANY($1) AND filed_at > now() - ($2 || ' days')::interval
          AND search_tsv @@ to_tsquery('english', $3)
        ORDER BY ts_rank_cd(search_tsv, to_tsquery('english', $3)) DESC, filed_at DESC
        LIMIT $4`,
      [tickers, window, terms.join(' | '), limit])
    : await query(
      `SELECT ${cols} FROM disclosures
        WHERE ticker = ANY($1) AND filed_at > now() - ($2 || ' days')::interval
        ORDER BY filed_at DESC, id DESC LIMIT $3`,
      [tickers, window, limit]);
  const synced = await query('SELECT ticker, source_id FROM disclosure_sync WHERE ticker = ANY($1)', [tickers]);
  return {
    results: rows.map((r) => toCard({ ...r, snippet: r.snippet ? r.snippet.replace(/<\/?b>/g, '') : null }, DISCLOSURES.CARD_EXCERPT_CHARS)),
    covered: synced.filter((s) => s.source_id).map((s) => s.ticker),
    not_listed: synced.filter((s) => !s.source_id).map((s) => s.ticker),
  };
}

/** One filing with its longer excerpt, or null when it doesn't exist or isn't in `tickers`. */
async function getDisclosure({ id, tickers }) {
  const m = /^d(\d{1,18})$/.exec(String(id || '').trim().toLowerCase());
  if (!m) return null;
  const { queryOne } = require('../db');
  const r = await queryOne(
    `SELECT id, ticker, form, items, title, to_char(filed_at, 'YYYY-MM-DD') AS filed, to_char(report_date, 'YYYY-MM-DD') AS event_date, url, excerpt
       FROM disclosures WHERE id = $1 AND ticker = ANY($2)`,
    [Number(m[1]), tickers]);
  return r ? toCard(r, DISCLOSURES.DETAIL_EXCERPT_CHARS) : null;
}

module.exports = {
  syncDisclosures, listDisclosures, getDisclosure,
  parseItems, titleForItems, eightKsFrom, htmlToText, mainBody, buildExcerpt, pickExhibit, isUsEquity, filingTerms, ITEM_LABELS,
};
