/**
 * Report emails — the scheduled read (config.REPORT_EMAIL).
 *
 *   Free       → weekly summary (Sunday evening, local time)
 *   Plus / Pro → the daily brief (weekday mornings, before the user's market opens)
 *
 * Who gets one: a verified address, report emails switched on, at least one holding.
 * When: decided per user from their market's local clock — users.home_market, or the
 * market most of their stocks trade in. The job runs every few minutes; a report is
 * claimed in report_sends before it is sent, so it goes out once per local day.
 *
 * The report is a PDF attachment (reportPdf.js); the email body is one line saying what is
 * attached. The daily report is drawn from the same brief the app shows
 * (reports.generateBriefForUser — its Claude guardrails and free fallback writer apply
 * unchanged). For Plus and Pro the headline cards' lines are rewritten by Claude under the
 * same guardrails (cardWriter.js); everything else in the report is written by code.
 */

const { REPORT_EMAIL } = require('../config');
const { UNIVERSE } = require('../data/universe');

const COUNTRY_BY_TICKER = new Map(UNIVERSE.map((c) => [c.ticker, c.country]));

// ── Pure: which market is this portfolio mostly in? ──
// Stocks only (crypto and commodities trade everywhere). A stored choice always wins.
function guessMarket(holdings, stored = null) {
  if (stored && REPORT_EMAIL.MARKETS[stored]) return stored;
  let india = 0, us = 0;
  for (const h of holdings || []) {
    if (h.asset_class && h.asset_class !== 'equity') continue;
    const exchange = String(h.exchange || '').toUpperCase();
    const country = COUNTRY_BY_TICKER.get(h.ticker);
    if (REPORT_EMAIL.IN_EXCHANGES.includes(exchange) || (!exchange && country === 'IN')) india++;
    else us++;
  }
  if (india === us) return REPORT_EMAIL.DEFAULT_MARKET;
  return india > us ? 'IN' : 'US';
}

// ── Pure: the wall clock in a time zone → { date:'YYYY-MM-DD', weekday:0–6, minutes } ──
function localClock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// ── Pure: which report, if any, is this user due right now? → 'daily' | 'weekly' | null ──
function dueReport(tier, clock) {
  const inWindow = (hour, minute) => {
    const start = hour * 60 + minute;
    return clock.minutes >= start && clock.minutes < start + REPORT_EMAIL.SEND_WINDOW_MINUTES;
  };
  const { DAILY, WEEKLY } = REPORT_EMAIL;
  if (tier === 'plus' || tier === 'pro') {
    return DAILY.WEEKDAYS.includes(clock.weekday) && inWindow(DAILY.HOUR, DAILY.MINUTE) ? 'daily' : null;
  }
  return clock.weekday === WEEKLY.WEEKDAY && inWindow(WEEKLY.HOUR, WEEKLY.MINUTE) ? 'weekly' : null;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const REPORT_NAME = { daily: 'daily brief', weekly: 'weekly summary' };

// 'YYYY-MM-DD' (the user's local date) → "Thursday, 8 October 2026". Pure.
function dateLabel(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Pure: the email that carries a report. The report itself is the attached PDF
 * (reportPdf.js); the body only says what it is, and the subject leads with the report's
 * verdict when one is passed. → { subject, text, html, filename }
 */
function buildReportEmail(kind, { name, date, verdict = null }, { unsubscribeUrl = null } = {}) {
  const what = REPORT_NAME[kind] || REPORT_NAME.daily;
  const day = dateLabel(date);
  const hello = name ? `Hi ${String(name).trim().split(/\s+/)[0]},` : 'Hi,';
  const line = `Here is your SenIQ ${what} for ${day}. It is attached to this email as a PDF.`;
  const stop = 'You get this because report emails are on for your SenIQ account.';

  // The subject carries the report's verdict when there is one, so it says whether to open it.
  const short = (t) => { const c = String(t || '').replace(/\s+/g, ' ').trim(); return c.length > 70 ? `${c.slice(0, 69).trimEnd()}…` : c; };
  const lead = !verdict ? `Your ${what}`
    : verdict.level === 'check' ? `${verdict.text.replace(/ (today|this week)$/, '')}: ${short(verdict.detail)}`
      : `Nothing needs your attention ${kind === 'weekly' ? 'this week' : 'today'}`;
  const subject = `${REPORT_EMAIL.SUBJECT_PREFIX} ${lead} — ${day.replace(/^\w+, /, '')}`;
  const text = [hello, '', line, ...(unsubscribeUrl ? ['', `${stop} Stop them: ${unsubscribeUrl}`] : [])].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;color:#111;font-size:14px;line-height:1.55">
  <p style="margin:0 0 12px">${esc(hello)}</p>
  <p style="margin:0 0 12px">${esc(line)}</p>
  ${unsubscribeUrl ? `<p style="margin:20px 0 0;color:#999;font-size:12px">${esc(stop)} <a href="${esc(unsubscribeUrl)}" style="color:#999">Stop report emails</a></p>` : ''}
</div>`;
  const filename = `SenIQ-${kind === 'weekly' ? 'Weekly-Summary' : 'Daily-Brief'}-${date}.pdf`;
  return { subject, text, html, filename };
}

// ── What goes in each report (reads the engine's own data; no model call here) ──
// Both return the object reportPdf.buildReportPdf draws.
// The explaining sections (reportInsights.js). A report still goes out without them.
async function insightsFor(user, market, kind) {
  try {
    return await require('./reportInsights').buildReportInsights(user.id, { market, kind, ...(kind === 'weekly' ? { maxCards: 1 } : {}) });
  } catch (err) {
    console.error(`Report insights failed for user ${user.id}:`, err.message);
    return null;
  }
}

// Plus and Pro: Claude rewrites the cards' template lines (cardWriter.js — guardrailed,
// checked per card, template kept on any doubt). The verdict is not touched.
async function withWrittenCards(user, insights) {
  if (!insights || !(insights.cards || []).length) return insights;
  try {
    const { cards } = await require('./cardWriter').writeCardsForUser(user.id, user.subscription_tier, insights.cards);
    return { ...insights, cards };
  } catch (err) {
    console.error(`Report card rewrite failed for user ${user.id}:`, err.message);
    return insights;
  }
}

async function dailyReport(user, date, market) {
  const { generateBriefForUser } = require('./reports');
  const brief = await generateBriefForUser(user.id); // today's brief: cached, or written now
  const packet = brief.packet || {};
  return {
    kind: 'daily', name: user.name, dateLabel: dateLabel(date), marketLabel: REPORT_EMAIL.MARKETS[market].label,
    headline: brief.headline, narrative: brief.narrative, writer: brief.writer,
    events: packet.top_events || [], moreEvents: 0,
    holdings: (packet.portfolio && packet.portfolio.top_holdings) || [],
    changed: packet.changed || null, smartMoney: packet.smart_money || null,
    insights: await withWrittenCards(user, await insightsFor(user, market, 'daily')),
  };
}

async function weeklyReport(user, date, market) {
  const { queryOne } = require('../db');
  const { getImpactFeed } = require('./impactScoring');
  const { topHoldings } = require('./grounding');
  // Events live 7 days, so the ranked feed is the week. Only its top row is shown; the
  // total is counted separately so it is not capped by the feed's limit.
  const feed = await getImpactFeed(user.id, 1);
  const ranked = await queryOne('SELECT count(*)::int AS n FROM event_portfolio_impact WHERE user_id = $1', [user.id]);
  const alerts = await queryOne(
    "SELECT count(*)::int AS n FROM alerts WHERE user_id = $1 AND created_at > now() - interval '7 days'", [user.id]);
  const holdings = await topHoldings(user.id);
  // Free sees the single most important event (the same limit as the in-app feed).
  const events = feed.slice(0, 1).map((e) => ({
    title: e.title, source: e.source, last_seen: e.published_at,
    exposure_pct: Number(e.exposure_pct), direction: e.direction, impact_score: Number(e.impact_score),
  }));
  const total = ranked.n;
  return {
    kind: 'weekly', name: user.name, dateLabel: `Week ending ${dateLabel(date)}`, marketLabel: REPORT_EMAIL.MARKETS[market].label,
    events, moreEvents: Math.max(0, total - 1), holdings, alertCount: alerts.n,
    insights: await insightsFor(user, market, 'weekly'),
    note: total
      ? `Across your ${holdings.length} holding${holdings.length === 1 ? '' : 's'}, SenIQ tracked ${total} event${total === 1 ? '' : 's'} this week` +
        `${alerts.n ? ` and raised ${alerts.n} alert${alerts.n === 1 ? '' : 's'}` : ''}. The full ranked feed and a daily brief come with Plus.`
      : 'A quiet week: no event cleared the bar for your holdings.',
  };
}

/**
 * Send every report that is due now. Never throws. Returns { sent, failed, due }.
 * deps are injectable for tests: { now, sendEmailFn, emailEnabledFn, buildPdfFn }.
 */
async function runReportEmails(deps = {}) {
  const email = require('./emailService');
  const { now = new Date(), sendEmailFn = email.sendEmail, emailEnabledFn = email.emailEnabled, buildPdfFn = require('./reportPdf').buildReportPdf } = deps;
  const summary = { sent: 0, failed: 0, due: 0 };
  try {
    if (!emailEnabledFn()) return summary;
    const { query, queryOne, execute } = require('../db');
    const users = await query(
      `SELECT u.id, u.email, u.name, u.subscription_tier, u.home_market
         FROM users u
        WHERE u.email_verified AND u.email_reports
          AND EXISTS (SELECT 1 FROM portfolio p WHERE p.user_id = u.id)`);

    for (const user of users) {
      let claimed = null; // [user id, kind, local date] once this run holds the slot
      const release = () => claimed && execute(
        'DELETE FROM report_sends WHERE user_id = $1 AND kind = $2 AND report_date = $3', claimed).catch(() => {});
      try {
        const holdings = await query('SELECT ticker, exchange, asset_class FROM portfolio WHERE user_id = $1', [user.id]);
        const market = guessMarket(holdings, user.home_market);
        const clock = localClock(now, REPORT_EMAIL.MARKETS[market].timeZone);
        const kind = dueReport(user.subscription_tier, clock);
        if (!kind) continue;

        // Claim the slot first: only the run that inserts the row sends the report.
        const claim = await queryOne(
          `INSERT INTO report_sends (user_id, kind, report_date) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING user_id`, [user.id, kind, clock.date]);
        if (!claim) continue;
        claimed = [user.id, kind, clock.date];
        summary.due++;

        const report = kind === 'daily' ? await dailyReport(user, clock.date, market) : await weeklyReport(user, clock.date, market);
        const pdf = await buildPdfFn(report);
        const unsub = email.unsubscribeUrl(user.id, 'reports');
        const { subject, text, html, filename } = buildReportEmail(kind, { name: user.name, date: clock.date, verdict: report.insights && report.insights.verdict }, { unsubscribeUrl: unsub });
        const res = await sendEmailFn({
          to: user.email, subject, text, html, kind: `report_${kind}`, userId: user.id,
          attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
          headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        if (res && res.delivered) {
          summary.sent++;
        } else {
          // Not delivered: give the slot back so the next run inside the window tries again.
          summary.failed++;
          await release();
        }
      } catch (err) {
        summary.failed++;
        await release();
        console.error(`Report email error for user ${user.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Report email run failed:', err.message);
  }
  return summary;
}

module.exports = { guessMarket, localClock, dueReport, dateLabel, buildReportEmail, dailyReport, weeklyReport, runReportEmails };
