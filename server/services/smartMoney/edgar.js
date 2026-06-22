/**
 * SEC EDGAR 13F client (free, no key) — Phase 3 institutions.
 *
 * Flow per fund:
 *   submissions JSON  → most-recent 13F-HR accession(s)
 *   filing index.json → the information-table XML (the one .xml that isn't primary_doc)
 *   info-table XML    → per-holding rows (issuer, cusip, value, shares)
 *
 * Dependency-free XML parsing (regex over <infoTable> blocks), same spirit as the RSS
 * ingester. SEC mandates a descriptive User-Agent with a contact; requests are spaced
 * out by SEC_RATE_DELAY_MS to stay well under their rate limit.
 */

const { SMART_MONEY } = require('../../config');
const { fetchWithTimeout } = require('../ingest/util');
const { cusipToTicker } = require('./cusipMap');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CIK as stored is zero-padded ("0001067983"); the Archives path wants the bare integer.
const bareCik = (cik) => String(cik).replace(/^0+/, '');
const padCik = (cik) => `CIK${String(cik).replace(/\D/g, '').padStart(10, '0')}`;

async function secGet(url, asJson = false) {
  await sleep(SMART_MONEY.SEC_RATE_DELAY_MS);
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': SMART_MONEY.SEC_USER_AGENT, 'Accept-Encoding': 'gzip, deflate' },
  }, 10000);
  if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
  return asJson ? res.json() : res.text();
}

// Recent 13F-HR filings for a CIK, newest first. Amendments (13F-HR/A) are skipped —
// we track the primary quarterly book.
async function fetchRecent13F(cik, limit = 4) {
  const data = await secGet(`https://data.sec.gov/submissions/${padCik(cik)}.json`, true);
  const r = data.filings?.recent;
  if (!r) return [];
  const out = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    if (r.form[i] === '13F-HR') {
      out.push({
        accession: r.accessionNumber[i],
        form: r.form[i],
        filingDate: r.filingDate[i] || null,
        reportDate: r.reportDate[i] || null,
      });
    }
  }
  return out;
}

// Locate + fetch the information-table XML for a filing, returning parsed holdings.
async function fetchHoldings(cik, accession, reportDate) {
  const accNoDash = accession.replace(/-/g, '');
  const base = `https://www.sec.gov/Archives/edgar/data/${bareCik(cik)}/${accNoDash}`;
  const index = await secGet(`${base}/index.json`, true);
  const items = index.directory?.item || [];

  // The info table is an .xml that isn't the cover page (primary_doc) or an xsl render.
  const xmlNames = items
    .map((it) => it.name)
    .filter((n) => /\.xml$/i.test(n) && !/primary_doc/i.test(n) && !/^xsl/i.test(n));
  if (xmlNames.length === 0) return [];

  // Try candidates until one parses into holdings (filings occasionally have >1 xml).
  for (const name of xmlNames) {
    try {
      const xml = await secGet(`${base}/${name}`);
      const holdings = parseInfoTable(xml, reportDate);
      if (holdings.length) return holdings;
    } catch {
      /* try the next candidate */
    }
  }
  return [];
}

function tagValue(block, tag) {
  const m = block.match(new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

// Parse <infoTable> blocks, aggregating duplicate CUSIPs (a fund's book often lists the
// same issuer once per sub-manager). Pre-2023 filings report value in $thousands.
function parseInfoTable(xml, reportDate) {
  const blocks = xml.match(/<(?:[\w-]+:)?infoTable[\s>][\s\S]*?<\/(?:[\w-]+:)?infoTable>/gi);
  if (!blocks) return [];

  const inThousands = reportDate ? new Date(reportDate) < new Date('2023-01-01') : false;
  const byCusip = new Map();

  for (const b of blocks) {
    const cusip = tagValue(b, 'cusip').toUpperCase();
    if (!cusip) continue;
    const issuer = tagValue(b, 'nameOfIssuer');
    let value = Number(tagValue(b, 'value').replace(/[^0-9.]/g, '')) || 0;
    if (inThousands) value *= 1000;
    const shares = Number(tagValue(b, 'sshPrnamt').replace(/[^0-9.]/g, '')) || 0;

    const prev = byCusip.get(cusip);
    if (prev) {
      prev.value += value;
      prev.shares += shares;
    } else {
      byCusip.set(cusip, {
        cusip,
        issuer_name: issuer,
        ticker: cusipToTicker(cusip),
        value,
        shares,
      });
    }
  }

  return [...byCusip.values()].sort((a, b) => b.value - a.value);
}

module.exports = { fetchRecent13F, fetchHoldings, parseInfoTable, secGet, padCik, bareCik };
