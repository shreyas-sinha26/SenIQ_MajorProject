/**
 * Email preferences + unsubscribe (migration 0019).
 *
 *   GET  /api/email/unsubscribe?token=   confirmation page (changes nothing — mail
 *                                        scanners prefetch links, a GET must not unsubscribe)
 *   POST /api/email/unsubscribe?token=   turns alert email off. Also the target of the
 *                                        List-Unsubscribe-Post "one-click" header.
 *   POST /api/email/resubscribe?token=   turns it back on (from the confirmation page)
 *   GET  /api/email/preferences          signed-in: { email, email_verified, email_alerts, provider }
 *   PUT  /api/email/preferences          signed-in: { email_alerts: boolean }
 *
 * The token routes need no login: the link has to work straight from an inbox.
 */
const express = require('express');
const { queryOne } = require('../db');
const { authMiddleware } = require('./auth');
const { verifyUnsubscribeToken, emailEnabled } = require('../services/emailService');

const router = express.Router();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} — SenIQ</title>
<style>body{font-family:Inter,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F8FAFC;color:#0A2540;margin:0;padding:48px 16px}
main{max-width:460px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 10px}p{line-height:1.55;color:#475569;margin:0 0 16px}
button{background:#0A2540;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer}
button.ghost{background:transparent;color:#1E40AF;padding:10px 0}a{color:#1E40AF}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

const badLink = (res) => res.status(400).send(page('This link is not valid',
  '<p>The link is incomplete or has been altered. You can change email settings from your SenIQ profile.</p><p><a href="/app">Open SenIQ</a></p>'));

async function setAlerts(userId, on) {
  return queryOne('UPDATE users SET email_alerts = $1 WHERE id = $2 RETURNING email', [on, userId]);
}

router.get('/unsubscribe', async (req, res) => {
  const userId = verifyUnsubscribeToken(req.query.token);
  if (!userId) return badLink(res);
  const user = await queryOne('SELECT email, email_alerts FROM users WHERE id = $1', [userId]);
  if (!user) return badLink(res);
  const token = esc(req.query.token);
  if (!user.email_alerts) {
    return res.send(page('Alert emails are off', `<p>${esc(user.email)} is not receiving SenIQ alert emails. Alerts still appear in the app.</p>
<form method="post" action="/api/email/resubscribe?token=${token}"><button class="ghost">Turn alert emails back on</button></form>`));
  }
  res.send(page('Stop alert emails?', `<p>SenIQ will stop emailing alerts to ${esc(user.email)}. Alerts still appear in the app, and account emails such as password resets are not affected.</p>
<form method="post" action="/api/email/unsubscribe?token=${token}"><button>Stop alert emails</button></form>`));
});

router.post('/unsubscribe', async (req, res) => {
  const userId = verifyUnsubscribeToken(req.query.token);
  if (!userId) return badLink(res);
  const user = await setAlerts(userId, false);
  if (!user) return badLink(res);
  const token = esc(req.query.token);
  res.send(page('Alert emails are off', `<p>${esc(user.email)} will no longer receive SenIQ alert emails. Alerts still appear in the app.</p>
<form method="post" action="/api/email/resubscribe?token=${token}"><button class="ghost">Undo — turn them back on</button></form>`));
});

router.post('/resubscribe', async (req, res) => {
  const userId = verifyUnsubscribeToken(req.query.token);
  if (!userId) return badLink(res);
  const user = await setAlerts(userId, true);
  if (!user) return badLink(res);
  res.send(page('Alert emails are on', `<p>${esc(user.email)} will receive SenIQ alert emails again.</p><p><a href="/app">Open SenIQ</a></p>`));
});

router.get('/preferences', authMiddleware, async (req, res) => {
  const u = await queryOne('SELECT email, email_verified, email_alerts FROM users WHERE id = $1', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ email: u.email, email_verified: u.email_verified, email_alerts: u.email_alerts, provider: emailEnabled() });
});

router.put('/preferences', authMiddleware, async (req, res) => {
  const on = (req.body || {}).email_alerts;
  if (typeof on !== 'boolean') return res.status(400).json({ error: 'email_alerts must be true or false' });
  const u = await queryOne('UPDATE users SET email_alerts = $1 WHERE id = $2 RETURNING email_alerts', [on, req.user.id]);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ email_alerts: u.email_alerts });
});

module.exports = router;
