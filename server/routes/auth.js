const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { queryOne } = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ─── Middleware: Auth Guard ──────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── POST /api/auth/signup ───────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const created = await queryOne(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, name]
    );

    const token = jwt.sign({ id: created.id, email, name }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: created.id, email, name, subscription_tier: 'free', is_admin: false } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/login ────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, subscription_tier: user.subscription_tier || 'free', is_admin: !!user.is_admin } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/auth/me ────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne('SELECT id, email, name, created_at, subscription_tier, is_admin FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/auth/me — update display name ────────────────
router.patch('/me', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const trimmed = name.trim();
    if (trimmed.length > 80) return res.status(400).json({ error: 'Name too long' });
    const user = await queryOne(
      'UPDATE users SET name = $1 WHERE id = $2 RETURNING id, email, name, created_at',
      [trimmed, req.user.id]
    );
    res.json({ user });
  } catch (err) {
    console.error('Update name error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/change-password ─────────────────────────
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const user = await queryOne('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await queryOne('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { router, authMiddleware };
