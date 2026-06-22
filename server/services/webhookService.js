/**
 * Outbound webhooks (Pro/API tier) — the genuine "webhook" feature.
 *
 * SEC EDGAR and the free congress portals don't push, so smart-money INGEST is a poller
 * that emulates a webhook (see smartMoney/index.js). What we DO offer as a real webhook is
 * OUTBOUND: a Pro user registers a URL + secret and we POST them each event so their own
 * systems react. Deliveries are HMAC-signed (X-SenIQ-Signature: sha256=…) so the receiver
 * can verify authenticity, best-effort and non-blocking — a slow/broken endpoint never
 * stalls the pipeline, and a chronically-failing one auto-disables.
 */

const crypto = require('crypto');
const { query, execute } = require('../db');
const { SMART_MONEY } = require('../config');
const { fetchWithTimeout } = require('./ingest/util');

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function matchesType(eventTypes, type) {
  const list = String(eventTypes || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') || list.includes(type) || list.includes(type.split('.')[0]);
}

async function deliverOne(hook, event) {
  const body = JSON.stringify({ type: event.type, event, delivered_at: new Date().toISOString() });
  let status = 0;
  try {
    const res = await fetchWithTimeout(
      hook.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SenIQ-Signature': sign(hook.secret, body),
          'X-SenIQ-Event': event.type,
          'User-Agent': 'SenIQ-Webhook/1.0',
        },
        body,
      },
      SMART_MONEY.WEBHOOK_TIMEOUT_MS
    );
    status = res.status;
  } catch {
    status = 0; // network error / timeout
  }

  const ok = status >= 200 && status < 300;
  await execute(
    `UPDATE webhooks
        SET last_status = $1,
            last_attempt_at = now(),
            failure_count = $2,
            active = $3
      WHERE id = $4`,
    [
      status,
      ok ? 0 : hook.failure_count + 1,
      ok ? true : hook.failure_count + 1 < SMART_MONEY.WEBHOOK_MAX_FAILURES,
      hook.id,
    ]
  );
  return ok;
}

// Fan an event out to all of a user's active webhooks subscribed to its type.
async function dispatchToUser(userId, event) {
  const hooks = await query(
    'SELECT * FROM webhooks WHERE user_id = $1 AND active = true',
    [userId]
  );
  const targets = hooks.filter((h) => matchesType(h.event_types, event.type));
  await Promise.allSettled(targets.map((h) => deliverOne(h, event)));
  return targets.length;
}

module.exports = { dispatchToUser, sign, matchesType };
