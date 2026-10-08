/**
 * India smart-money orchestrator — NSE bulk/block deals (Institutions tab) and insider
 * trades (the Indian counterpart of the Congress tab).
 *
 * Same idea as the US poller in index.js, on its own once-a-day cadence: fetch, store what
 * is new, and alert the users it concerns — holders of the stock and followers of a curated
 * investor. Alerts are grouped to ONE per stock per run (a busy counter can print six bulk
 * deals in a day) and share the user's daily real-time limit.
 *
 * Backfill guard: the first deal file of each type, and the first fetch for each symbol's
 * insider trades, are stored silently. After that only records newer than
 * ALERT_MAX_AGE_DAYS can alert, so a late fetch never presents old trades as news.
 */

const { query, queryOne, execute } = require('../../db');
const { FEATURES, INDIA_SMART_MONEY } = require('../../config');
const { INVESTOR_BY_SLUG } = require('../../data/indiaInvestors');
const { fetchDeals } = require('./nseDeals');
const { fetchInsiderTrades, insiderAlertable } = require('./nseInsiders');
const { isBlocked } = require('./nse');
const { notifyUsers } = require('./index');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ₹ in the units Indian readers use: crore (1e7) and lakh (1e5). Pure.
function fmtInr(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '₹—';
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e9 ? 0 : 1)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}
function fmtShares(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  return Math.round(v).toLocaleString('en-IN');
}

// Users to tell about an Indian stock: those holding it AS an Indian stock (a US holding
// can share the letters of an NSE symbol) plus followers of any curated investor involved.
async function indiaRecipients(ticker, investorSlugs = []) {
  const holders = await query(
    `SELECT DISTINCT p.user_id
       FROM portfolio p LEFT JOIN companies c ON c.ticker = p.ticker
      WHERE p.ticker = $1
        AND (upper(coalesce(p.exchange, '')) IN ('NSE', 'BSE')
             OR (coalesce(p.exchange, '') = '' AND c.country = 'IN'))`,
    [ticker]
  );
  const slugs = [...new Set(investorSlugs.filter(Boolean))];
  const followers = slugs.length
    ? await query(
      `SELECT DISTINCT user_id FROM followed_entities WHERE entity_type = 'in_investor' AND entity_ref = ANY($1)`,
      [slugs])
    : [];
  return [...new Set([...holders, ...followers].map((r) => Number(r.user_id)))];
}

// ─── Bulk and block deals ─────────────────────────────────────────────────────
const dealParty = (d) => (d.investor_slug && INVESTOR_BY_SLUG[d.investor_slug] ? INVESTOR_BY_SLUG[d.investor_slug].name : d.client_name);

// One line for all of a stock's new deals of one type, largest first. Pure.
function summarizeDeals(ticker, deals) {
  const sorted = [...deals].sort((a, b) => b.value - a.value);
  const parts = sorted.slice(0, 3).map((d) =>
    `${dealParty(d)} ${d.side === 'sell' ? 'sold' : 'bought'} ${fmtShares(d.quantity)} shares at ₹${d.price} (${fmtInr(d.value)})`);
  const more = sorted.length > 3 ? `; +${sorted.length - 3} more` : '';
  const kind = sorted[0].deal_type === 'block' ? 'Block' : 'Bulk';
  return `🏦 ${kind} deal${sorted.length > 1 ? 's' : ''} in ${ticker} on ${sorted[0].deal_date}: ${parts.join('; ')}${more}`;
}

const recentEnough = (isoDate, now) =>
  !!isoDate && (now - Date.parse(isoDate)) / 86400000 <= INDIA_SMART_MONEY.ALERT_MAX_AGE_DAYS;

async function pollDealType(dealType, { fetch = fetchDeals, now = Date.now() } = {}) {
  const deals = await fetch(dealType);
  const existing = await queryOne('SELECT count(*)::int AS n FROM india_deals WHERE deal_type = $1', [dealType]);
  const isBaseline = existing.n === 0;

  const fresh = [];
  for (const d of deals) {
    const row = await queryOne(
      `INSERT INTO india_deals
         (source_id, deal_type, deal_date, ticker, security_name, client_name, investor_slug, side, quantity, price, value, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (source_id) DO NOTHING
       RETURNING id`,
      [d.source_id, d.deal_type, d.deal_date, d.ticker, d.security_name, d.client_name, d.investor_slug,
       d.side, d.quantity, d.price, d.value, d.remarks]
    );
    if (row) fresh.push(d);
  }

  let alerts = 0;
  if (!isBaseline) {
    const byTicker = new Map();
    for (const d of fresh) {
      if (!recentEnough(d.deal_date, now)) continue;
      if (!byTicker.has(d.ticker)) byTicker.set(d.ticker, []);
      byTicker.get(d.ticker).push(d);
    }
    for (const [ticker, group] of byTicker) {
      const recipients = await indiaRecipients(ticker, group.map((d) => d.investor_slug));
      if (!recipients.length) continue;
      const message = summarizeDeals(ticker, group);
      const event = {
        type: 'smart_money.india_deal',
        market: 'IN',
        deal_type: dealType,
        ticker,
        deal_date: group[0].deal_date,
        deals: group.map((d) => ({ client_name: d.client_name, investor: d.investor_slug, side: d.side, quantity: d.quantity, price: d.price, value_inr: d.value })),
        message,
      };
      alerts += await notifyUsers(recipients, { event, alertTicker: ticker, message });
    }
  }
  return { fetched: deals.length, inserted: fresh.length, alerts, baseline: isBaseline };
}

async function pollIndiaDeals(opts = {}) {
  const out = { inserted: 0, alerts: 0, errors: [] };
  for (const dealType of ['bulk', 'block']) {
    try {
      const r = await pollDealType(dealType, opts);
      out.inserted += r.inserted;
      out.alerts += r.alerts;
      out[dealType] = r;
    } catch (err) {
      out.errors.push(`${dealType}: ${err.message}`);
      if (isBlocked(err)) { out.blocked = true; break; }
    }
    if (dealType === 'bulk' && !opts.noDelay) await sleep(INDIA_SMART_MONEY.REQUEST_DELAY_MS);
  }
  return out;
}

// ─── Insider trades ───────────────────────────────────────────────────────────
// Symbols for this run: every held Indian ticker (capped), then the universe names we
// have gone longest without checking.
async function insiderSymbols() {
  const held = await query(
    `SELECT DISTINCT p.ticker
       FROM portfolio p LEFT JOIN companies c ON c.ticker = p.ticker
      WHERE p.asset_class = 'equity'
        AND (upper(coalesce(p.exchange, '')) IN ('NSE', 'BSE')
             OR (coalesce(p.exchange, '') = '' AND c.country = 'IN'))
      ORDER BY p.ticker LIMIT $1`,
    [INDIA_SMART_MONEY.INSIDER_MAX_HELD]
  );
  const heldTickers = held.map((r) => r.ticker);
  const rotating = await query(
    `SELECT c.ticker
       FROM companies c LEFT JOIN india_insider_sync s ON s.ticker = c.ticker
      WHERE c.country = 'IN' AND c.is_active = true AND c.asset_class = 'equity'
        AND NOT (c.ticker = ANY($1))
      ORDER BY s.last_synced_at ASC NULLS FIRST, c.ticker LIMIT $2`,
    [heldTickers, INDIA_SMART_MONEY.INSIDER_ROTATING]
  );
  return [...heldTickers, ...rotating.map((r) => r.ticker)];
}

// One line for a stock's new alert-worthy insider trades, largest first. Pure.
function summarizeInsiders(ticker, trades) {
  const sorted = [...trades].sort((a, b) => (b.value || 0) - (a.value || 0));
  const parts = sorted.slice(0, 3).map((t) =>
    `${t.person} (${t.category}) ${t.side === 'sell' ? 'sold' : 'bought'} ${fmtShares(t.quantity)} shares (${fmtInr(t.value)})`);
  const more = sorted.length > 3 ? `; +${sorted.length - 3} more` : '';
  const disclosed = sorted[0].disclosed_at ? `, disclosed ${sorted[0].disclosed_at}` : '';
  return `🏛️ Insider trade${sorted.length > 1 ? 's' : ''} in ${ticker}: ${parts.join('; ')}${more}${disclosed}`;
}

async function pollInsidersFor(symbol, { fetch = fetchInsiderTrades, now = Date.now() } = {}) {
  const trades = await fetch(symbol, now);
  const synced = await queryOne('SELECT 1 AS x FROM india_insider_sync WHERE ticker = $1', [symbol]);
  const isBaseline = !synced;

  const fresh = [];
  for (const t of trades) {
    const row = await queryOne(
      `INSERT INTO india_insider_trades
         (source_id, ticker, company, person, category, security_type, mode, side, quantity, value,
          shares_before, shares_after, pct_before, pct_after, trade_from, trade_to, intimated_at, disclosed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (source_id) DO NOTHING
       RETURNING id`,
      [t.source_id, t.ticker, t.company, t.person, t.category, t.security_type, t.mode, t.side, t.quantity, t.value,
       t.shares_before, t.shares_after, t.pct_before, t.pct_after, t.trade_from, t.trade_to, t.intimated_at, t.disclosed_at]
    );
    if (row) fresh.push(t);
  }
  await execute(
    `INSERT INTO india_insider_sync (ticker, last_synced_at) VALUES ($1, now())
     ON CONFLICT (ticker) DO UPDATE SET last_synced_at = now()`,
    [symbol]
  );

  let alerts = 0;
  const notable = isBaseline ? [] : fresh.filter((t) => insiderAlertable(t, now));
  if (notable.length) {
    const recipients = await indiaRecipients(symbol);
    if (recipients.length) {
      const message = summarizeInsiders(symbol, notable);
      const event = {
        type: 'smart_money.india_insider_trade',
        market: 'IN',
        ticker: symbol,
        trades: notable.map((t) => ({ person: t.person, category: t.category, side: t.side, mode: t.mode, quantity: t.quantity, value_inr: t.value, trade_from: t.trade_from, trade_to: t.trade_to, disclosed_at: t.disclosed_at })),
        message,
      };
      alerts = await notifyUsers(recipients, { event, alertTicker: symbol, message });
    }
  }
  return { inserted: fresh.length, alerts, baseline: isBaseline };
}

async function pollIndiaInsiders(opts = {}) {
  const symbols = opts.symbols || await insiderSymbols();
  const out = { symbols: symbols.length, checked: 0, inserted: 0, alerts: 0, errors: [] };
  for (const symbol of symbols) {
    try {
      const r = await pollInsidersFor(symbol, opts);
      out.checked++;
      out.inserted += r.inserted;
      out.alerts += r.alerts;
    } catch (err) {
      out.errors.push(`${symbol}: ${err.message}`);
      if (isBlocked(err)) { out.blocked = true; break; } // refused — do not keep knocking
    }
    if (!opts.noDelay) await sleep(INDIA_SMART_MONEY.REQUEST_DELAY_MS);
  }
  return out;
}

// ─── Combined poll (daily cron + admin trigger) ───────────────────────────────
let isPolling = false;
async function pollIndiaSmartMoney(opts = {}) {
  if (!FEATURES.INDIA_SMART_MONEY) return { skipped: true };
  if (isPolling) return { skipped: 'in-progress' };
  isPolling = true;
  try {
    const deals = await pollIndiaDeals(opts);
    // Refused on the deal files → the insider route would be refused too.
    const insiders = deals.blocked ? { skipped: 'blocked', errors: [] } : await pollIndiaInsiders(opts);
    const errors = [...deals.errors, ...insiders.errors];
    console.log(`   🇮🇳 india smart-money: ${deals.inserted} deal(s), ${insiders.inserted || 0} insider trade(s) across ${insiders.checked || 0} symbol(s), ${deals.alerts + (insiders.alerts || 0)} alert(s)`);
    if (errors.length) console.warn(`   ⚠️  india smart-money: ${errors.length} request(s) failed — ${errors.slice(0, 3).join(' | ')}`);
    return { deals, insiders };
  } finally {
    isPolling = false;
  }
}

module.exports = {
  pollIndiaSmartMoney, pollIndiaDeals, pollIndiaInsiders, pollDealType, pollInsidersFor,
  indiaRecipients, insiderSymbols, summarizeDeals, summarizeInsiders, fmtInr, fmtShares,
};
