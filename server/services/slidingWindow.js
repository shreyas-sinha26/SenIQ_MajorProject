/**
 * Phase 8 — in-memory sliding-window rate limiter (per API key).
 *
 * Deliberately not DB-backed: the point is stopping a runaway agent loop, not
 * accounting. Counters reset on restart, which is fine for that job. Memory is
 * bounded by (active keys × limit) timestamps.
 */
function makeLimiter({ limit, windowMs }) {
  const hits = new Map(); // id → sorted array of hit timestamps within the window

  function allow(id, now = Date.now()) {
    const cutoff = now - windowMs;
    let arr = hits.get(id);
    if (!arr) {
      arr = [];
      hits.set(id, arr);
    }
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length >= limit) {
      return { allowed: false, retryAfterMs: arr[0] - cutoff, remaining: 0 };
    }
    arr.push(now);
    return { allowed: true, remaining: limit - arr.length };
  }

  // Drop ids that have gone fully quiet (called opportunistically).
  function sweep(now = Date.now()) {
    const cutoff = now - windowMs;
    for (const [id, arr] of hits) {
      while (arr.length && arr[0] <= cutoff) arr.shift();
      if (!arr.length) hits.delete(id);
    }
  }

  return { allow, sweep, limit, windowMs };
}

module.exports = { makeLimiter };
