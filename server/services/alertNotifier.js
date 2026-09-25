/**
 * Instant alert email delivery (Phase 9).
 *
 * The materiality engine (services/materiality.js) already decides WHEN an alert fires and
 * dedupes it per (user, event). This module adds DELIVERY: it takes the freshly-created
 * realtime alerts and emails them via the EXISTING Resend sender (services/emailService.js)
 * — it does not implement a second email path.
 *
 * Tiering (matches config.TIERS "Alerts" row):
 *   Free → no email (in-app digest only)
 *   Plus → standard alert email
 *   Pro  → enhanced email with a short Claude narrative (services/alertNarrative.js)
 *
 * Guarantees:
 *   - only 'realtime' alerts email (digest stays in-app) — config.ALERT_EMAIL.REALTIME_ONLY
 *   - one email per (user, event): dedup reuses the alert engine's key, no second store
 *   - non-blocking: the caller fire-and-forgets this; alert generation never awaits email
 *   - resilient: a failure for one alert is logged and never throws / never crashes the engine
 */

const { ALERT_EMAIL, APP_URL } = require('../config');
const { sendEmail, emailEnabled } = require('./emailService');
const { getUserTier } = require('../middleware/tier');
const { buildFacts, generateProNarrative } = require('./alertNarrative');

const DIR_WORD = { positive: 'positive', negative: 'negative', neutral: 'mixed' };

// ── Pure: tier + delivery gate ──
// Free never emails; digest never emails (when REALTIME_ONLY); Plus/Pro realtime → email.
function shouldEmail(tier, delivery) {
  if (tier !== 'plus' && tier !== 'pro') return false;
  if (ALERT_EMAIL.REALTIME_ONLY && delivery && delivery !== 'realtime') return false;
  return true;
}

// ── Pure: dedupe by the same key the alert engine uses (user, event) ──
// Belt-and-suspenders: the engine already inserts one alert row per (user, event), so this
// only matters if a caller passes an accidental duplicate in one batch.
function dedupeEmailable(alerts) {
  const seen = new Set();
  const out = [];
  for (const a of alerts || []) {
    const key = `${a.user_id}|${a.event_id != null ? a.event_id : a.ticker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function dashboardUrl() {
  return `${APP_URL}${ALERT_EMAIL.DASHBOARD_PATH}`;
}

function whyFired(f) {
  if (f.isMarket) return 'This is a market- or world-level event above your alert threshold.';
  const bits = [];
  if (f.exposurePct != null) bits.push(`${Math.round(f.exposurePct)}% of your exposure`);
  if (f.sentimentScore != null) bits.push(`${DIR_WORD[f.direction] || 'mixed'} sentiment (${Math.round(f.sentimentScore * 100)}/100)`);
  if (f.sourceCount > 1) bits.push(`${f.sourceCount} sources`);
  const tail = bits.length ? bits.join(', ') : 'a material change on one of your holdings';
  return `Fired because this event touches ${tail}.`;
}

/**
 * Pure: build the { subject, text, html } for an alert email from normalized facts.
 * `narrative` (Pro only) is appended when present. No I/O — unit-testable.
 */
function buildAlertEmail(facts, { narrative = null } = {}) {
  const headline = (facts.headline || 'Portfolio event').slice(0, 140);
  const holdings = facts.isMarket ? 'Your portfolio (market-wide)' : facts.ticker;
  const exposure = facts.exposurePct != null ? `${Math.round(facts.exposurePct)}%` : '—';
  const sentiment = facts.sentimentScore != null ? `${Math.round(facts.sentimentScore * 100)}/100 (${DIR_WORD[facts.direction] || 'mixed'})` : '—';
  const impact = facts.impactScore != null ? String(Math.round(facts.impactScore * 100) / 100) : '—';
  const why = whyFired(facts);
  const url = dashboardUrl();

  const subject = `${ALERT_EMAIL.SUBJECT_PREFIX} Portfolio Alert: ${headline}`;

  const textLines = [
    headline,
    '',
    `Affected holdings: ${holdings}`,
    `Portfolio exposure: ${exposure}`,
    `Sentiment score: ${sentiment}`,
    `Impact score: ${impact}`,
    '',
    `Why this fired: ${why}`,
  ];
  if (narrative) {
    textLines.push('', 'Analyst take:', narrative);
  }
  textLines.push('', `Open your dashboard: ${url}`, '', 'SenIQ is informational, not investment advice.');
  const text = textLines.join('\n');

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const narrativeHtml = narrative
    ? `<p style="margin:16px 0 4px;font-weight:600;color:#111">Analyst take</p><p style="margin:0 0 12px;line-height:1.55;color:#333">${esc(narrative)}</p>`
    : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
  <h2 style="font-size:18px;margin:0 0 12px">${esc(headline)}</h2>
  <table style="border-collapse:collapse;font-size:14px;color:#333">
    <tr><td style="padding:3px 12px 3px 0;color:#666">Affected holdings</td><td style="padding:3px 0"><strong>${esc(holdings)}</strong></td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#666">Portfolio exposure</td><td style="padding:3px 0"><strong>${esc(exposure)}</strong></td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#666">Sentiment score</td><td style="padding:3px 0"><strong>${esc(sentiment)}</strong></td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#666">Impact score</td><td style="padding:3px 0"><strong>${esc(impact)}</strong></td></tr>
  </table>
  <p style="margin:12px 0;line-height:1.55;color:#333">${esc(why)}</p>
  ${narrativeHtml}
  <p style="margin:18px 0"><a href="${esc(url)}" style="background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block;font-size:14px">Open your dashboard</a></p>
  <p style="margin:14px 0 0;color:#999;font-size:12px">SenIQ is informational, not investment advice.</p>
</div>`;

  return { subject, text, html };
}

/**
 * Deliver alert emails for a batch of freshly-created alerts. Fire-and-forget from the
 * alert engine. Never throws. Dependencies are injectable for offline testing.
 *
 *   deps.emailEnabledFn  → gate on a configured provider
 *   deps.sendEmailFn     → the transport (emailService.sendEmail)
 *   deps.tierFn          → (userId) => { tier }
 *   deps.narrativeFn     → (userId, alert) => { narrative } for Pro
 *   deps.getEmailFn      → (userId) => { email, name } (recipient lookup)
 *
 * Returns a small summary { sent, skipped, failed } (handy for logs/tests).
 */
async function deliverAlertEmails(alerts, deps = {}) {
  const {
    emailEnabledFn = emailEnabled,
    sendEmailFn = sendEmail,
    tierFn = getUserTier,
    narrativeFn = generateProNarrative,
    getEmailFn = defaultGetEmail,
  } = deps;

  const summary = { sent: 0, skipped: 0, failed: 0 };
  try {
    if (!emailEnabledFn()) return summary; // no provider → nothing to send (no wasted Claude either)
    const batch = dedupeEmailable(alerts).filter((a) => !ALERT_EMAIL.REALTIME_ONLY || !a.delivery || a.delivery === 'realtime');
    if (batch.length === 0) return summary;

    for (const alert of batch) {
      try {
        const { tier } = await tierFn(alert.user_id);
        if (!shouldEmail(tier, alert.delivery)) { summary.skipped++; continue; }

        const recipient = await getEmailFn(alert.user_id);
        if (!recipient || !recipient.email) { summary.skipped++; continue; }

        const facts = buildFacts(alert);

        // Pro → attach a short narrative (its own quota/kill-switch/token caps live in
        // generateProNarrative). Any failure there degrades to no narrative, never blocks.
        let narrative = null;
        if (tier === 'pro') {
          try {
            const n = await narrativeFn(alert.user_id, alert);
            narrative = n && n.narrative ? n.narrative : null;
          } catch (err) {
            console.error(`Alert narrative failed for user ${alert.user_id} (sending plain email):`, err.message);
          }
        }

        const { subject, text, html } = buildAlertEmail(facts, { narrative });
        const res = await sendEmailFn({ to: recipient.email, subject, text, html });
        if (res && res.delivered) summary.sent++;
        else { summary.failed++; console.error(`Alert email not delivered to user ${alert.user_id}: ${res && res.reason}`); }
      } catch (err) {
        // One bad alert must never abort the rest — or crash the engine.
        summary.failed++;
        console.error(`Alert email error for user ${alert && alert.user_id}:`, err.message);
      }
    }
  } catch (err) {
    // Absolute backstop — deliverAlertEmails must never reject.
    console.error('Alert email dispatch failed:', err.message);
  }
  return summary;
}

// Default recipient lookup (lazy db require so pure helpers import without a DB).
async function defaultGetEmail(userId) {
  const { queryOne } = require('../db');
  return queryOne('SELECT email, name FROM users WHERE id = $1', [userId]);
}

module.exports = {
  shouldEmail,
  dedupeEmailable,
  buildAlertEmail,
  deliverAlertEmails,
  whyFired,
};
