/**
 * Phase 6 — seed an admin account on boot (idempotent).
 *
 * Reads ADMIN_EMAIL (default admin@seniq.local) + ADMIN_PASSWORD from the env. If the account
 * doesn't exist it's created with is_admin=true and the Pro tier (so the admin starts with full
 * access, then flips down to preview Free/Plus). Existing account is just ensured is_admin. The
 * password is NEVER hard-coded — set ADMIN_PASSWORD in the env. Skips quietly if unset.
 */

const bcrypt = require('bcryptjs');
const { queryOne } = require('../db');

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@seniq.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.log('   ℹ️  ADMIN_PASSWORD not set — skipping admin seed');
    return;
  }
  try {
    const existing = await queryOne('SELECT id, is_admin FROM users WHERE email = $1', [email]);
    if (existing) {
      if (!existing.is_admin) await queryOne('UPDATE users SET is_admin = true WHERE id = $1', [existing.id]);
      console.log(`   👤 admin ready: ${email}`);
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    await queryOne(
      `INSERT INTO users (email, password_hash, name, is_admin, subscription_tier)
       VALUES ($1, $2, $3, true, 'pro')`,
      [email, hash, 'SenIQ Admin']
    );
    console.log(`   👤 admin seeded: ${email}`);
  } catch (err) {
    console.error('   ⚠️  admin seed failed:', err.message);
  }
}

module.exports = { seedAdmin };
