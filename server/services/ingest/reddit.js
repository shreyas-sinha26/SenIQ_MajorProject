/**
 * Reddit ingestion (Phase 2b) — r/stocks, r/wallstreetbets, r/cryptocurrency.
 * Reddit now blocks the anonymous *.json endpoints (HTTP 403), so this needs an
 * OAuth app: set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET (script-type app) in .env.
 * Without creds it returns [] and logs once — the rest of the pipeline is unaffected.
 */

const { INGEST } = require('../../config');
const { hashId, clampText, fetchWithTimeout } = require('./util');

const UA = 'seniq/0.1 (sentiment ingestion)';
let warned = false;
let token = null; // { value, exp }

async function getToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    if (!warned) {
      console.warn('   ⚠️  Reddit ingest enabled but REDDIT_CLIENT_ID/SECRET unset — skipping Reddit.');
      warned = true;
    }
    return null;
  }
  if (token && Date.now() < token.exp) return token.value;

  try {
    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const res = await fetchWithTimeout('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;
    token = { value: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
    return token.value;
  } catch {
    return null;
  }
}

async function fetchSubreddit(sub, bearer) {
  try {
    const url = `https://oauth.reddit.com/r/${sub}/hot?limit=${INGEST.REDDIT_LIMIT}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${bearer}`, 'User-Agent': UA },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const posts = data?.data?.children || [];
    return posts
      .map((p) => p.data)
      .filter((p) => p && p.title && !p.stickied)
      .map((p) => ({
        external_id: hashId('reddit', p.id),
        title: clampText(p.title, 300),
        summary: clampText(p.selftext || ''),
        source: `r/${sub}`,
        url: `https://www.reddit.com${p.permalink}`,
        image_url: '',
        published_at: new Date((p.created_utc || Date.now() / 1000) * 1000).toISOString(),
        platform: 'reddit',
      }));
  } catch {
    return [];
  }
}

async function fetchReddit() {
  const bearer = await getToken();
  if (!bearer) return [];
  const results = await Promise.allSettled(INGEST.REDDIT_SUBREDDITS.map((s) => fetchSubreddit(s, bearer)));
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

module.exports = { fetchReddit };
