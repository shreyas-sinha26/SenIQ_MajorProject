const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — see .env.example');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

module.exports = { pool, query, queryOne, execute, tx, runMigrations };
