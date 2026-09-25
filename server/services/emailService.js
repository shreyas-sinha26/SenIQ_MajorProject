/**
 * Phase 5 — transactional email via Resend (single HTTPS POST, no SDK).
 *
 * Degrades gracefully: without RESEND_API_KEY every send returns
 * { delivered:false } and callers fall back (dev reset links in the API
 * response, verification silently skipped). Phase 9 (digests/alerts)
 * reuses this same sender.
 */
const { EMAIL } = require('../config');

function emailEnabled() {
  return EMAIL.enabled;
}

async function sendEmail({ to, subject, text, html }) {
  if (!EMAIL.enabled) return { delivered: false, reason: 'no_provider' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${EMAIL.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL.FROM, to: [to], subject, text, html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`Email send failed (${res.status}): ${detail.slice(0, 200)}`);
      return { delivered: false, reason: `http_${res.status}` };
    }
    return { delivered: true };
  } catch (err) {
    console.error('Email send error:', err.message);
    return { delivered: false, reason: 'network' };
  }
}

module.exports = { sendEmail, emailEnabled };
