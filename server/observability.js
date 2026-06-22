/**
 * Error monitoring (Phase 4 ops baseline) — optional, env-gated Sentry.
 *
 * Activates ONLY when SENTRY_DSN is set AND @sentry/node is installed. Otherwise
 * every export is a harmless no-op, so local dev and DSN-less deploys run unchanged.
 * This keeps Sentry a soft dependency — the app never fails for lack of it.
 */

let Sentry = null;
let active = false;

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // disabled — no DSN configured

  try {
    Sentry = require('@sentry/node');
  } catch {
    console.warn('   ⚠️  SENTRY_DSN set but @sentry/node is not installed — run `npm install`. Skipping.');
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0, // errors only for now; turn up for perf tracing later
    });
    active = true;
    console.log('🛰️  Sentry error monitoring enabled');
  } catch (err) {
    console.warn('   ⚠️  Sentry init failed, continuing without it:', err.message);
  }
}

// Express error-capturing middleware. Returns a passthrough when Sentry is off,
// and tolerates both the v8 (expressErrorHandler) and v7 (Handlers.errorHandler) APIs.
function sentryErrorHandler() {
  if (active && Sentry) {
    if (typeof Sentry.expressErrorHandler === 'function') return Sentry.expressErrorHandler();
    if (Sentry.Handlers && typeof Sentry.Handlers.errorHandler === 'function') return Sentry.Handlers.errorHandler();
  }
  return (err, req, res, next) => next(err);
}

// Manually report a caught error (e.g. from the cron pipeline) when Sentry is on.
function captureException(err) {
  if (active && Sentry) Sentry.captureException(err);
}

module.exports = { initSentry, sentryErrorHandler, captureException };
