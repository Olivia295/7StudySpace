import { randomUUID } from 'node:crypto';
import { jobFromRow } from './store.mjs';

/**
 * A runner is trusted server code, never a browser-supplied command or URL.
 * codex-runner.mjs pins the verified CLI version, disables execution surfaces,
 * and denies remaining local tools before execution with a static hook.
 * Production activation is explicit. A disabled worker retains pending input;
 * model instructions alone are never treated as the execution boundary.
 */
export function createWorker(store, { runJob, disabledReason = 'CODEX_WORKER_DISABLED', now = () => Date.now() } = {}) {
  let busy = false;
  let closed = false;
  let timer;
  const enabled = typeof runJob === 'function';
  const status = () => ({
    enabled,
    provider: 'codex-local',
    reason: enabled ? null : disabledReason,
    message: enabled
      ? '本机 AI 工作端已连接。'
      : 'AI 任务会保留。本机 AI 工作端尚未开启或当前版本需要重新验证；开启后才会开始处理。',
  });
  // A process stopped midway must not leave a job permanently running.
  store.db.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE status = 'running'")
    .run(enabled ? 'queued' : 'unavailable', enabled ? null : JSON.stringify({ code: 'WORKER_UNAVAILABLE', message: status().message }), new Date(now()).toISOString());
  if (enabled) store.db.prepare("UPDATE jobs SET status = 'queued', error = NULL WHERE status = 'unavailable'").run();

  async function pump() {
    if (!enabled || busy || closed) return;
    const row = store.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get();
    if (!row) return;
    busy = true;
    const timestamp = () => new Date(now()).toISOString();
    store.db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(timestamp(), row.id);
    try {
      const result = await runJob(JSON.parse(row.input), { id: row.id });
      if (closed) return;
      if (!result || typeof result !== 'object' || typeof result.text !== 'string' || result.text.length > 100_000) {
        throw Object.assign(new Error('AI 返回的结果格式不符合约定。'), { code: 'INVALID_WORKER_RESULT' });
      }
      store.db.prepare("UPDATE jobs SET status = 'completed', result = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), timestamp(), row.id);
    } catch (error) {
      if (closed) return;
      // Never reflect process output or credentials through an API error.
      const safe = { code: error?.code === 'INVALID_WORKER_RESULT' ? error.code : 'WORKER_FAILED', message: '本次 AI 任务未能完成；原始学习记录仍已保存。' };
      store.db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(safe), timestamp(), row.id);
    } finally {
      busy = false;
      if (!closed) timer = setTimeout(pump, 0);
    }
  }
  return {
    status,
    enqueue(input, dedupeKey) {
      const existing = store.db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(dedupeKey);
      if (existing) return { job: jobFromRow(existing), duplicate: true };
      const id = randomUUID();
      const timestamp = new Date(now()).toISOString();
      const error = enabled ? null : { code: 'WORKER_UNAVAILABLE', message: status().message };
      store.db.prepare('INSERT INTO jobs (id, kind, status, input, error, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.kind, enabled ? 'queued' : 'unavailable', JSON.stringify(input), error ? JSON.stringify(error) : null, dedupeKey, timestamp, timestamp);
      timer = setTimeout(pump, 0);
      return { job: jobFromRow(store.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)), duplicate: false };
    },
    start() { timer = setTimeout(pump, 0); },
    close() { closed = true; clearTimeout(timer); },
  };
}
