/**
 * Email preferences + unsubscribe (migration 0019).
 *
 *   GET  /api/email/unsubscribe?token=   confirmation page (changes nothing — mail
 *                                        scanners prefetch links, a GET must not unsubscribe)
 *   POST /api/email/unsubscribe?token=   turns alert email off. Also the target of the
 *                                        List-Unsubscribe-Post "one-click" header.
 *   POST /api/email/resubscribe?token=   turns it back on (from the confirmation page)
 *   GET  /api/email/preferences          signed-in: { email, email_verified, email_alerts, email_reports,
 *                                        home_market, report: { market, kind, time, time_zone }, provider }
 *   PUT  /api/email/preferences          signed-in: any of { email_alerts, email_reports, home_market }
 *
 * The three token routes take ?list=reports to act on report emails instead of alert emails.
 *
 * The token routes need no login: the link has to work straight from an inbox.
 */
const { asyncRouter } = require('../middleware/asyncRouter');
const { query, queryOne } = require('../db');
const { authMiddleware } = require('./auth');
const { verifyUnsubscribeToken, emailEnabled } = require('../services/emailService');
const { guessMarket } = require('../services/reportEmails');
const { REPORT_EMAIL } = require('../config');

const router = asyncRouter();
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

// Which emails a link is about: ?list=reports → report emails, anything else → alert emails.
const LISTS = {
  alerts: { column: 'email_alerts', name: 'alert emails', Name: 'Alert emails', query: '',
    kept: 'Alerts still appear in the app.' },
  reports: { column: 'email_reports', name: 'report emails', Name: 'Report emails', query: '&list=reports',
    kept: 'Your brief is still in the app.' },
};
const listOf = (req) => (req.query.list === 'reports' ? LISTS.reports : LISTS.alerts);

async function setList(userId, list, on) {
  return queryOne(`UPDATE users SET ${list.column} = $1 WHERE id = $2 RETURNING email`, [on, userId]);
}

router.get('/unsubscribe', async (req, res) => {
  const userId = verifyUnsubscribeToken(req.query.token);
  if (!userId) return badLink(res);
  const list = listOf(req);
  const user = await queryOne(`SELECT email, ${list.column} AS is_on FROM users WHERE id = $1`, [userId]);
  if (!user) return badLink(res);
  const link = `token=${esc(req.query.token)}${list.query}`;
  if (!user.is_on) {
    return res.send(page(`${list.Name} are off`, `<p>${esc(user.email)} is not receiving SenIQ ${list.name}. ${list.kept}</p>
<form method="post" action="/api/email/resubscribe?${link}"><button class="ghost">Turn ${list.name} back on</button></form>`));
  }
  res.send(page(`Stop ${list.name}?`, `<p>SenIQ will stop sending ${list.name} to ${esc(user.email)}. ${list.kept} Account emails such as password resets are not affected.</p>
<form method="post" action="/api/email/unsubscribe?${link}"><button>Stop ${list.name}</button></form>`));
});

router.post('/unsubscribe', async (req, res) => {
  const userId = verifyUnsubscribeToken(req.query.token);
  if (!userId) return badLink(res);
  const list = listOf(req);
  const user = await setList(userId, list, false);
  if (!user) return badLink(res);
  res.send(page(`${list.Name} are off`, `<p>${esc(user.email)} will no longer receive SenIQ ${list.name}. ${list.kept}</p>
<form method="post" action="/api/email/resubscribe?token=${esc(req.query.token)}${list.query}"><button class="ghost">Undo — turn them back on</button></form>`));
});

router.post('/resubscribe', async (req, res) => {
  const userId = verifyUnsubscribeToken(req.query.token);
  if (!userId) return badLink(res);
  const list = listOf(req);
  const user = await setList(userId, list, true);
  if (!user) return badLink(res);
  res.send(page(`${list.Name} are on`, `<p>${esc(user.email)} will receive SenIQ ${list.name} again.</p><p><a href="/app">Open SenIQ</a></p>`));
});

// The signed-in user's email settings, plus what the report schedule works out to for them.
async function preferences(userId) {
  const u = await queryOne(
    'SELECT email, email_verified, email_alerts, email_reports, home_market, subscription_tier FROM users WHERE id = $1', [userId]);
  if (!u) return null;
  const holdings = await query('SELECT ticker, exchange, asset_class FROM portfolio WHERE user_id = $1', [userId]);
  const market = guessMarket(holdings, u.home_market);
  const paid = u.subscription_tier === 'plus' || u.subscription_tier === 'pro';
  const at = paid ? REPORT_EMAIL.DAILY : REPORT_EMAIL.WEEKLY;
  return {
    email: u.email, email_verified: u.email_verified, email_alerts: u.email_alerts, provider: emailEnabled(),
    email_reports: u.email_reports,
    home_market: u.home_market,                       // null = follow the portfolio
    report: {
      market, market_label: REPORT_EMAIL.MARKETS[market].label,
      kind: paid ? 'daily' : 'weekly',
      time: `${String(at.HOUR).padStart(2, '0')}:${String(at.MINUTE).padStart(2, '0')}`,
      time_zone: REPORT_EMAIL.MARKETS[market].timeZone,
    },
  };
}

router.get('/preferences', authMiddleware, async (req, res) => {
  const prefs = await preferences(req.user.id);
  if (!prefs) return res.status(404).json({ error: 'User not found' });
  res.json(prefs);
});

// Body: any of { email_alerts: boolean, email_reports: boolean, home_market: 'IN' | 'US' | null }.
router.put('/preferences', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const params = [];
  for (const field of ['email_alerts', 'email_reports']) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') return res.status(400).json({ error: `${field} must be true or false` });
    params.push(body[field]);
    sets.push(`${field} = $${params.length}`);
  }
  if (body.home_market !== undefined) {
    if (body.home_market !== null && !REPORT_EMAIL.MARKETS[body.home_market]) {
      return res.status(400).json({ error: `home_market must be one of ${Object.keys(REPORT_EMAIL.MARKETS).join(', ')}, or null to follow your portfolio` });
    }
    params.push(body.home_market);
    sets.push(`home_market = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  params.push(req.user.id);
  await queryOne(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
  res.json(await preferences(req.user.id));
});

module.exports = router;
