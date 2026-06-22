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

const app = express();
const PORT = process.env.PORT || 3000;

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
