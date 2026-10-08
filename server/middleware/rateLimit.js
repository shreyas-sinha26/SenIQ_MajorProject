/**
 * Per-user rate limits for signed-in web routes that cost something each call — a
 * third-party API request, an engine backtest, a model answer. Same in-memory sliding
 * window as the API keys (services/slidingWindow.js): it stops a loop, it is not
 * accounting, and counters reset on restart. Use after authMiddleware.
 */
const { makeLimiter } = require('../services/slidingWindow');

const MIN = 60 * 1000;

const LIMITS = {
  ASK: makeLimiter({ limit: 20, windowMs: 10 * MIN }),          // Ask questions (the daily cap is separate)
  LIVE_NEWS: makeLimiter({ limit: 60, windowMs: 10 * MIN }),    // routes that fetch from news providers live
  ANALYZE: makeLimiter({ limit: 20, windowMs: 10 * MIN }),      // analyze a headline / URL
  ENGINE: makeLimiter({ limit: 60, windowMs: 60 * MIN }),       // web backtests, walk-forward, compare
};

function userRateLimit(limiter) {
  return (req, res, next) => {
    const id = (req.user && req.user.id) || req.ip || 'unknown';
    const verdict = limiter.allow(String(id));
    if (!verdict.allowed) {
      res.set('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many requests — please wait a bit and retry' });
    }
    next();
  };
}

module.exports = { userRateLimit, LIMITS };
