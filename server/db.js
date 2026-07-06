const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — see .env.example');
}

// Managed Postgres (Neon / Render / Supabase) requires TLS; local dev does not. Auto-detect
// by host, with an explicit override via DATABASE_SSL=require|disable. Managed providers serve
// certs outside Node's default CA bundle, so we don't reject unauthorized — still encrypted.
function sslConfig() {
  const mode = (process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  const url = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1|\[?::1\]?)([:/]|$)/.test(url);
  return isLocal ? false : { rejectUnauthorized: false };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: sslConfig() });

// Surface unexpected idle-client errors instead of letting them crash the process.
pool.on('error', (err) => {
  console.error('⚠️  Unexpected Postgres pool error:', err.message);
});

// ─── Query helpers ───────────────────────────────────────────
// Use $1, $2… placeholders (Postgres), not ?.
async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

async function queryOne(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

// Returns the full pg result (use .rowCount for affected rows, .rows for RETURNING).
async function execute(text, params = []) {
  return pool.query(text, params);
}

// Run fn inside a transaction with a dedicated client.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Migration runner ────────────────────────────────────────
// Applies every server/migrations/*.sql not yet recorded in schema_migrations,
// each in its own transaction, in filename order.
async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map(r => r.version));

  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await tx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    });
    console.log(`   ⬆️  migration applied: ${version}`);
    count++;
  }

  console.log(count > 0 ? `✅ ${count} migration(s) applied` : '✅ Database up to date');
}

// ─── Ops helpers (Phase 4) ───────────────────────────────────
// Connectivity probe for the /api/health endpoint.
async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// Drain the pool on graceful shutdown so in-flight queries finish and the host can
// recycle the instance cleanly on deploy.
async function closePool() {
  await pool.end();
}

module.exports = { pool, query, queryOne, execute, tx, runMigrations, healthCheck, closePool };
