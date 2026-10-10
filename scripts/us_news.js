#!/usr/bin/env node
/**
 * US coverage from the command line (server/services/usNews.js).
 *
 *   node scripts/us_news.js [status]
 *       Where the rotation stands: how many US shares nobody holds, how many have never been
 *       checked, the oldest and newest check. Reads only. Needs migration 0044.
 *
 *   node scripts/us_news.js try [N] [--from TICKER]
 *       Fetch the company news of N names (default 5, at most US_NEWS.PER_RUN) as a run would,
 *       and show what the pipeline would keep and tag. Stores nothing and does not move the
 *       rotation. One Finnhub call a name. Needs FINNHUB_API_KEY; works with the switch off
 *       and before migration 0044 (it then takes the names in ticker order).
 *
 * The pipeline does the fetch itself, and only when US_LISTED_NEWS=1.
 */
require('dotenv').config();

const day = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—');

async function heldAndWatched(query) {
  const held = (await query('SELECT DISTINCT ticker FROM portfolio')).map((r) => r.ticker);
  return held;
}

async function status() {
  const { query } = require('../server/db');
  const { FEATURES, US_NEWS } = require('../server/config');
  const usNews = require('../server/services/usNews');
  const held = await heldAndWatched(query);
  const s = await usNews.status(held);
  const perRun = usNews.batchSize(held.length);
  console.log(`US_LISTED_NEWS is ${FEATURES.US_LISTED_NEWS ? 'on' : 'off'}; FINNHUB_API_KEY is ${process.env.FINNHUB_API_KEY ? 'set' : 'not set'}`);
  console.log(`${s.names} US shares nobody holds; ${s.never} never checked`);
  console.log(`oldest check ${day(s.oldest)}, newest ${day(s.newest)} (UTC)`);
  console.log(`${held.length} held ticker(s), so a run takes ${perRun} name(s)` + (perRun ? `: each about every ${(s.names / perRun / 6).toFixed(1)} hours` : ` (the run's ${US_NEWS.CALLS_PER_RUN} calls are used up)`));
}

async function tryBatch(flags) {
  const { query } = require('../server/db');
  const { US_NEWS } = require('../server/config');
  const { loadIndex, isUsListed } = require('../server/services/entityResolver');
  const { fetchRotation } = require('../server/services/ingest/finnhub');
  const { dedupe } = require('../server/services/ingest');
  const usNews = require('../server/services/usNews');
  if (!process.env.FINNHUB_API_KEY) throw new Error('FINNHUB_API_KEY is not set');

  const n = Math.min(US_NEWS.PER_RUN, Math.max(1, Number(flags.find((f) => /^\d+$/.test(f))) || 5));
  const from = flags.includes('--from') ? String(flags[flags.indexOf('--from') + 1] || '').toUpperCase() : '';
  const held = await heldAndWatched(query);
  const names = (await query(
    `SELECT ticker FROM companies
      WHERE is_active AND country = 'US' AND asset_class = 'equity' AND NOT (ticker = ANY($1)) AND ticker >= $2
      ORDER BY ticker LIMIT $3`,
    [held, from, n]
  )).map((r) => r.ticker);

  const started = Date.now();
  const r = await fetchRotation(names);
  const stories = dedupe(r.articles);
  const resolver = await loadIndex();
  const heldNames = held.map((ticker) => ({ ticker }));
  let kept = 0;
  const tagged = {};
  for (const a of stories) {
    const extra = [...heldNames, ...a.feeds.filter(isUsListed).map((ticker) => ({ ticker }))];
    const tickers = resolver.resolve(a.title, a.summary || '', extra, a.feeds).tickers;
    const inHeadline = resolver.resolve(a.title, '', extra, a.feeds).tickers;
    const keep = usNews.worthReading(a, tickers, inHeadline);
    if (keep) { kept++; for (const t of tickers) tagged[t] = (tagged[t] || 0) + 1; }
    console.log(`${keep ? 'keep' : 'drop'}  [${a.feeds.join(',')}] ${a.title.slice(0, 110)}${keep ? `  → ${tickers.join(', ')}` : ''}`);
  }
  const own = names.filter((t) => tagged[t]);
  console.log(`\n${r.checked.length} of ${names.length} name(s) answered in ${((Date.now() - started) / 1000).toFixed(1)}s${r.stopped ? ` (stopped: ${r.stopped})` : ''}: ${names.join(' ')}`);
  console.log(`${stories.length} stories fetched, ${kept} kept, ${stories.length - kept} dropped as about no company (before the tone is read; a few more can go after it)`);
  console.log(`${own.length} of ${names.length} name(s) have a story of their own: ${own.map((t) => `${t} ${tagged[t]}`).join(', ') || '—'}`);
  const others = Object.keys(tagged).filter((t) => !names.includes(t));
  if (others.length) console.log(`also tagged: ${others.map((t) => `${t} ${tagged[t]}`).join(', ')}`);
  console.log('Nothing was stored and the rotation was not moved.');
}

(async () => {
  const [cmd = 'status', ...flags] = process.argv.slice(2);
  if (cmd === 'status') await status();
  else if (cmd === 'try') await tryBatch(flags);
  else throw new Error(`unknown command "${cmd}" (status, try)`);
})()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => require('../server/db').closePool());
