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
    'SELECT role, content, writer, created_at FROM ask_messages WHERE thread_id = $1 ORDER BY id',
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

async function appendTurn(threadId, question, answer, writer) {
  const { tx } = require('../db');
  await tx(async (client) => {
    await client.query("INSERT INTO ask_messages (thread_id, role, content) VALUES ($1, 'user', $2)", [threadId, question]);
    await client.query("INSERT INTO ask_messages (thread_id, role, content, writer) VALUES ($1, 'assistant', $2, $3)", [threadId, answer, writer]);
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

module.exports = { titleFrom, createThread, getThread, listThreads, getMessages, recentHistory, appendTurn, deleteThread, purgeOldThreads };
