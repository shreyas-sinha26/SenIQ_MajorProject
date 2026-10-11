/**
 * The Terms of Use and the Privacy Policy, served at /terms and /privacy.
 *
 * The two pages are kept in server/pages/ (not public/) because each is finished here: the
 * shared stylesheet is put inline, so a page is one request, and {{CONTACT}} becomes the
 * address to write to. That is CONTACT_EMAIL when set, else the address SenIQ's own emails
 * come from (EMAIL_FROM); with neither, the page says to reply to any email from SenIQ.
 */
const fs = require('fs');
const path = require('path');
const { EMAIL } = require('../config');

const DIR = path.join(__dirname, '..', 'pages');
const NAMES = ['terms', 'privacy'];

// The address a reader is told to write to, or null. Pure.
function contactAddress(env = process.env, from = EMAIL.FROM) {
  const pick = (s) => (String(s || '').match(/[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/) || [null])[0];
  const fromAddress = /@resend\.dev$/i.test(pick(from) || '') ? null : pick(from); // Resend's shared test sender is nobody's inbox
  return pick(env.CONTACT_EMAIL) || fromAddress;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(name, address = contactAddress()) {
  const contact = address
    ? `write to <a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a>`
    : 'reply to any email SenIQ has sent you';
  return fs.readFileSync(path.join(DIR, `${name}.html`), 'utf8')
    .replace('{{STYLE}}', () => fs.readFileSync(path.join(DIR, 'legal.css'), 'utf8'))
    .replace('{{CONTACT}}', () => contact);
}

const cache = new Map();
function legalPage(name) {
  if (!NAMES.includes(name)) return null;
  if (!cache.has(name)) cache.set(name, render(name));
  return cache.get(name);
}

module.exports = { legalPage, render, contactAddress, NAMES };
