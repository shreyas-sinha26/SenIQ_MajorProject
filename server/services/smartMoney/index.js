/**
 * Smart-money orchestrator (Phase 3).
 *
 * Emulates a webhook: a poller (cron, every SMART_MONEY.POLL_CRON) watches EDGAR 13F
 * submissions + the congress feed and, on a NEW filing/disclosure, emits an internal
 * event → instant alert to following / holding users, and POSTs registered outbound
 * webhooks. These events are rare + discrete, so they bypass the news materiality score.
 *
 * Backfill guard: the FIRST time we see a fund/congress, we ingest silently (no alert
 * blast for historical filings); only records discovered AFTER a baseline exists alert.
 */

const { query, queryOne, execute } = require('../../db');
const { FEATURES, SMART_MONEY } = require('../../config');
const { fetchRecent13F, fetchHoldings } = require('./edgar');
const { fetchCongressTrades } = require('./congress');
const { dispatchToUser } = require('../webhookService');

// Normalize a politician name to a stable follow key.
const polKey = (name) => String(name).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

// ─── Event fan-out: alerts + outbound webhooks ────────────────────────────────
// Recipients = users following the entity ∪ users holding any affected ticker.
async function emitEvent({ event, entityType, entityRef, tickers = [], alertTicker = null, message }) {
  const followers = await query(
    'SELECT DISTINCT user_id FROM followed_entities WHERE entity_type = $1 AND entity_ref = $2',
    [entityType, entityRef]
  );
  let holders = [];
  const tlist = [...new Set(tickers.filter(Boolean))];
  if (tlist.length) {
    holders = await query('SELECT DISTINCT user_id FROM portfolio WHERE ticker = ANY($1)', [tlist]);
  }

  const recipients = [...new Set([...followers, ...holders].map((r) => Number(r.user_id)))];
  for (const userId of recipients) {
    await execute(
      `INSERT INTO alerts (user_id, ticker, alert_type, message) VALUES ($1, $2, $3, $4)`,
      [userId, alertTicker, 'smart_money', message]
    );
    try {
      await dispatchToUser(userId, event);
    } catch (err) {
      console.warn(`   ⚠️  webhook dispatch failed for user ${userId}: ${err.message}`);
    }
  }
  return recipients.length;
}

// ─── Institutions (13F via EDGAR) ─────────────────────────────────────────────
function diffChangeType(priorSharesByCusip, cusip, shares) {
  if (!priorSharesByCusip) return 'baseline';
  if (!(cusip in priorSharesByCusip)) return 'new';
  const prev = priorSharesByCusip[cusip];
  if (shares > prev * 1.0001) return 'added';
  if (shares < prev * 0.9999) return 'reduced';
  return 'unchanged';
}

async function priorHoldingsMap(institutionId, periodOfReport) {
  const prior = await queryOne(
    `SELECT id FROM institution_filings
      WHERE institution_id = $1 AND period_of_report IS NOT NULL
        AND ($2::date IS NULL OR period_of_report < $2::date)
      ORDER BY period_of_report DESC LIMIT 1`,
    [institutionId, periodOfReport]
  );
  if (!prior) return null;
  const rows = await query('SELECT cusip, shares FROM institution_holdings WHERE filing_id = $1', [prior.id]);
  const map = {};
  for (const r of rows) map[r.cusip] = Number(r.shares);
  return map;
}

function summarizeChanges(name, period, changes) {
  const buckets = { new: [], added: [], reduced: [] };
  for (const c of changes) if (buckets[c.change_type]) buckets[c.change_type].push(c.ticker || c.issuer_name);
  const parts = [];
  if (buckets.new.length) parts.push(`new ${buckets.new.slice(0, 3).join(', ')}`);
  if (buckets.added.length) parts.push(`added ${buckets.added.slice(0, 3).join(', ')}`);
  if (buckets.reduced.length) parts.push(`reduced ${buckets.reduced.slice(0, 3).join(', ')}`);
  const tail = parts.length ? ` — ${parts.join('; ')}` : '';
  return `🏛️ ${name} filed its ${period || 'latest'} 13F${tail}`;
}

async function ingestFiling(inst, filing, { silent }) {
  const holdings = await fetchHoldings(inst.cik, filing.accession, filing.reportDate);
  if (!holdings.length) return { inserted: false };

  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  const priorMap = await priorHoldingsMap(inst.id, filing.reportDate);

  const filingRow = await queryOne(
    `INSERT INTO institution_filings (institution_id, accession, form, period_of_report, filed_at, holdings_count, total_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (accession) DO NOTHING
     RETURNING id`,
    [inst.id, filing.accession, filing.form, filing.reportDate, filing.filingDate, holdings.length, totalValue]
  );
  if (!filingRow) return { inserted: false }; // raced / already present

  const changes = [];
  for (const h of holdings) {
    const change_type = diffChangeType(priorMap, h.cusip, h.shares);
    const pct = totalValue > 0 ? (h.value / totalValue) * 100 : 0;
    await execute(
      `INSERT INTO institution_holdings (institution_id, filing_id, cusip, ticker, issuer_name, shares, value, pct_of_portfolio, change_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (filing_id, cusip) DO NOTHING`,
      [inst.id, filingRow.id, h.cusip, h.ticker, h.issuer_name, h.shares, h.value, pct, change_type]
    );
    if (change_type === 'new' || change_type === 'added' || change_type === 'reduced') {
      changes.push({ ...h, change_type, pct_of_portfolio: pct });
    }
  }

  if (!silent) {
    // Most notable moves first: by |value|, capped.
    const top = changes.sort((a, b) => b.value - a.value).slice(0, 6);
    const message = summarizeChanges(inst.name, periodLabel(filing.reportDate), top);
    const event = {
      type: 'smart_money.institution_filing',
      entity_type: 'institution',
      entity_ref: inst.slug,
      entity_name: inst.name,
      manager: inst.manager,
      cik: inst.cik,
      accession: filing.accession,
      period_of_report: filing.reportDate,
      filed_at: filing.filingDate,
      tickers: top.map((c) => c.ticker).filter(Boolean),
      changes: top.map((c) => ({ ticker: c.ticker, issuer_name: c.issuer_name, change_type: c.change_type, value: c.value, pct_of_portfolio: c.pct_of_portfolio })),
      message,
    };
    const reached = await emitEvent({
      event,
      entityType: 'institution',
      entityRef: inst.slug,
      tickers: event.tickers,
      alertTicker: top[0]?.ticker || null,
      message,
    });
    return { inserted: true, alerted: reached };
  }
  return { inserted: true, alerted: 0 };
}

function periodLabel(reportDate) {
  if (!reportDate) return null;
  const d = new Date(reportDate);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${d.getUTCFullYear()}`;
}

async function pollInstitutions() {
  const institutions = await query('SELECT * FROM institutions ORDER BY id');
  let newFilings = 0;
  let alerts = 0;

  for (const inst of institutions) {
    try {
      const stored = await queryOne(
        'SELECT count(*)::int AS n, max(filed_at) AS max_filed FROM institution_filings WHERE institution_id = $1',
        [inst.id]
      );
      const isBaseline = stored.n === 0;
      const maxFiled = stored.max_filed ? new Date(stored.max_filed) : null;

      const recent = await fetchRecent13F(inst.cik, 4);
      const known = await query('SELECT accession FROM institution_filings WHERE institution_id = $1', [inst.id]);
      const knownSet = new Set(known.map((k) => k.accession));
      let fresh = recent.filter((f) => !knownSet.has(f.accession));

      if (isBaseline) {
        // First contact: ingest the 2 most-recent silently (gives an immediate change diff
        // in the UI) — never alert on historical filings.
        fresh = fresh.slice(0, 2);
      } else {
        // Steady state: only a genuinely NEWLY-DISCLOSED filing alerts. A historical filing
        // we simply hadn't fetched before (filed on/before what we already have) is skipped,
        // so it can't masquerade as news.
        fresh = fresh.filter((f) => f.filingDate && maxFiled && new Date(f.filingDate) > maxFiled);
      }
      // Oldest first so a newer filing diffs against the one we just stored.
      fresh.sort((a, b) => String(a.reportDate).localeCompare(String(b.reportDate)));

      for (const filing of fresh) {
        const r = await ingestFiling(inst, filing, { silent: isBaseline });
        if (r.inserted) {
          newFilings++;
          alerts += r.alerted || 0;
        }
      }
    } catch (err) {
      console.warn(`   ⚠️  13F poll failed for ${inst.name}: ${err.message}`);
    }
  }
  return { newFilings, alerts };
}

// ─── Congress (politician PTRs) ───────────────────────────────────────────────
function summarizeTrade(t) {
  const role = t.chamber === 'senate' ? 'Sen.' : 'Rep.';
  const where = [t.party, t.state].filter(Boolean).join('-');
  const verb = t.transaction_type === 'sell' ? 'sold' : t.transaction_type === 'exchange' ? 'exchanged' : 'bought';
  const what = t.ticker || t.asset_description || 'an asset';
  const amt = t.amount_range ? ` (${t.amount_range})` : '';
  const disc = t.disclosure_date ? `, disclosed ${t.disclosure_date}` : '';
  return `🏛️ ${role} ${t.politician}${where ? ` (${where})` : ''} ${verb} ${what}${amt}${disc}`;
}

async function pollCongress() {
  const existing = await queryOne('SELECT count(*)::int AS n FROM congress_trades');
  const isBaseline = existing.n === 0;

  const { trades, source } = await fetchCongressTrades();
  let inserted = 0;
  let alerts = 0;

  for (const t of trades) {
    const row = await queryOne(
      `INSERT INTO congress_trades
         (source_id, politician, chamber, party, state, ticker, asset_description,
          transaction_type, transaction_date, disclosure_date, amount_range, amount_min, amount_max, is_sample)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (source_id) DO NOTHING
       RETURNING id`,
      [t.source_id, t.politician, t.chamber, t.party, t.state, t.ticker, t.asset_description,
       t.transaction_type, t.transaction_date, t.disclosure_date, t.amount_range, t.amount_min, t.amount_max, t.is_sample]
    );
    if (!row) continue;
    inserted++;

    if (!isBaseline) {
      const message = summarizeTrade(t);
      const event = {
        type: 'smart_money.congress_trade',
        entity_type: 'politician',
        entity_ref: polKey(t.politician),
        entity_name: t.politician,
        chamber: t.chamber,
        party: t.party,
        state: t.state,
        ticker: t.ticker,
        transaction_type: t.transaction_type,
        transaction_date: t.transaction_date,
        disclosure_date: t.disclosure_date,
        amount_range: t.amount_range,
        is_sample: t.is_sample,
        message,
      };
      alerts += await emitEvent({
        event,
        entityType: 'politician',
        entityRef: polKey(t.politician),
        tickers: t.ticker ? [t.ticker] : [],
        alertTicker: t.ticker,
        message,
      });
    }
  }
  return { inserted, alerts, source, baseline: isBaseline };
}

// ─── Combined poll (called by scheduler + manual trigger) ─────────────────────
let isPolling = false;
async function pollSmartMoney() {
  if (!FEATURES.SMART_MONEY) return { skipped: true };
  if (isPolling) return { skipped: 'in-progress' };
  isPolling = true;
  try {
    const inst = await pollInstitutions();
    const cong = await pollCongress();
    console.log(`   🏦 smart-money: ${inst.newFilings} new 13F filing(s), ${cong.inserted} congress trade(s) [${cong.source}], ${inst.alerts + cong.alerts} alert(s)`);
    return { institutions: inst, congress: cong };
  } finally {
    isPolling = false;
  }
}

module.exports = { pollSmartMoney, pollInstitutions, pollCongress, emitEvent, polKey };
