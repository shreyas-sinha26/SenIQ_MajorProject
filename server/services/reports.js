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
 *   - per-user daily quota, by plan (TIERS[tier].claudeReportsPerDay: Free 0, Plus 1, Pro 2) —
 *     checked BEFORE any Claude call (count of today's daily_brief calls). Free accounts
 *     cannot open the brief, so theirs is always the code-written one.
 *   - global daily spend kill-switch — stop calling Claude past the day's USD ceiling.
 *   - hard output-token cap per call (in briefWriter) + a trimmed/clamped packet.
 *   - every Claude call logged with tokens + estimated cost.
 * When any guard fails (or no key / flag off), the brief still ships via the free
 * deterministic writer — only the Claude upgrade is withheld.
 */

const { REPORTS, FEATURES, TIERS } = require('../config');
const { buildGroundingPacket } = require('./grounding');
const { writeBrief } = require('./briefWriter');

// What a call cost. A router reports the exact charge (usage.cost_usd); otherwise it is
// estimated from token counts at config pricing.
function estimateCost(usage) {
  if (usage.cost_usd > 0) return usage.cost_usd;
  return (usage.input / 1e6) * REPORTS.PRICE_PER_MTOK.input + (usage.output / 1e6) * REPORTS.PRICE_PER_MTOK.output;
}

// Pure: how many Claude-written briefs a plan allows a day. An unknown plan gets Free's.
function briefQuota(tier) {
  const plan = Object.hasOwn(TIERS, tier) ? TIERS[tier] : TIERS.free;
  return Number.isFinite(plan.claudeReportsPerDay) ? plan.claudeReportsPerDay : 0;
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

// brief_date is a DATE: selected as text so it reaches the browser as the stored day (pg would
// otherwise return a local-midnight Date). Listed after `*`, it replaces that column in the row.
// The alias makes a bare `ORDER BY brief_date` ambiguous — qualify it with the table name.
const BRIEF_COLS = '*, brief_date::text AS brief_date';

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
  const { userLocalDate, userDayStart } = require('./userTime');
  const date = await userLocalDate(userId, now); // the user's own date, not the server's

  if (!force) {
    const existing = await queryOne(`SELECT ${BRIEF_COLS} FROM daily_briefs WHERE user_id = $1 AND brief_date = $2`, [userId, date]);
    if (existing) return { ...existing, cached: true };
  }

  const prev = await loadPrevPacket(userId, date);
  const packet = await buildGroundingPacket(userId, prev, now);

  // ── Guardrails: decide whether Claude is allowed for this run ──
  // The user's limit counts from their own midnight; the global spend ceiling is one
  // figure for everyone, so it stays on the UTC day.
  const userDay = (await userDayStart(userId, now)).toISOString();
  const utcDay = `${now.toISOString().slice(0, 10)} 00:00:00+00`;
  const callRow = await queryOne(
    "SELECT count(*) c FROM claude_calls WHERE user_id = $1 AND kind = 'daily_brief' AND created_at >= $2",
    [userId, userDay]
  );
  const spendRow = await queryOne(
    'SELECT COALESCE(sum(cost_usd),0) s FROM claude_calls WHERE created_at >= $1',
    [utcDay]
  );
  const account = await queryOne('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
  const guard = guardCheck({
    flagOn: FEATURES.CLAUDE_REPORTS,
    hasKey: require('./llmClient').llmConfigured(),
    userCallsToday: Number(callRow.c),
    quota: briefQuota(account && account.subscription_tier),
    globalSpendToday: Number(spendRow.s),
    ceiling: REPORTS.GLOBAL_DAILY_USD_CEILING,
  });

  // A refresh that may not use Claude (today's allowance is spent, or the spend ceiling is
  // reached) keeps a Claude-written brief as it is. Writing over it with the code-written
  // text would leave the user with a worse brief for pressing Refresh.
  if (force && !guard.allow) {
    const existing = await queryOne(`SELECT ${BRIEF_COLS} FROM daily_briefs WHERE user_id = $1 AND brief_date = $2`, [userId, date]);
    if (existing && existing.writer === 'claude') return { ...existing, guard: guard.reason, cached: true, kept: true };
  }

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
     RETURNING ${BRIEF_COLS}`,
    [userId, date, packet, brief.narrative, brief.headline, brief.writer, brief.model]
  );
  return { ...saved, guard: guard.reason, cached: false };
}

// Pure: is it time to write this user's brief? Inside the window that opens at
// REPORTS.LOCAL_TIME on their own clock.
function briefDue(clock) {
  const start = REPORTS.LOCAL_TIME.HOUR * 60 + REPORTS.LOCAL_TIME.MINUTE;
  return clock.minutes >= start && clock.minutes < start + REPORTS.LOCAL_WINDOW_MINUTES;
}

/**
 * Cron entry (every few minutes): write today's brief for each user whose own morning has
 * come and who does not have one yet. A user's brief is written once per local day —
 * generateBriefForUser returns the stored one after that.
 */
async function generateDailyBriefs(now = new Date()) {
  const { query } = require('../db');
  const { userZone, localClock } = require('./userTime');
  const users = await query('SELECT DISTINCT user_id FROM portfolio');
  let due = 0, claude = 0, fallback = 0;
  for (const { user_id } of users) {
    try {
      if (!briefDue(localClock(now, (await userZone(user_id)).timeZone))) continue;
      const b = await generateBriefForUser(user_id, { now });
      if (b.cached) continue;
      due++;
      if (b.writer === 'claude') claude++; else fallback++;
    } catch (err) {
      console.error(`Daily brief failed for user ${user_id}:`, err.message);
    }
  }
  return { users: users.length, due, claude, fallback };
}

async function getLatestBrief(userId) {
  const { queryOne } = require('../db');
  return queryOne(`SELECT ${BRIEF_COLS} FROM daily_briefs WHERE user_id = $1 ORDER BY daily_briefs.brief_date DESC LIMIT 1`, [userId]);
}

module.exports = { generateBriefForUser, generateDailyBriefs, briefDue, briefQuota, getLatestBrief, guardCheck, estimateCost };
