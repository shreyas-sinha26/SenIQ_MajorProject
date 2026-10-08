/**
 * Phase 5 — transactional email. One sender, two transports (config.EMAIL.provider):
 * Resend (single HTTPS POST, no SDK) when RESEND_API_KEY is set, otherwise SMTP
 * (nodemailer — e.g. a Gmail app password) when SMTP_* is set.
 *
 * Degrades gracefully: with neither configured every send returns
 * { delivered:false } and callers fall back (dev reset links in the API
 * response, verification silently skipped). Phase 9 (digests/alerts)
 * reuses this same sender.
 *
 * Every attempt against the provider is recorded in email_log (sent / failed),
 * and callers record deliberate non-sends with logEmail(status:'skipped').
 * Logging is best-effort: it never delays or fails a send. A missing provider
 * is NOT logged — in local dev that would be one row per alert, forever.
 */
const crypto = require('crypto');
const { EMAIL, APP_URL } = require('../config');

function emailEnabled() {
  return EMAIL.enabled;
}

// ─── Send log ────────────────────────────────────────────────
async function logEmail({ userId = null, to, kind = 'other', subject = null, status, reason = null, providerId = null }) {
  try {
    const { execute } = require('../db'); // lazy: the pure helpers below import without a DB
    await execute(
      `INSERT INTO email_log (user_id, to_email, kind, subject, status, reason, provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, to, kind, subject ? String(subject).slice(0, 200) : null, status, reason, providerId]);
  } catch (err) {
    console.error('Email log write failed:', err.message);
  }
}

// ─── SMTP transport (created on first use, then reused) ──────
let smtpTransport = null;
function getSmtpTransport() {
  if (!smtpTransport) {
    const nodemailer = require('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host: EMAIL.SMTP.HOST,
      port: EMAIL.SMTP.PORT,
      secure: EMAIL.SMTP.PORT === 465, // 465 = TLS from the start; 587 upgrades with STARTTLS
      requireTLS: EMAIL.SMTP.PORT !== 465,
      auth: { user: EMAIL.SMTP.USER, pass: EMAIL.SMTP.PASS },
      connectionTimeout: EMAIL.SMTP_TIMEOUT_MS,
      greetingTimeout: EMAIL.SMTP_TIMEOUT_MS,
      socketTimeout: EMAIL.SMTP_TIMEOUT_MS,
    });
  }
  return smtpTransport;
}

// Sign in to the SMTP server without sending anything. → { ok, reason? }
async function verifySmtp() {
  if (!EMAIL.SMTP.enabled) return { ok: false, reason: 'not_configured' };
  try {
    await getSmtpTransport().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.code || err.message };
  }
}

async function sendViaSmtp({ to, subject, text, html, headers, attachments }, log) {
  try {
    const info = await getSmtpTransport().sendMail({
      from: EMAIL.FROM, to, subject, text, html,
      ...(headers ? { headers } : {}),
      ...(attachments ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
    });
    log('sent', { providerId: info.messageId || null });
    return { delivered: true, id: info.messageId || null };
  } catch (err) {
    // err.code: EAUTH (bad app password), ETIMEDOUT / ESOCKET (network), EENVELOPE (bad address)…
    const reason = `smtp_${String(err.code || err.responseCode || 'error').toLowerCase()}`;
    console.error(`Email send failed (${reason}): ${String(err.message).slice(0, 200)}`);
    log('failed', { reason });
    return { delivered: false, reason };
  }
}

/**
 * Send one email. `kind` and `userId` are for the send log; `headers` are extra
 * SMTP headers (e.g. List-Unsubscribe); `attachments` is [{ filename, content: Buffer,
 * contentType }]. Resolves { delivered, reason?, id? } — never throws.
 */
async function sendEmail({ to, subject, text, html, kind = 'other', userId = null, headers = null, attachments = null }) {
  if (!EMAIL.enabled) return { delivered: false, reason: 'no_provider' };
  const log = (status, extra = {}) => logEmail({ userId, to, kind, subject, status, ...extra });
  if (EMAIL.provider === 'smtp') return sendViaSmtp({ to, subject, text, html, headers, attachments }, log);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${EMAIL.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL.FROM, to: [to], subject, text, html,
        ...(headers ? { headers } : {}),
        // Resend takes file contents as base64.
        ...(attachments ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`Email send failed (${res.status}): ${detail.slice(0, 200)}`);
      log('failed', { reason: `http_${res.status}` });
      return { delivered: false, reason: `http_${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    log('sent', { providerId: body.id || null });
    return { delivered: true, id: body.id || null };
  } catch (err) {
    console.error('Email send error:', err.message);
    log('failed', { reason: 'network' });
    return { delivered: false, reason: 'network' };
  }
}

// ─── Unsubscribe links ───────────────────────────────────────
// Stateless and signed: "<userId>.<hmac>". The link must work from an inbox with no
// login, must not be guessable for another user, and needs no table. It only ever
// switches alert email off or on — it grants no access to the account.
const secret = () => process.env.JWT_SECRET || 'dev-secret-change-me';
const sign = (userId) => crypto.createHmac('sha256', secret()).update(`unsubscribe:${userId}`).digest('base64url').slice(0, 32);

function unsubscribeToken(userId) {
  return `${userId}.${sign(userId)}`;
}

// → the user id (string) the token was issued for, or null.
function verifyUnsubscribeToken(token) {
  const m = /^(\d{1,18})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = Buffer.from(sign(m[1]));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? m[1] : null;
}

// `list` = which emails the link stops: 'alerts' (the default) or 'reports'.
function unsubscribeUrl(userId, list = 'alerts') {
  return `${APP_URL}/api/email/unsubscribe?token=${unsubscribeToken(userId)}${list === 'reports' ? '&list=reports' : ''}`;
}

module.exports = { sendEmail, emailEnabled, verifySmtp, logEmail, unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl };
