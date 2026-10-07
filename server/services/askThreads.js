/**
 * Saved Ask conversations (E6 v2). Every read/write is scoped by user_id, so one user can
 * never open, extend or delete another user's thread — a thread id from another account
 * behaves exactly like a missing one.
 */

const { QA } = require('../config');

// pg returns BIGINT as a string; ids are small, so hand the API plain numbers.
const withNumId = (row) => (row ? { ...row, id: Number(row.id) } : row);

/** Thread title from its first question: one line, clamped. Pure. */
function titleFrom(question) {
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  return q.length > QA.THREAD_TITLE_CHARS ? q.slice(0, QA.THREAD_TITLE_CHARS - 1) + '…' : q;
}

async function createThread(userId, firstQuestion) {
  const { queryOne } = require('../db');
  return withNumId(await queryOne(
    'INSERT INTO ask_threads (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at, updated_at',
    [userId, titleFrom(firstQuestion)]
  ));
}

async function getThread(userId, threadId) {
  const { queryOne } = require('../db');
  const id = Number(threadId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return withNumId(await queryOne('SELECT id, title, created_at, updated_at FROM ask_threads WHERE id = $1 AND user_id = $2', [id, userId]));
}

async function listThreads(userId) {
  const { query } = require('../db');
  const rows = await query(
    `SELECT t.id, t.title, t.updated_at, count(m.id)::int / 2 AS turns
       FROM ask_threads t LEFT JOIN ask_messages m ON m.thread_id = t.id
      WHERE t.user_id = $1
      GROUP BY t.id
      ORDER BY t.updated_at DESC
      LIMIT $2`,
    [userId, QA.MAX_THREADS_LISTED]
  );
  return rows.map(withNumId);
}

async function getMessages(userId, threadId) {
  const thread = await getThread(userId, threadId);
  if (!thread) return null;
  const { query } = require('../db');
  const messages = await query(
    'SELECT role, content, writer, draft, claims_checked, claims_unsupported, unsupported, created_at FROM ask_messages WHERE thread_id = $1 ORDER BY id',
    [thread.id]
  );
  return { thread, messages };
}

/** Last QA.HISTORY_TURNS question/answer pairs, oldest first — what Claude sees on a follow-up. */
async function recentHistory(threadId) {
  const { query } = require('../db');
  const rows = await query(
    'SELECT role, content FROM ask_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT $2',
    [threadId, QA.HISTORY_TURNS * 2]
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

/**
 * The turns BEFORE the recent window, oldest first — raw material for the thread digest.
 * Bounded: only the QA.DIGEST_LOOKBACK_MESSAGES messages just before the window are read.
 */
async function olderTurns(threadId) {
  const { query } = require('../db');
  const rows = await query(
    'SELECT role, content FROM ask_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3',
    [threadId, QA.DIGEST_LOOKBACK_MESSAGES, QA.HISTORY_TURNS * 2]
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

/**
 * Digest of the older turns: the earlier questions (clipped) and the tickers that came up.
 * Built in code — no model call, nothing to hallucinate. `tickers` is supplied by the caller
 * (it owns the universe lookup). Returns '' when there is nothing older. Pure.
 */
function threadDigest(older, tickers = []) {
  const questions = (older || [])
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-QA.DIGEST_QUESTIONS)
    .map((q) => (q.length > QA.DIGEST_QUESTION_CHARS ? q.slice(0, QA.DIGEST_QUESTION_CHARS - 1) + '…' : q));
  if (!questions.length) return '';
  let out = `Earlier in this conversation I asked: ${questions.map((q, i) => `(${i + 1}) ${q}`).join(' ')}`;
  if (tickers.length) out += ` Holdings discussed so far: ${tickers.slice(0, 12).join(', ')}.`;
  return out.length > QA.DIGEST_MAX_CHARS ? out.slice(0, QA.DIGEST_MAX_CHARS - 1) + '…' : out;
}

// `grounding` = answerCheck result for model-written answers, else null.
// `draft` = a validated strategy draft the agent wrote on this turn, else null.
async function appendTurn(threadId, question, answer, writer, grounding = null, draft = null) {
  const { tx } = require('../db');
  const g = grounding
    ? [grounding.checked, grounding.unsupported.length, JSON.stringify(grounding.unsupported)]
    : [null, null, null];
  await tx(async (client) => {
    await client.query("INSERT INTO ask_messages (thread_id, role, content) VALUES ($1, 'user', $2)", [threadId, question]);
    await client.query(
      "INSERT INTO ask_messages (thread_id, role, content, writer, claims_checked, claims_unsupported, unsupported, draft) VALUES ($1, 'assistant', $2, $3, $4, $5, $6::jsonb, $7::jsonb)",
      [threadId, answer, writer, ...g, draft ? JSON.stringify(draft) : null]
    );
    await client.query('UPDATE ask_threads SET updated_at = now() WHERE id = $1', [threadId]);
  });
}

async function deleteThread(userId, threadId) {
  const { execute } = require('../db');
  const id = Number(threadId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = await execute('DELETE FROM ask_threads WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rowCount > 0;
}

/** Daily retention job: drop threads untouched for QA.THREAD_RETENTION_DAYS (messages cascade). */
async function purgeOldThreads() {
  const { execute } = require('../db');
  const r = await execute(
    "DELETE FROM ask_threads WHERE updated_at < now() - ($1 || ' days')::interval",
    [String(QA.THREAD_RETENTION_DAYS)]
  );
  return r.rowCount;
}

/**
 * Grounded answer rate over saved model-written answers, per writer. An answer is "grounded"
 * when the post-check found no unsupported claim. Answers with nothing checkable (no figure,
 * date, URL or company) are counted separately and left out of the rate, so they can't
 * inflate it. Threads are purged after
 * QA.THREAD_RETENTION_DAYS, so this never looks further back than that.
 */
async function groundingStats(days = QA.THREAD_RETENTION_DAYS) {
  const { query } = require('../db');
  const rows = await query(
    `SELECT writer, count(*)::int AS answers,
            count(*) FILTER (WHERE claims_checked > 0)::int AS answers_with_claims,
            count(*) FILTER (WHERE claims_checked > 0 AND claims_unsupported = 0)::int AS grounded,
            COALESCE(sum(claims_checked), 0)::int AS claims_checked,
            COALESCE(sum(claims_unsupported), 0)::int AS claims_unsupported
       FROM ask_messages
      WHERE role = 'assistant' AND claims_checked IS NOT NULL
        AND created_at > now() - ($1 || ' days')::interval
      GROUP BY writer ORDER BY writer`,
    [String(Math.max(1, Math.min(QA.THREAD_RETENTION_DAYS, Number(days) || QA.THREAD_RETENTION_DAYS)))]
  );
  return rows.map((r) => ({ ...r, grounded_rate: r.answers_with_claims ? Math.round((r.grounded / r.answers_with_claims) * 1000) / 1000 : null }));
}

module.exports = { titleFrom, createThread, getThread, listThreads, getMessages, recentHistory, olderTurns, threadDigest, appendTurn, deleteThread, purgeOldThreads, groundingStats };
