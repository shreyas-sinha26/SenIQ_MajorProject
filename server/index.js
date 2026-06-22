require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { runMigrations } = require('./db');
const { DISCLAIMER } = require('./config');
const { router: authRouter } = require('./routes/auth');
const portfolioRouter = require('./routes/portfolio');
const newsRouter = require('./routes/news');
const smartMoneyRouter = require('./routes/smartMoney');
const { startScheduler } = require('./scheduler');
const { initSentry, sentryErrorHandler } = require('./observability');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ─── Fail fast on insecure prod config ───────────────────────
// A real deployment must not run on the development JWT fallback.
if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me')) {
  console.error('❌ JWT_SECRET is missing or still the dev default — refusing to start in production.');
  process.exit(1);
}

// Error monitoring (no-op unless SENTRY_DSN is set).
initSentry();

// ─── Trust the platform proxy ────────────────────────────────
// Render/Cloudflare terminate TLS and forward over HTTP with X-Forwarded-* headers.
// Without this, req.secure is always false and the HTTPS redirect below would loop.
if (isProd) app.set('trust proxy', 1);

// ─── Security headers + force HTTPS (prod only) ──────────────
app.use((req, res, next) => {
  if (isProd) {
    // Redirect any plain-HTTP hit to HTTPS (proxy reports the original scheme).
    if (req.secure === false && req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    }
    // HSTS: tell browsers to only ever use HTTPS for 1y (with preload eligibility).
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── API Routes ─────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/news', newsRouter);
app.use('/api/smart-money', smartMoneyRouter);

// ─── Health Check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ─── Public Config (disclaimer, etc.) ───────────────────────
app.get('/api/config', (req, res) => {
  res.json({ disclaimer: DISCLAIMER });
});

// ─── SPA Fallback ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Error handling ─────────────────────────────────────────
// Sentry first (reports the error), then a generic JSON 500 (never leak stacks).
app.use(sentryErrorHandler());
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start Server ───────────────────────────────────────────
async function start() {
  await runMigrations();
  app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   🧠 SenIQ                                       ║
  ║   Running on http://localhost:${PORT}               ║
  ║   Press Ctrl+C to stop                           ║
  ╚══════════════════════════════════════════════════╝
  `);
    startScheduler();
  });
}

start().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
