/**
 * Grounding post-check for Ask answers — a deterministic audit that runs AFTER the model
 * has written. It pulls the checkable claims out of the answer (numbers, dates, URLs and
 * the companies it names) and looks for each one in the evidence the model actually had:
 * the tool results, the question, the user's holdings line and earlier turns.
 *
 * It MEASURES, it does not block: the answer is returned unchanged with the check attached,
 * and the stored results give a "grounded answer rate". That is deliberate — the check has
 * known false positives (below), so throwing answers away on it would cost good ones.
 *
 * What counts as supported:
 *   number — some evidence number equals it once rounded to the answer's precision
 *            (0.224 supports "0.22"), ignoring sign ("down 1.2%" vs -1.2), or as a
 *            fraction shown as a percentage (0.44 supports "44%"), or with k/M/B scaling.
 *   date   — the same month-day (and year, if the answer gives one) appears in the evidence.
 *   url    — appears verbatim in the evidence.
 *   ticker — a company the answer names is also named in the evidence.
 *
 * Known false positives: numbers the model DERIVED (a sum or difference of two tool values),
 * and figures in general finance explanations ("a P/E of 15"). Not checked at all: plain
 * integers up to 10 (counts like "three stories"), spelled-out numbers, and source names.
 *
 * Pure — no DB, no model.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const pad = (n) => String(n).padStart(2, '0');

// Names that contain digits but are not figures.
const NOT_FIGURES = /S&P\s?500|Nifty\s?(?:50|100|500)|Nasdaq[\s-]?100|Russell\s?\d{4}|Fortune\s?500|24\/7|\b(?:10-[KQ]|8-K|13[FDG]|20-F|6-K)\b/gi;

const UNIT_SCALE = { k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9 };

/** Pull the checkable claims out of an answer. Pure. */
function extractClaims(answer) {
  let text = String(answer || '');
  const claims = [];
  const take = (re, fn) => {
    text = text.replace(re, (...m) => {
      const c = fn(m);
      if (c) claims.push(c);
      return ' ';
    });
  };

  take(/https?:\/\/[^\s)\]}>"']+/gi, (m) => ({ type: 'url', text: m[0].replace(/[.,;:]+$/, '') }));
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => ({ type: 'date', text: m[0], year: +m[1], month: +m[2], day: +m[3] }));
  // "7 October 2026" / "7th Oct"
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi'),
    (m) => ({ type: 'date', text: m[0], day: +m[1], month: MONTHS[m[2].slice(0, 3).toLowerCase()], year: m[3] ? +m[3] : null }));
  // "October 7, 2026" / "Oct 7"
  take(new RegExp(`\\b${MONTH_RE}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d,]*\\d{2})(?:,?\\s+(\\d{4}))?`, 'gi'),
    (m) => ({ type: 'date', text: m[0], day: +m[2], month: MONTHS[m[1].slice(0, 3).toLowerCase()], year: m[3] ? +m[3] : null }));
  // "October 2026"
  take(new RegExp(`\\b${MONTH_RE}\\b\\.?\\s+(\\d{4})\\b`, 'gi'),
    (m) => ({ type: 'date', text: m[0], day: null, month: MONTHS[m[1].slice(0, 3).toLowerCase()], year: +m[2] }));

  text = text.replace(NOT_FIGURES, ' ');

  // A figure: optional sign/currency, digits, optional unit. Not glued to letters ("Q2", "13F").
  const numRe = /(?<![A-Za-z0-9.,])[-−–+]?[$₹€£]?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|bps|pts?|pp|bn|mn|[kKmMbB]|x|σ)?(?![A-Za-z0-9])/g;
  for (const m of text.matchAll(numRe)) {
    const decimals = m[2] ? m[2].length - 1 : 0;
    const value = Number(m[1].replace(/,/g, '') + (m[2] || ''));
    const unit = (m[3] || '').toLowerCase();
    if (!Number.isFinite(value)) continue;
    if (!decimals && !unit && value <= 10) continue; // counts: "three stories", "top 5"
    claims.push({ type: 'number', text: m[0].trim(), value, decimals, unit });
  }
  return claims;
}

/** Every number in the evidence, as absolute values. Pure. */
function evidenceNumbers(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const raw = m[0];
    out.add(Number(raw.replace(/,/g, '')));
    // "100,200" may be a thousands-separated figure or two JSON values — accept both readings.
    if (raw.includes(',')) for (const part of raw.split(',')) out.add(Number(part));
  }
  out.delete(NaN);
  return out;
}

const roundTo = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

function numberSupported(c, nums) {
  const scale = UNIT_SCALE[c.unit];
  for (const e of nums) {
    if (roundTo(e, c.decimals) === c.value) return true;
    if (roundTo(e * 100, c.decimals) === c.value) return true; // 0.44 shown as 44%
    if (scale && e !== 0 && Math.abs(c.value * scale - e) / e < 0.01) return true; // 39.8B vs 39800000000
  }
  return false;
}

function dateSupported(c, evidence) {
  if (c.day == null) return evidence.includes(`${c.year}-${pad(c.month)}`);
  const md = `-${pad(c.month)}-${pad(c.day)}`;
  return c.year ? evidence.includes(`${c.year}${md}`) : evidence.includes(md);
}

/**
 * Check an answer against its evidence.
 * @param {string} answer
 * @param {string[]} evidenceTexts  everything the model was shown for this answer
 * @param {{ findTickers?: (text:string) => string[] }} [opts]  company-mention detector
 * @returns {{ checked:number, unsupported:Array<{type:string,text:string}>, grounded:boolean }}
 */
function checkGrounding(answer, evidenceTexts, { findTickers } = {}) {
  const evidence = (evidenceTexts || []).filter(Boolean).join('\n');
  const nums = evidenceNumbers(evidence);
  const claims = extractClaims(answer);
  const unsupported = [];

  for (const c of claims) {
    const ok = c.type === 'number' ? numberSupported(c, nums)
      : c.type === 'date' ? dateSupported(c, evidence)
      : evidence.includes(c.text);
    if (!ok) unsupported.push({ type: c.type, text: c.text });
  }

  let checked = claims.length;
  if (findTickers) {
    const known = new Set(findTickers(evidence));
    const named = findTickers(answer);
    checked += named.length;
    for (const t of named) if (!known.has(t)) unsupported.push({ type: 'ticker', text: t });
  }

  // The same figure repeated in an answer is one finding, not several.
  const seen = new Set();
  const unique = unsupported.filter((u) => !seen.has(`${u.type}:${u.text}`) && seen.add(`${u.type}:${u.text}`));
  return { checked, unsupported: unique.slice(0, 20), grounded: unique.length === 0 };
}

module.exports = { checkGrounding, extractClaims, evidenceNumbers };
