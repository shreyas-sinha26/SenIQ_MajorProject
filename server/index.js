require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { runMigrations, healthCheck, closePool } = require('./db');
const { seedUniverse } = require('./services/entityResolver');
const { seedAdmin } = require('./services/seedAdmin');
const { DISCLAIMER, FEATURES } = require('./config');
const { router: authRouter } = require('./routes/auth');
const portfolioRouter = require('./routes/portfolio');
const newsRouter = require('./routes/news');
const smartMoneyRouter = require('./routes/smartMoney');
const reportsRouter = require('./routes/reports');
const adminRouter = require('./routes/admin');
const billingRouter = require('./routes/billing');
const strategiesRouter = require('./routes/strategies');
const paperRouter = require('./routes/paper');
const apiKeysRouter = require('./routes/apiKeys');
const mcpRouter = require('./routes/mcp');
const v1Router = require('./routes/v1');
const { startScheduler } = require('./scheduler');
const { initSentry, sentryErrorHandler } = require('./observability');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ─── Fail fast on insecure prod config ───────────────────────
// A real deployment must not run on the development JWT fallback.
if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 ||
    process.env.JWT_SECRET === 'dev-secret-change-me' || process.env.JWT_SECRET.includes('change-me'))) {
  console.error('❌ JWT_SECRET is missing, weak (<32 chars), or still the dev default — refusing to start in production.');
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
    // Redirect any plain-HTTP hit to HTTPS (proxy reports the original scheme). The host's
    // internal health probe may hit us over plain HTTP without the forwarded header — a
    // redirect would read as unhealthy, so let /api/health through.
    if (req.secure === false && req.headers['x-forwarded-proto'] !== 'https' && req.path !== '/api/health') {
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
// index: false so "/" is handled explicitly below (landing page, not the app).
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// ─── API Routes ─────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/news', newsRouter);
app.use('/api/smart-money', smartMoneyRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/billing', billingRouter);
// v2 surface (FEATURES.STRATEGIES): strategies, paper trading, API keys, MCP + public API.
// Off (v1) → these paths answer 404 JSON instead of falling through to the SPA.
const V2_PATHS = ['/api/strategies', '/api/paper', '/api/keys', '/mcp', '/v1', '/docs'];
if (FEATURES.STRATEGIES) {
  app.use('/api/strategies', strategiesRouter);
  app.use('/api/paper', paperRouter);
  app.use('/api/keys', apiKeysRouter);
  // MCP server (Phase 8): strategy tools for AI agents, API-key auth (not JWT).
  app.use('/mcp', mcpRouter);
  // Public REST API: same read+run surface as /mcp, same keys, shared rate budget.
  app.use('/v1', v1Router);
} else {
  app.use(V2_PATHS, (req, res) => res.status(404).json({ error: 'Not available in this version' }));
}

// ─── Health Check ───────────────────────────────────────────
// Returns 503 if Postgres is unreachable so the host's health probe recycles a bad instance.
app.get('/api/health', async (req, res) => {
  const dbOk = await healthCheck();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'up' : 'down',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Public Config (disclaimer, etc.) ───────────────────────
app.get('/api/config', (req, res) => {
  res.json({ disclaimer: DISCLAIMER, features: { strategies: FEATURES.STRATEGIES } });
});

// ─── Marketing Landing Page ─────────────────────────────────
// Root serves the public marketing page; the app itself lives at /app.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

// ─── API documentation (public, static) ─────────────────────
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'docs.html'));
});

// ─── SPA Fallback (the app: auth + dashboard) ───────────────
// Everything else (e.g. /app, /app?auth=signup, deep links) loads index.html.
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
let server;
let schedulerTasks = [];

async function start() {
  await runMigrations();
  await seedUniverse();
  await seedAdmin();
  server = app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   🧠 SenIQ                                       ║
  ║   Running on http://localhost:${PORT}               ║
  ║   Press Ctrl+C to stop                           ║
  ╚══════════════════════════════════════════════════╝
  `);
    schedulerTasks = startScheduler();
  });
}

// ─── Graceful shutdown ───────────────────────────────────────
// PaaS hosts send SIGTERM on deploy/scale-down. Stop cron, drain HTTP, close the pool.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully…`);
  try {
    schedulerTasks.forEach((t) => t && typeof t.stop === 'function' && t.stop());
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await closePool();
    console.log('✅ Clean shutdown complete.');
    process.exit(0);
  } catch (err) {
    console.error('⚠️  Error during shutdown:', err.message);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
