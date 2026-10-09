/**
 * Paper ledger — the stored record of a paper deployment.
 *
 * The Paper Trade page replays a deployment each time it is opened and keeps nothing. This
 * service is the other half: once a day it replays every deployment and writes down the
 * fills and the closing value of each completed day it has not written before
 * (migration 0042). What that buys:
 *   - a fill can be emailed, because the job runs whether or not anyone is looking;
 *   - the record is fixed: a price the data source revises later changes a fresh replay,
 *     not the fills already recorded.
 *
 * Rules the job keeps:
 *   - Completed days only. A bar dated today (UTC) may still be trading; it is stored on a
 *     later run. PAPER.MARK_CRON is set after every market it covers has closed.
 *   - Append-only. Nothing dated on or before the newest recorded fill (or day) is added,
 *     so a revised history cannot slip an older trade into the record. When a fresh replay
 *     disagrees with the record about which days traded, the deployment gets a note.
 *   - A deployment is marked once per UTC day. A failed attempt (engine offline) leaves it
 *     due, so the next run or the next start picks it up.
 *   - A stopped deployment is recorded through its stop date once, then left alone.
 *
 * Emails go to Pro users with a verified address and alert emails on, for fills at most
 * PAPER.NOTIFY_FRESH_DAYS old when first recorded. Older fills are history, never sent.
 */
const { PAPER, APP_URL, ALERT_EMAIL } = require('../config');
const { iso } = require('./strategyClient');

const dayOf = (ts) => String(ts).slice(0, 10);
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/**
 * Pure: what a replay adds to a deployment's record.
 *   replay — the engine's /api/backtest answer ({ fills, report: { equity_curve } })
 *   stored — { fills: [{ filled_at, filled_on, side }], lastDay } already in the ledger
 *   today  — 'YYYY-MM-DD' (UTC); rows dated today or later are left for a later run
 * → { fills, equity, note }
 */
function planLedger(replay, stored, today) {
  const seen = (stored && stored.fills) || [];
  const lastMs = seen.length ? Math.max(...seen.map((f) => new Date(f.filled_at).getTime())) : null;
  const lastDay = (stored && stored.lastDay) || null;

  const completed = (replay.fills || [])
    .map((f) => ({
      filled_at: f.timestamp,
      filled_on: dayOf(f.timestamp),
      side: String(f.side).toUpperCase(),
      quantity: Number(f.quantity),
      price: String(f.price),
      charges: String(f.charges || '0'),
    }))
    .filter((f) => f.filled_on < today);

  const fills = completed.filter((f) => lastMs == null || new Date(f.filled_at).getTime() > lastMs);

  // One value per day: the last point of that day (an intraday run has several).
  const byDay = new Map();
  for (const p of ((replay.report && replay.report.equity_curve) || [])) {
    byDay.set(dayOf(p.timestamp), { day: dayOf(p.timestamp), equity: String(p.equity), cash: String(p.cash), positions_value: String(p.positions_value) });
  }
  const equity = [...byDay.values()]
    .filter((p) => p.day < today && (lastDay == null || p.day > lastDay))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  // Does the replay still trade on the days the record says it did? Prices and sizes are
  // not compared: a dividend adjustment moves every past price a little without changing
  // what the strategy did.
  let note = null;
  if (lastMs != null) {
    const key = (day, side) => `${day}|${side}`;
    const recorded = seen.map((f) => key(f.filled_on, f.side)).sort();
    const replayed = completed.filter((f) => new Date(f.filled_at).getTime() <= lastMs).map((f) => key(f.filled_on, f.side)).sort();
    if (recorded.join(',') !== replayed.join(',')) {
      note = 'A fresh replay no longer matches the recorded trades — the price history was revised after they were recorded. The recorded ledger stands.';
    }
  }
  return { fills, equity, note };
}

/** Pure: should a fill recorded now be emailed? Only a recent fill on a running deployment. */
function notifyState(fill, row, today) {
  if (row.status !== 'active') return 'none';
  return fill.filled_on >= addDays(today, -PAPER.NOTIFY_FRESH_DAYS) ? 'pending' : 'none';
}

/** Pure: may this user be emailed about a paper fill? → null when yes, else the reason. */
function recipientBlock(user) {
  if (!user || !user.email) return 'no_address';
  if (user.subscription_tier !== 'pro') return 'not_pro';
  if (user.email_verified !== true) return 'unverified';
  if (user.email_alerts === false) return 'unsubscribed';
  return null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = (f) => (f.exchange === 'US' ? f.symbol : `${f.symbol}:${f.exchange}`);
const verb = (side) => (side === 'BUY' ? 'bought' : 'sold');
const price = (p) => Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Pure: one email for all of a user's newly recorded fills. */
function buildFillEmail(fills, { unsubscribeUrl: unsubUrl = null } = {}) {
  const one = fills.length === 1 ? fills[0] : null;
  const subject = one
    ? `${PAPER.EMAIL_SUBJECT_PREFIX} Paper trade: ${one.name} ${verb(one.side)} ${one.quantity} ${label(one)}`
    : `${PAPER.EMAIL_SUBJECT_PREFIX} ${fills.length} paper trades filled`;
  const url = `${APP_URL}${ALERT_EMAIL.DASHBOARD_PATH}`;
  const caveat = 'Paper trading is simulated: virtual money, a modelled fill price, and no order was placed anywhere. SenIQ is informational, not investment advice.';

  const lines = fills.map((f) => `${f.filled_on}  ${f.name}: ${verb(f.side)} ${f.quantity} ${label(f)} at ${price(f.price)}`);
  const text = [
    one ? 'A paper deployment traded.' : 'Your paper deployments traded.',
    '', ...lines, '',
    `Open Paper Trade: ${url}`, '', caveat,
    ...(unsubUrl ? ['', `You get this because alert emails are on for your SenIQ account. Stop them: ${unsubUrl}`] : []),
  ].join('\n');

  const cell = 'padding:4px 14px 4px 0';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
  <h2 style="font-size:18px;margin:0 0 12px">${one ? 'A paper deployment traded' : 'Your paper deployments traded'}</h2>
  <table style="border-collapse:collapse;font-size:14px;color:#333">
    ${fills.map((f) => `<tr><td style="${cell};color:#666">${esc(f.filled_on)}</td><td style="${cell}">${esc(f.name)}</td><td style="${cell}"><strong>${verb(f.side)} ${f.quantity} ${esc(label(f))}</strong></td><td style="padding:4px 0">at ${price(f.price)}</td></tr>`).join('\n    ')}
  </table>
  <p style="margin:18px 0"><a href="${esc(url)}" style="background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block;font-size:14px">Open Paper Trade</a></p>
  <p style="margin:14px 0 0;color:#999;font-size:12px">${esc(caveat)}</p>
  ${unsubUrl ? `<p style="margin:6px 0 0;color:#999;font-size:12px">You get this because alert emails are on for your SenIQ account. <a href="${esc(unsubUrl)}" style="color:#999">Stop alert emails</a></p>` : ''}
</div>`;
  return { subject, text, html };
}

// Replay one deployment and store what is new. Never throws for an expected failure:
// → { ok: true, fills, days } | { ok: false, status, error }
async function markDeployment(row, { today = utcDay(), replayFn } = {}) {
  const { query, queryOne, execute } = require('../db');
  const replay = replayFn || require('./strategyClient').replayPaper;

  const out = await replay(row);
  let error = null;
  if (out.status !== 200) error = out.status === 503 ? 'strategy engine is offline' : String((out.data && out.data.detail) || 'replay failed').slice(0, 300);
  else if (!Array.isArray(out.data.fills)) error = 'the strategy engine is older than the ledger: its replay has no fills list';
  if (error) {
    await execute('UPDATE paper_deployments SET last_mark_error = $2 WHERE id = $1', [row.id, error]);
    return { ok: false, status: out.status, error };
  }

  const stored = {
    fills: await query(
      'SELECT filled_at, filled_on::text AS filled_on, side FROM paper_fills WHERE deployment_id = $1', [row.id]),
    lastDay: (await queryOne(
      'SELECT max(day)::text AS day FROM paper_equity WHERE deployment_id = $1', [row.id]) || {}).day || null,
  };
  const plan = planLedger(out.data, stored, today);

  for (const f of plan.fills) {
    await execute(
      `INSERT INTO paper_fills (deployment_id, filled_at, filled_on, side, quantity, price, charges, notify)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (deployment_id, filled_at, side) DO NOTHING`,
      [row.id, f.filled_at, f.filled_on, f.side, f.quantity, f.price, f.charges, notifyState(f, row, today)]);
  }
  for (const p of plan.equity) {
    await execute(
      `INSERT INTO paper_equity (deployment_id, day, equity, cash, positions_value)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (deployment_id, day) DO NOTHING`,
      [row.id, p.day, p.equity, p.cash, p.positions_value]);
  }

  // A stopped deployment replays to its stop date; once that day is behind us it is complete.
  const closed = row.status === 'stopped' && row.stopped_at && iso(row.stopped_at) < today;
  await execute(
    `UPDATE paper_deployments
        SET last_marked_at = now(), last_mark_error = NULL,
            ledger_note = COALESCE($2::text, ledger_note),
            ledger_closed_at = CASE WHEN $3::boolean THEN now() ELSE ledger_closed_at END
      WHERE id = $1`,
    [row.id, plan.note, !!closed]);
  return { ok: true, fills: plan.fills.length, days: plan.equity.length };
}

// Email the fills waiting to be sent, one message per user. Never throws.
async function sendFillEmails({ today = utcDay(), sendEmailFn, emailEnabledFn } = {}) {
  const summary = { sent: 0, skipped: 0, failed: 0 };
  try {
    const { query, queryOne, execute } = require('../db');
    const mail = require('./emailService');
    const send = sendEmailFn || mail.sendEmail;
    const enabled = emailEnabledFn || mail.emailEnabled;
    const settle = (ids, state) => execute('UPDATE paper_fills SET notify = $2 WHERE id = ANY($1::bigint[])', [ids, state]);

    // A fill that waited too long (email was down for days) is no longer news.
    await execute(
      `UPDATE paper_fills SET notify = 'skipped' WHERE notify = 'pending' AND filled_on < $1::date`,
      [addDays(today, -PAPER.NOTIFY_FRESH_DAYS)]);

    const rows = await query(
      `SELECT f.id, f.filled_on::text AS filled_on, f.side, f.quantity, f.price,
              d.user_id, d.name, d.symbol, d.exchange
         FROM paper_fills f JOIN paper_deployments d ON d.id = f.deployment_id
        WHERE f.notify = 'pending'
        ORDER BY d.user_id, f.filled_at`);
    const byUser = new Map();
    for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r]);

    for (const [userId, fills] of byUser) {
      const ids = fills.map((f) => f.id);
      try {
        if (!enabled()) { await settle(ids, 'skipped'); summary.skipped++; continue; }
        const user = await queryOne(
          'SELECT email, email_verified, email_alerts, subscription_tier FROM users WHERE id = $1', [userId]);
        const blocked = recipientBlock(user);
        const unsub = mail.unsubscribeUrl(userId);
        const { subject, text, html } = buildFillEmail(fills, { unsubscribeUrl: unsub });
        if (blocked) {
          await settle(ids, 'skipped');
          summary.skipped++;
          if (user && user.email) await mail.logEmail({ userId, to: user.email, kind: 'paper_fill', subject, status: 'skipped', reason: blocked });
          continue;
        }
        const res = await send({
          to: user.email, subject, text, html, kind: 'paper_fill', userId,
          headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        // Not delivered → stays pending, and is tried again on the next run while still fresh.
        if (res && res.delivered) { await settle(ids, 'sent'); summary.sent++; }
        else summary.failed++;
      } catch (err) {
        summary.failed++;
        console.error(`Paper fill email error for user ${userId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Paper fill emails failed:', err.message);
  }
  return summary;
}

let running = false;

/**
 * The daily job: mark every deployment that is due, then send the fill emails.
 *   force — also mark deployments already marked today (the by-hand script).
 * → { due, marked, fills, days, failed: [{ id, error }], emails }
 */
async function runPaperMarks({ today = utcDay(), force = false, replayFn, sendEmailFn, emailEnabledFn } = {}) {
  const summary = { due: 0, marked: 0, fills: 0, days: 0, failed: [], emails: { sent: 0, skipped: 0, failed: 0 } };
  if (running) return summary;
  running = true;
  try {
    const { query } = require('../db');
    const rows = await query(
      `SELECT * FROM paper_deployments
        WHERE ledger_closed_at IS NULL
          AND ($2::boolean OR last_marked_at IS NULL OR (last_marked_at AT TIME ZONE 'UTC')::date < $1::date)
        ORDER BY id`,
      [today, force]);
    summary.due = rows.length;
    for (const row of rows) {
      const r = await markDeployment(row, { today, replayFn });
      if (r.ok) { summary.marked++; summary.fills += r.fills; summary.days += r.days; continue; }
      summary.failed.push({ id: row.id, error: r.error });
      if (r.status === 503) break; // engine offline: the rest would fail the same way
    }
    if (summary.fills || summary.marked) summary.emails = await sendFillEmails({ today, sendEmailFn, emailEnabledFn });
  } finally {
    running = false;
  }
  return summary;
}

// What the Paper Trade page and /v1 show: the recorded fills (newest first) and the
// recorded daily values (oldest first), with when the job last ran.
async function readLedger(row) {
  const { query } = require('../db');
  const [fills, equity] = await Promise.all([
    query(
      `SELECT filled_on::text AS filled_on, side, quantity, price, charges
         FROM paper_fills WHERE deployment_id = $1 ORDER BY filled_at DESC LIMIT $2`,
      [row.id, PAPER.LEDGER_FILLS]),
    query(
      `SELECT day, equity FROM (
         SELECT day::text AS day, equity FROM paper_equity
          WHERE deployment_id = $1 ORDER BY day DESC LIMIT $2) t ORDER BY day`,
      [row.id, PAPER.LEDGER_DAYS]),
  ]);
  return {
    fills: fills.map((f) => ({ date: f.filled_on, side: f.side, quantity: f.quantity, price: String(f.price), charges: String(f.charges) })),
    equity: equity.map((p) => ({ date: p.day, equity: String(p.equity) })),
    last_marked_at: row.last_marked_at || null,
    last_error: row.last_mark_error || null,
    note: row.ledger_note || null,
    closed: !!row.ledger_closed_at,
    basis: 'Recorded once a day from completed days only. Simulated fills on virtual money — no order was placed.',
  };
}

module.exports = {
  planLedger, notifyState, recipientBlock, buildFillEmail,
  markDeployment, sendFillEmails, runPaperMarks, readLedger, utcDay, addDays,
};
