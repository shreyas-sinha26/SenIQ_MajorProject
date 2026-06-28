/**
 * Daily-brief orchestration + cost guardrails (Engine Phase E5).
 *
 * Pipeline per user: load yesterday's packet → build today's grounding packet (with the
 * diff) → decide whether Claude is allowed (guardCheck) → write the brief → persist it
 * (cache) → log the Claude call (cost). A brief is generated ONCE per user per day and
 * re-read after that — never regenerated on demand.
 *
 * The guardrails (the user is firm: never let the Claude key run a bill):
 *   - server-scheduled only — generateDailyBriefs() runs from cron; the manual route hits
 *     the SAME per-user quota, so there is no loopable on-demand "generate" path.
 *   - per-user daily quota — checked BEFORE any Claude call (count of today's claude_calls).
 *   - global daily spend kill-switch — stop calling Claude past the day's USD ceiling.
 *   - hard output-token cap per call (in briefWriter) + a trimmed/clamped packet.
 *   - every Claude call logged with tokens + estimated cost.
 * When any guard fails (or no key / flag off), the brief still ships via the free
 * deterministic writer — only the Claude upgrade is withheld.
 */

const { REPORTS, FEATURES } = require('../config');
const { buildGroundingPacket } = require('./grounding');
const { writeBrief } = require('./briefWriter');

function estimateCost(usage) {
  return (usage.input / 1e6) * REPORTS.PRICE_PER_MTOK.input + (usage.output / 1e6) * REPORTS.PRICE_PER_MTOK.output;
}

/**
 * Pure guardrail decision. Returns { allow, reason }. State is passed in so it's
 * unit-testable without a DB or env.
 *   state = { flagOn, hasKey, userCallsToday, quota, globalSpendToday, ceiling }
 */
function guardCheck(state) {
  const { flagOn, hasKey, userCallsToday, quota, globalSpendToday, ceiling } = state;
  if (!flagOn) return { allow: false, reason: 'claude_reports_disabled' };
  if (!hasKey) return { allow: false, reason: 'no_api_key' };
  if (globalSpendToday >= ceiling) return { allow: false, reason: 'global_kill_switch' };
  if (userCallsToday >= quota) return { allow: false, reason: 'user_quota_exceeded' };
  return { allow: true, reason: 'ok' };
}

// Most recent stored packet for a user STRICTLY before `date` — the diff baseline.
async function loadPrevPacket(userId, date) {
  const { queryOne } = require('../db');
  const row = await queryOne(
    `SELECT packet FROM daily_briefs WHERE user_id = $1 AND brief_date < $2 ORDER BY brief_date DESC LIMIT 1`,
    [userId, date]
  );
  return row ? row.packet : null;
}

/**
 * Generate (or return the cached) daily brief for one user.
 * Options: { force } regenerates even if today's brief exists; { manual } is informational
 * (the quota still applies — manual is not a bypass).
 */
async function generateBriefForUser(userId, { force = false, now = new Date() } = {}) {
  const { query, queryOne, execute } = require('../db');
  const date = now.toISOString().slice(0, 10);

  if (!force) {
    const existing = await queryOne('SELECT * FROM daily_briefs WHERE user_id = $1 AND brief_date = $2', [userId, date]);
    if (existing) return { ...existing, cached: true };
  }

  const prev = await loadPrevPacket(userId, date);
  const packet = await buildGroundingPacket(userId, prev, now);

  // ── Guardrails: decide whether Claude is allowed for this run ──
  const dayStart = `${date} 00:00:00+00`;
  const callRow = await queryOne(
    'SELECT count(*) c FROM claude_calls WHERE user_id = $1 AND created_at >= $2',
    [userId, dayStart]
  );
  const spendRow = await queryOne(
    'SELECT COALESCE(sum(cost_usd),0) s FROM claude_calls WHERE created_at >= $1',
    [dayStart]
  );
  const guard = guardCheck({
    flagOn: FEATURES.CLAUDE_REPORTS,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    userCallsToday: Number(callRow.c),
    quota: REPORTS.PER_USER_DAILY_QUOTA,
    globalSpendToday: Number(spendRow.s),
    ceiling: REPORTS.GLOBAL_DAILY_USD_CEILING,
  });

  const brief = await writeBrief(packet, { allowClaude: guard.allow });

  if (brief.writer === 'claude') {
    const cost = estimateCost(brief.usage);
    await execute(
      `INSERT INTO claude_calls (user_id, kind, model, input_tokens, output_tokens, cost_usd)
       VALUES ($1, 'daily_brief', $2, $3, $4, $5)`,
      [userId, brief.model, brief.usage.input, brief.usage.output, cost]
    );
    if (Number(spendRow.s) + cost >= REPORTS.GLOBAL_DAILY_USD_CEILING) {
      console.warn(`⚠️  Claude daily spend kill-switch tripped (~$${(Number(spendRow.s) + cost).toFixed(2)} ≥ $${REPORTS.GLOBAL_DAILY_USD_CEILING}). Further briefs degrade to the free writer today.`);
    }
  }

  const saved = await queryOne(
    `INSERT INTO daily_briefs (user_id, brief_date, packet, narrative, headline, writer, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, brief_date)
     DO UPDATE SET packet = EXCLUDED.packet, narrative = EXCLUDED.narrative, headline = EXCLUDED.headline,
                   writer = EXCLUDED.writer, model = EXCLUDED.model, generated_at = now()
     RETURNING *`,
    [userId, date, packet, brief.narrative, brief.headline, brief.writer, brief.model]
  );
  return { ...saved, guard: guard.reason, cached: false };
}

/** Cron entry: generate today's brief for every user with a portfolio. */
async function generateDailyBriefs(now = new Date()) {
  const { query } = require('../db');
  const users = await query('SELECT DISTINCT user_id FROM portfolio');
  let claude = 0, fallback = 0;
  for (const { user_id } of users) {
    try {
      const b = await generateBriefForUser(user_id, { now });
      if (b.writer === 'claude') claude++; else fallback++;
    } catch (err) {
      console.error(`Daily brief failed for user ${user_id}:`, err.message);
    }
  }
  return { users: users.length, claude, fallback };
}

async function getLatestBrief(userId) {
  const { queryOne } = require('../db');
  return queryOne('SELECT * FROM daily_briefs WHERE user_id = $1 ORDER BY brief_date DESC LIMIT 1', [userId]);
}

module.exports = { generateBriefForUser, generateDailyBriefs, getLatestBrief, guardCheck, estimateCost };
