/**
 * express.Router() whose handlers may be async.
 *
 * Express 4 does not look at what a handler returns, so a rejected promise from an
 * `async (req, res) => …` never reaches the error middleware — it becomes an unhandled
 * rejection, and Node ends the process. Every router in server/routes is built here so a
 * thrown error (a bad :id, a database blip) becomes a 500 for that one request instead.
 */
const express = require('express');

const METHODS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete'];

// Forward a rejected promise to next(). Error middleware (4 args) is left as it is.
function wrap(fn) {
  if (typeof fn !== 'function' || fn.length >= 4) return fn;
  // A router is itself a function — wrapping it would hide its own stack from Express.
  if (typeof fn.handle === 'function') return fn;
  return function wrapped(req, res, next) {
    try {
      const out = fn.call(this, req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function asyncRouter(options) {
  const router = express.Router(options);
  for (const method of METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return router;
}

module.exports = { asyncRouter, wrap };
