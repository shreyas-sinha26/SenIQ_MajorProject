/**
 * X / Twitter ingestion — DEFERRED (cost). Interface stub only so X can drop in
 * later without touching the orchestrator. Returns the same normalized article
 * shape as the other sources: { external_id, title, summary, source, url,
 * image_url, published_at, platform:'x' }.
 */

async function fetchX() {
  return [];
}

module.exports = { fetchX };
