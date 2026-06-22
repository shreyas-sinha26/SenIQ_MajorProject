/**
 * Shared ingestion helpers: bounded fetch, stable ids, HTML/text cleaning.
 * Untrusted third-party text (news bodies, Reddit posts) is length-capped here
 * before it ever reaches scoring or a prompt.
 */

const crypto = require('crypto');
const { INGEST } = require('../../config');

// A short, stable id for dedupe keyed on the canonical URL (or text fallback).
function hashId(prefix, ...parts) {
  const h = crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
  return `${prefix}_${h}`;
}

function stripHtml(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampText(s = '', max = INGEST.MAX_TEXT_CHARS) {
  const t = String(s);
  return t.length > max ? t.slice(0, max) : t;
}

// fetch() with a hard timeout so one slow source can't stall the pipeline.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { hashId, stripHtml, clampText, fetchWithTimeout };
