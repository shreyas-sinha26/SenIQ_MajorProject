/**
 * Smart-money routes (Phase 3) — Institutions (13F) + Politicians (Congress) tabs,
 * followed-entity management, and Pro outbound webhooks.
 *
 * Both data sources are legally weeks-stale, so every payload carries the trade/period
 * date AND the filing/disclosure date; the UI surfaces the gap. Default congress scope is
 * "mine" (followed politicians + held tickers) — the full firehose is opt-in (?scope=all),
 * since 500+ members trading would be noise.
 *
 * NOTE: tier gating (Free teaser / Plus+ full / Pro webhooks) lands with the billing
 * middleware in Phase 4. Until then these are open to any authenticated user.
 */

const express = require('express');
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db');
const { authMiddleware } = require('./auth');
const { SMART_MONEY, DISCLAIMER } = require('../config');
const { pollSmartMoney, polKey } = require('../services/smartMoney');

const router = express.Router();
router.use(authMiddleware);

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
              f.accession, f.period_of_report, f.filed_at, f.holdings_count, f.total_value,
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
      `SELECT * FROM institution_filings WHERE institution_id = $1
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
              transaction_date, disclosure_date, amount_range, amount_min, amount_max, is_sample
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
    const { entity_type, entity_ref, label } = req.body;
    if (!['institution', 'politician'].includes(entity_type)) {
      return res.status(400).json({ error: 'entity_type must be institution or politician' });
    }
    if (!entity_ref) return res.status(400).json({ error: 'entity_ref is required' });

    // For institutions, the ref must be a tracked slug.
    let ref = String(entity_ref).trim();
    let resolvedLabel = label || ref;
    if (entity_type === 'institution') {
      const inst = await queryOne('SELECT name, slug FROM institutions WHERE slug = $1', [ref]);
      if (!inst) return res.status(404).json({ error: 'Unknown institution slug' });
      resolvedLabel = inst.name;
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

// ─── Outbound webhooks (Pro tier — see NOTE at top) ───────────────────────────
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

router.post('/webhooks', async (req, res) => {
  try {
    const { url, event_types } = req.body;
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'A valid http(s) url is required' });
    }
    const secret = crypto.randomBytes(24).toString('hex');
    const types = (event_types && String(event_types).trim()) || 'smart_money';
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

// ─── POST /api/smart-money/poll ───────────────────────────────────────────────
// Manual trigger (handy for testing / forcing a refresh outside the cron cadence).
router.post('/poll', async (req, res) => {
  try {
    const result = await pollSmartMoney();
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Manual smart-money poll error:', err);
    res.status(500).json({ error: 'Poll failed' });
  }
});

module.exports = router;
