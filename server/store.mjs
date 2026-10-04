import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

export const hashToken = (value) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export function equalHash(value, expected) {
  if (typeof expected !== 'string' || expected.length !== 64) return false;
  return timingSafeEqual(Buffer.from(hashToken(value), 'hex'), Buffer.from(expected, 'hex'));
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, 'study77.sqlite');
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS state (
      id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairing (
      code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
      consumed_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      input TEXT NOT NULL, result TEXT, error TEXT, dedupe_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, name TEXT NOT NULL,
      size INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT OR IGNORE INTO state (id, payload, revision, updated_at) VALUES (1, ?, 0, ?)')
    .run('{}', new Date().toISOString());
  return {
    db,
    close: () => db.close(),
    getMeta: (key) => db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value,
    setMeta: (key, value) => db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
    getState() {
      const row = db.prepare('SELECT payload, revision, updated_at FROM state WHERE id = 1').get();
      return { state: JSON.parse(row.payload), revision: row.revision, updatedAt: row.updated_at };
    },
    writeState(state, expectedRevision, timestamp) {
      const changed = db.prepare('UPDATE state SET payload = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?')
        .run(JSON.stringify(state), timestamp, expectedRevision);
      return { changed: changed.changes === 1, ...this.getState() };
    },
  };
}

export function issueBootstrapToken(store) {
  if (store.getMeta('initialized') === '1') throw new Error('此空间已经初始化，请使用已登录设备生成配对码。');
  const token = newToken();
  store.setMeta('bootstrap_hash', hashToken(token));
  return token;
}

export function jobFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error ? JSON.parse(row.error) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
