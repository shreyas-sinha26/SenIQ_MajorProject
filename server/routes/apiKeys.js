/**
 * Phase 8 — API key management (for the MCP server).
 *
 * Creation is Pro-gated (the MCP surface is a Pro feature); listing and
 * revoking stay open to any logged-in user so someone who downgrades can
 * still see and clean up their keys. The plaintext key is returned exactly
 * once, from POST — after that only the display prefix exists.
 */
const { asyncRouter } = require('../middleware/asyncRouter');
const { query, queryOne } = require('../db');
const { authMiddleware } = require('./auth');
const { requireRecentAuth } = require('../services/sessions');
const { attachTier, requireTier } = require('../middleware/tier');
const { generateKey } = require('../services/apiKeys');
const { idParam } = require('../middleware/idParam');

const MAX_ACTIVE_KEYS = 5;

const router = asyncRouter();
router.use(authMiddleware, attachTier);
router.param('id', idParam('active key not found'));

function rowToJson(r) {
  return {
    id: r.id,
    name: r.name,
    key_prefix: r.key_prefix,
    can_write: !!r.can_write,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked: !!r.revoked_at,
    revoked_at: r.revoked_at,
  };
}

// GET /api/keys — the user's keys (active + revoked, newest first).
router.get('/', async (req, res) => {
  const rows = await query(
    'SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ keys: rows.map(rowToJson), max_active: MAX_ACTIVE_KEYS });
});

// POST /api/keys — create a key (Pro). Response carries the full key ONCE.
router.post('/', requireTier('pro'), (req, res, next) => (
  // A key that can place orders and change holdings needs the password proven recently.
  (req.body || {}).can_write === true ? requireRecentAuth(req, res, next) : next()
), async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60) || 'MCP key';

  const active = await queryOne(
    'SELECT COUNT(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
  if (active.n >= MAX_ACTIVE_KEYS) {
    return res.status(400).json({ error: `Limit reached (${MAX_ACTIVE_KEYS} active keys) — revoke one first.` });
  }

  const { key, hash, prefix } = generateKey();
  const row = await queryOne(
    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, can_write)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.id, name, hash, prefix, (req.body || {}).can_write === true]);
  res.status(201).json({ ...rowToJson(row), key });
});

// DELETE /api/keys/:id — revoke (kept in the list, stops working immediately).
router.delete('/:id', async (req, res) => {
  const row = await queryOne(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING *`,
    [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'active key not found' });
  res.json(rowToJson(row));
});

module.exports = router;
