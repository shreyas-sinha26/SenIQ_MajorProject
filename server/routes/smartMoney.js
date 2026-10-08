/**
 * Smart-money routes (Phase 3) — Institutions (13F) + Politicians (Congress) tabs,
 * followed-entity management, and Pro outbound webhooks.
 *
 * Both data sources are legally weeks-stale, so every payload carries the trade/period
 * date AND the filing/disclosure date; the UI surfaces the gap. Default congress scope is
 * "mine" (followed politicians + held tickers) — the full firehose is opt-in (?scope=all),
 * since 500+ members trading would be noise.
 *
 * Tier gating: Free sees a teaser, Plus and Pro the full lists; registering a webhook is
 * Pro (TIERS[tier].webhooks). The manual poll is admin-only.
 */

const { asyncRouter } = require('../middleware/asyncRouter');
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db');
const { authMiddleware } = require('./auth');
const { attachTier, requireTier, requireAdmin } = require('../middleware/tier');
const { assertPublicUrl, UnsafeUrlError } = require('../services/safeFetch');
const { SMART_MONEY, INDIA_SMART_MONEY, FEATURES, DISCLAIMER } = require('../config');
const { pollSmartMoney, polKey } = require('../services/smartMoney');
const { pollIndiaSmartMoney } = require('../services/smartMoney/india');
const { INDIA_INVESTORS, INVESTOR_BY_SLUG } = require('../data/indiaInvestors');

const router = asyncRouter();
router.use(authMiddleware, attachTier);

// Phase 6 — Free tier gets a teaser (top 2 only) of smart money; Plus/Pro get the full set.
const TEASER_LIMIT = 2;
const isTeaser = (req) => req.tierCfg?.smartMoney === 'teaser';

const FRESHNESS_NOTE =
  'Smart-money data is disclosed with a legal lag — 13F filings ~45 days after quarter ' +
  'end, congressional trades up to ~45 days after the trade. "New" means newly disclosed, ' +
  'not newly traded. Compare the trade/period date with the filing/disclosure date.';

// ─── GET /api/smart-money/meta ────────────────────────────────────────────────
router.get('/meta', async (req, res) => {
  try {
    const sample = await queryOne('SELECT count(*)::int AS n FROM congress_trades WHERE is_sample = true');
    const live = await queryOne('SELECT count(*)::int AS n FROM congress_trades WHERE is_sample = false');
    res.json({
      freshnessNote: FRESHNESS_NOTE,
      disclaimer: DISCLAIMER,
      congress: {
        source: SMART_MONEY.CONGRESS_TRADES_URL ? 'live-url' : (live.n > 0 ? 'live' : 'sample'),
        usingSample: sample.n > 0 && live.n === 0,
      },
    });
  } catch (err) {
    console.error('Smart-money meta error:', err);
    res.status(500).json({ error: 'Failed to load smart-money meta' });
  }
});

// ─── GET /api/smart-money/institutions ────────────────────────────────────────
// Tracked funds + their latest filing summary, plus whether the user follows each.
router.get('/institutions', async (req, res) => {
  try {
    const rows = await query(
      `SELECT i.id, i.cik, i.name, i.slug, i.manager,
              f.accession, f.period_of_report::text AS period_of_report, f.filed_at::text AS filed_at,
              f.holdings_count, f.total_value,
              (fe.id IS NOT NULL) AS following
         FROM institutions i
         LEFT JOIN LATERAL (
           SELECT * FROM institution_filings
            WHERE institution_id = i.id
            ORDER BY period_of_report DESC NULLS LAST, id DESC LIMIT 1
         ) f ON true
         LEFT JOIN followed_entities fe
           ON fe.user_id = $1 AND fe.entity_type = 'institution' AND fe.entity_ref = i.slug
        ORDER BY f.total_value DESC NULLS LAST, i.name`,
      [req.user.id]
    );
    if (isTeaser(req)) {
      return res.json({ institutions: rows.slice(0, TEASER_LIMIT), freshnessNote: FRESHNESS_NOTE,
        teaser: true, total: rows.length, upgrade: { requiredTier: 'plus', requiredLabel: 'Plus' } });
    }
    res.json({ institutions: rows, freshnessNote: FRESHNESS_NOTE });
  } catch (err) {
    console.error('Institutions list error:', err);
    res.status(500).json({ error: 'Failed to load institutions' });
  }
});

// ─── GET /api/smart-money/institutions/:slug ──────────────────────────────────
// Latest filing's top holdings (by value), with per-holding change vs the prior quarter.
router.get('/institutions/:slug', async (req, res) => {
  try {
    const inst = await queryOne('SELECT * FROM institutions WHERE slug = $1', [req.params.slug]);
    if (!inst) return res.status(404).json({ error: 'Institution not tracked' });

    const filing = await queryOne(
      `SELECT id, accession, period_of_report::text AS period_of_report, filed_at::text AS filed_at,
              holdings_count, total_value
         FROM institution_filings WHERE institution_id = $1
        ORDER BY period_of_report DESC NULLS LAST, id DESC LIMIT 1`,
      [inst.id]
    );

    let holdings = [];
    if (filing) {
      holdings = await query(
        `SELECT cusip, ticker, issuer_name, shares, value, pct_of_portfolio, change_type
           FROM institution_holdings WHERE filing_id = $1
          ORDER BY value DESC LIMIT $2`,
        [filing.id, SMART_MONEY.TOP_HOLDINGS]
      );
    }

    const follow = await queryOne(
      `SELECT id FROM followed_entities WHERE user_id = $1 AND entity_type = 'institution' AND entity_ref = $2`,
      [req.user.id, inst.slug]
    );

    res.json({
      institution: { cik: inst.cik, name: inst.name, slug: inst.slug, manager: inst.manager },
      filing: filing
        ? { accession: filing.accession, period_of_report: filing.period_of_report, filed_at: filing.filed_at, holdings_count: filing.holdings_count, total_value: filing.total_value }
        : null,
      holdings,
      following: !!follow,
      freshnessNote: FRESHNESS_NOTE,
    });
  } catch (err) {
    console.error('Institution detail error:', err);
    res.status(500).json({ error: 'Failed to load institution' });
  }
});

// ─── GET /api/smart-money/congress ────────────────────────────────────────────
// scope=mine (default): followed politicians + held tickers. scope=all: full firehose.
router.get('/congress', async (req, res) => {
  try {
    const scope = req.query.scope === 'all' ? 'all' : 'mine';
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const recent = await query(
      `SELECT politician, chamber, party, state, ticker, asset_description, transaction_type,
              transaction_date::text AS transaction_date, disclosure_date::text AS disclosure_date,
              amount_range, amount_min, amount_max, is_sample
         FROM congress_trades
        ORDER BY disclosure_date DESC NULLS LAST, id DESC
        LIMIT 400`
    );

    let trades = recent;
    if (scope === 'mine') {
      const held = await query('SELECT DISTINCT ticker FROM portfolio WHERE user_id = $1', [req.user.id]);
      const heldSet = new Set(held.map((h) => h.ticker));
      const followed = await query(
        `SELECT entity_ref FROM followed_entities WHERE user_id = $1 AND entity_type = 'politician'`,
        [req.user.id]
      );
      const followedSet = new Set(followed.map((f) => f.entity_ref));
      trades = recent.filter((t) => (t.ticker && heldSet.has(t.ticker)) || followedSet.has(polKey(t.politician)));
    }

    if (isTeaser(req)) {
      return res.json({ trades: trades.slice(0, TEASER_LIMIT), scope, freshnessNote: FRESHNESS_NOTE,
        teaser: true, total: trades.length, upgrade: { requiredTier: 'plus', requiredLabel: 'Plus' } });
    }
    res.json({ trades: trades.slice(0, limit), scope, freshnessNote: FRESHNESS_NOTE });
  } catch (err) {
    console.error('Congress list error:', err);
    res.status(500).json({ error: 'Failed to load congress trades' });
  }
});

// ─── Followed entities ────────────────────────────────────────────────────────
router.get('/follows', async (req, res) => {
  try {
    const follows = await query(
      'SELECT entity_type, entity_ref, label, created_at FROM followed_entities WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ follows });
  } catch (err) {
    console.error('Follows list error:', err);
    res.status(500).json({ error: 'Failed to load follows' });
  }
});

router.post('/follow', async (req, res) => {
  try {
    const { entity_type, entity_ref, label } = req.body || {};
    if (!['institution', 'politician', 'in_investor'].includes(entity_type)) {
      return res.status(400).json({ error: 'entity_type must be institution, politician or in_investor' });
    }
    if (!entity_ref) return res.status(400).json({ error: 'entity_ref is required' });

    // For institutions, the ref must be a tracked slug.
    let ref = String(entity_ref).trim();
    let resolvedLabel = label || ref;
    if (entity_type === 'institution') {
      const inst = await queryOne('SELECT name, slug FROM institutions WHERE slug = $1', [ref]);
      if (!inst) return res.status(404).json({ error: 'Unknown institution slug' });
      resolvedLabel = inst.name;
    } else if (entity_type === 'in_investor') {
      // Indian investors are the curated list — the ref must be one of its slugs.
      const inv = INVESTOR_BY_SLUG[ref];
      if (!inv) return res.status(404).json({ error: 'Unknown investor slug' });
      resolvedLabel = inv.name;
    } else {
      // Normalize politician names to the same key the emitter uses.
      resolvedLabel = label || ref;
      ref = polKey(ref);
    }

    await execute(
      `INSERT INTO followed_entities (user_id, entity_type, entity_ref, label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, entity_type, entity_ref) DO UPDATE SET label = EXCLUDED.label`,
      [req.user.id, entity_type, ref, resolvedLabel]
    );
    res.status(201).json({ following: { entity_type, entity_ref: ref, label: resolvedLabel } });
  } catch (err) {
    console.error('Follow error:', err);
    res.status(500).json({ error: 'Failed to follow' });
  }
});

router.delete('/follow/:type/:ref', async (req, res) => {
  try {
    const result = await execute(
      'DELETE FROM followed_entities WHERE user_id = $1 AND entity_type = $2 AND entity_ref = $3',
      [req.user.id, req.params.type, req.params.ref]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not following that entity' });
    res.json({ success: true });
  } catch (err) {
    console.error('Unfollow error:', err);
    res.status(500).json({ error: 'Failed to unfollow' });
  }
});

// ─── Outbound webhooks (Pro to register; listing + deleting stay open so a ─────
// downgraded user can still see and remove theirs) ─────────────────────────────
router.get('/webhooks', async (req, res) => {
  try {
    const hooks = await query(
      `SELECT id, url, event_types, active, failure_count, last_status, last_attempt_at, created_at
         FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ webhooks: hooks });
  } catch (err) {
    console.error('Webhooks list error:', err);
    res.status(500).json({ error: 'Failed to load webhooks' });
  }
});

router.post('/webhooks', requireTier('pro'), async (req, res) => {
  try {
    const { event_types } = req.body || {};
    const url = typeof (req.body || {}).url === 'string' ? req.body.url.trim() : '';
    if (!url || url.length > 2000 || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'A valid http(s) url is required' });
    }
    // The server will POST to this address, so it must be a public one.
    try {
      await assertPublicUrl(url);
    } catch (err) {
      if (err instanceof UnsafeUrlError) return res.status(400).json({ error: `That webhook URL can't be used: ${err.message}` });
      throw err;
    }
    const have = await queryOne('SELECT count(*)::int AS n FROM webhooks WHERE user_id = $1', [req.user.id]);
    if (have.n >= SMART_MONEY.MAX_WEBHOOKS_PER_USER) {
      return res.status(400).json({ error: `Limit reached (${SMART_MONEY.MAX_WEBHOOKS_PER_USER} webhooks) — delete one first.` });
    }
    const secret = crypto.randomBytes(24).toString('hex');
    const types = (event_types && String(event_types).trim().slice(0, 200)) || 'smart_money';
    const created = await queryOne(
      `INSERT INTO webhooks (user_id, url, secret, event_types) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.user.id, url, secret, types]
    );
    // The secret is returned ONCE on creation (used to verify X-SenIQ-Signature).
    res.status(201).json({ webhook: { id: created.id, url, event_types: types, active: true, secret } });
  } catch (err) {
    console.error('Webhook create error:', err);
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

router.delete('/webhooks/:id', async (req, res) => {
  try {
    const result = await execute('DELETE FROM webhooks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Webhook not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook delete error:', err);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

// ─── India: bulk/block deals + insider trades ─────────────────────────────────
// The Indian side of the two tabs. FEATURES.INDIA_SMART_MONEY gates the fetching and the
// UI switch; the list routes below simply serve whatever is stored.
// Dates are selected as text: a DATE read through the driver becomes local midnight and
// prints as the previous day east of GMT.
const INDIA_NOTE =
  'Bulk and block deals are published by NSE the same evening, with the client named as ' +
  'the exchange reports it. Insider trades are disclosed under SEBI\'s insider-trading ' +
  'rules, usually within two trading days. India has no equivalent of congressional ' +
  'trade reports.';

// Tickers the user holds as Indian stocks (same rule as prices: the holding's exchange,
// else the company reference).
async function heldIndianTickers(userId) {
  const rows = await query(
    `SELECT DISTINCT p.ticker
       FROM portfolio p LEFT JOIN companies c ON c.ticker = p.ticker
      WHERE p.user_id = $1
        AND (upper(coalesce(p.exchange, '')) IN ('NSE', 'BSE')
             OR (coalesce(p.exchange, '') = '' AND c.country = 'IN'))`,
    [userId]
  );
  return new Set(rows.map((r) => r.ticker));
}

async function followedInvestors(userId) {
  const rows = await query(
    `SELECT entity_ref FROM followed_entities WHERE user_id = $1 AND entity_type = 'in_investor'`,
    [userId]
  );
  return new Set(rows.map((r) => r.entity_ref));
}

function sendIndiaList(req, res, key, rows, scope) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  if (isTeaser(req)) {
    return res.json({ [key]: rows.slice(0, TEASER_LIMIT), scope, freshnessNote: INDIA_NOTE,
      teaser: true, total: rows.length, upgrade: { requiredTier: 'plus', requiredLabel: 'Plus' } });
  }
  res.json({ [key]: rows.slice(0, limit), scope, freshnessNote: INDIA_NOTE });
}

router.get('/india/meta', async (req, res) => {
  const deals = await queryOne('SELECT count(*)::int AS n, max(deal_date)::text AS latest FROM india_deals');
  const insiders = await queryOne('SELECT count(*)::int AS n, max(disclosed_at)::text AS latest FROM india_insider_trades');
  res.json({
    enabled: FEATURES.INDIA_SMART_MONEY,
    freshnessNote: INDIA_NOTE,
    disclaimer: DISCLAIMER,
    deals: { count: deals.n, latest: deals.latest },
    insiders: { count: insiders.n, latest: insiders.latest },
  });
});

// The curated investors, with how many stored deals each matched and whether the user follows them.
router.get('/india/investors', async (req, res) => {
  const counts = await query(
    `SELECT investor_slug, count(*)::int AS n, max(deal_date)::text AS latest
       FROM india_deals WHERE investor_slug IS NOT NULL GROUP BY investor_slug`
  );
  const bySlug = Object.fromEntries(counts.map((c) => [c.investor_slug, c]));
  const followed = await followedInvestors(req.user.id);
  res.json({
    investors: INDIA_INVESTORS.map((i) => ({
      slug: i.slug, name: i.name, kind: i.kind,
      deals: bySlug[i.slug] ? bySlug[i.slug].n : 0,
      latest_deal: bySlug[i.slug] ? bySlug[i.slug].latest : null,
      following: followed.has(i.slug),
    })),
  });
});

// scope=mine (default): deals in held Indian stocks + deals by followed investors.
// scope=all: every stored deal — the whole market, mostly small caps.
router.get('/india/deals', async (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'mine';
  const recent = await query(
    `SELECT deal_type, deal_date::text AS deal_date, ticker, security_name, client_name, investor_slug, side, quantity, price, value
       FROM india_deals
      ORDER BY deal_date DESC, value DESC, id DESC
      LIMIT $1`,
    [INDIA_SMART_MONEY.LIST_WINDOW]
  );
  let deals = recent;
  if (scope === 'mine') {
    const [held, followed] = await Promise.all([heldIndianTickers(req.user.id), followedInvestors(req.user.id)]);
    deals = recent.filter((d) => held.has(d.ticker) || (d.investor_slug && followed.has(d.investor_slug)));
  }
  deals = deals.map((d) => ({ ...d, investor_name: d.investor_slug && INVESTOR_BY_SLUG[d.investor_slug] ? INVESTOR_BY_SLUG[d.investor_slug].name : null }));
  sendIndiaList(req, res, 'deals', deals, scope);
});

// scope=mine (default): insider trades in held Indian stocks. scope=all: every stored one.
router.get('/india/insiders', async (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'mine';
  const recent = await query(
    `SELECT ticker, company, person, category, security_type, mode, side, quantity, value,
            shares_before, shares_after, pct_before, pct_after, trade_from::text AS trade_from,
            trade_to::text AS trade_to, intimated_at::text AS intimated_at, disclosed_at::text AS disclosed_at
       FROM india_insider_trades
      ORDER BY disclosed_at DESC NULLS LAST, value DESC NULLS LAST, id DESC
      LIMIT $1`,
    [INDIA_SMART_MONEY.LIST_WINDOW]
  );
  let trades = recent;
  if (scope === 'mine') {
    const held = await heldIndianTickers(req.user.id);
    trades = recent.filter((t) => held.has(t.ticker));
  }
  sendIndiaList(req, res, 'trades', trades, scope);
});

// Manual trigger. Admin only: each run sends a batch of requests to NSE under SenIQ's name.
router.post('/india/poll', requireAdmin, async (req, res) => {
  if (!FEATURES.INDIA_SMART_MONEY) return res.status(409).json({ error: 'India smart money is off — set INDIA_SMART_MONEY=1' });
  const result = await pollIndiaSmartMoney();
  res.json({ ok: true, result });
});

// ─── POST /api/smart-money/poll ───────────────────────────────────────────────
// Manual trigger (handy for testing / forcing a refresh outside the cron cadence). Admin
// only: each run sends a batch of requests to the SEC under SenIQ's name.
router.post('/poll', requireAdmin, async (req, res) => {
  try {
    const result = await pollSmartMoney();
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Manual smart-money poll error:', err);
    res.status(500).json({ error: 'Poll failed' });
  }
});

module.exports = router;
