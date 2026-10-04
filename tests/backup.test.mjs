import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { backupServer } from '../scripts/backup-server.mjs';
import { openStore } from '../server/store.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const script = fileURLToPath(new URL('../scripts/backup-server.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'study77-backup-test-'));
  const dataDir = path.join(root, 'data');
  const store = openStore(dataDir);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.db.exec('PRAGMA wal_autocheckpoint = 0');
  await mkdir(path.join(dataDir, 'files'), { mode: 0o700 });
  const bytes = Buffer.alloc(200_000, 7), id = 'test-attachment-123';
  await writeFile(path.join(dataDir, 'files', id), bytes, { mode: 0o600 });
  store.db.prepare('INSERT INTO files (id, mime_type, name, size, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'application/pdf', 'private.pdf', bytes.length, hash(bytes), new Date().toISOString());
  store.writeState({ version: 1, privateText: 'private-state-in-wal' }, 0, new Date().toISOString());
  store.db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run('a'.repeat(64), 1, Date.now() + 60_000);
  await writeFile(path.join(dataDir, '.env'), 'DO_NOT_COPY_PRIVATE_ENV');
  await writeFile(path.join(dataDir, 'token.txt'), 'DO_NOT_COPY_PRIVATE_TOKEN');
  await writeFile(path.join(dataDir, 'files', 'orphan-file-123'), 'unreferenced');
  return { root, dataDir, output: path.join(root, 'backup'), store, id, bytes };
}

test('online backup includes uncheckpointed WAL, referenced attachments and sessions, preserving source bytes', async (t) => {
  const f = await fixture(t);
  const database = path.join(f.dataDir, 'study77.sqlite');
  const wal = `${database}-wal`;
  assert.ok((await stat(wal)).size > 0);
  const beforeDb = hash(await readFile(database)), beforeWal = hash(await readFile(wal));
  const result = await backupServer({ dataDir: f.dataDir, output: f.output });
  assert.equal(result.fileCount, 1); assert.equal(result.totalFileBytes, f.bytes.length); assert.equal(result.revision, 1);
  assert.equal(hash(await readFile(database)), beforeDb); assert.equal(hash(await readFile(wal)), beforeWal);
  const restored = new DatabaseSync(path.join(f.output, 'study77.sqlite'), { readOnly: true });
  assert.equal(JSON.parse(restored.prepare('SELECT payload FROM state').get().payload).privateText, 'private-state-in-wal');
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal(restored.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  restored.close();
  assert.equal(hash(await readFile(path.join(f.output, 'files', f.id))), hash(f.bytes));
  assert.deepEqual((await readdir(f.output)).sort(), ['backup-manifest.json', 'files', 'study77.sqlite']);
  assert.deepEqual(await readdir(path.join(f.output, 'files')), [f.id]);
  const manifest = JSON.parse(await readFile(path.join(f.output, 'backup-manifest.json'), 'utf8'));
  assert.equal(manifest.databaseSha256, hash(await readFile(path.join(f.output, 'study77.sqlite'))));
  assert.equal(manifest.containsPrivateSessions, true);
  for (const dir of [f.output, path.join(f.output, 'files')]) assert.equal((await stat(dir)).mode & 0o777, 0o700);
  for (const file of ['study77.sqlite', 'backup-manifest.json', `files/${f.id}`]) assert.equal((await stat(path.join(f.output, file))).mode & 0o777, 0o600);
});

test('existing output directories and files are never overwritten', async (t) => {
  const f = await fixture(t);
  await mkdir(f.output); await writeFile(path.join(f.output, 'keep'), 'keep');
  await assert.rejects(backupServer({ dataDir: f.dataDir, output: f.output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(path.join(f.output, 'keep'), 'utf8'), 'keep');
  const file = path.join(f.root, 'existing-file'); await writeFile(file, 'original');
  await assert.rejects(backupServer({ dataDir: f.dataDir, output: file }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(file, 'utf8'), 'original');
});

test('output inside source is rejected including an alias through a symlink', async (t) => {
  const f = await fixture(t);
  await assert.rejects(backupServer({ dataDir: f.dataDir, output: path.join(f.dataDir, 'backup') }), { code: 'OUTPUT_INSIDE_SOURCE' });
  const alias = path.join(f.root, 'source-alias'); await symlink(f.dataDir, alias);
  await assert.rejects(backupServer({ dataDir: f.dataDir, output: path.join(alias, 'backup') }), { code: 'OUTPUT_INSIDE_SOURCE' });
});

test('missing source or database does not create an output or new database', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.root, 'missing');
  await assert.rejects(backupServer({ dataDir: missing, output: f.output }), { code: 'SOURCE_MISSING' });
  await mkdir(missing);
  await assert.rejects(backupServer({ dataDir: missing, output: f.output }), { code: 'DATABASE_MISSING' });
  assert.deepEqual(await readdir(missing), []);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('missing attachment cancels the backup and removes incomplete output', async (t) => {
  const f = await fixture(t); await rm(path.join(f.dataDir, 'files', f.id));
  await assert.rejects(backupServer({ dataDir: f.dataDir, output: f.output }), { code: 'ATTACHMENT_MISSING' });
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('same-size corruption fails SHA256 verification without altering the original', async (t) => {
  const f = await fixture(t), damaged = Buffer.alloc(f.bytes.length, 9);
  await writeFile(path.join(f.dataDir, 'files', f.id), damaged);
  await assert.rejects(backupServer({ dataDir: f.dataDir, output: f.output }), { code: 'ATTACHMENT_HASH_MISMATCH' });
  assert.equal(hash(await readFile(path.join(f.dataDir, 'files', f.id))), hash(damaged));
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('path traversal in snapshot attachment metadata is rejected', async (t) => {
  const f = await fixture(t);
  f.store.db.prepare('UPDATE files SET id = ? WHERE id = ?').run('../../private-token', f.id);
  await assert.rejects(backupServer({ dataDir: f.dataDir, output: f.output }), { code: 'ATTACHMENT_METADATA_INVALID' });
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('attachment symlinks are rejected even when their content matches', async (t) => {
  const f = await fixture(t), target = path.join(f.root, 'outside');
  await writeFile(target, f.bytes); await rm(path.join(f.dataDir, 'files', f.id)); await symlink(target, path.join(f.dataDir, 'files', f.id));
  await assert.rejects(backupServer({ dataDir: f.dataDir, output: f.output }), { code: 'ATTACHMENT_MISSING' });
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('CLI emits counts only and rejects unsupported options without printing secrets', async (t) => {
  const f = await fixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--data-dir', f.dataDir, '--output', f.output]);
  const result = JSON.parse(stdout); assert.equal(result.ok, true); assert.equal(result.fileCount, 1);
  assert.ok(!stdout.includes('private-state') && !stdout.includes('DO_NOT_COPY') && !stdout.includes(f.dataDir));
  await assert.rejects(promisify(execFile)(process.execPath, [script, '--token', 'DO_NOT_PRINT_SECRET']), (error) => !error.stderr.includes('DO_NOT_PRINT_SECRET') && error.stderr.includes('INVALID_ARGUMENTS'));
});

for (const [kind, partialState] of [
  ['original document', { imports: [{ originalFile: 'upload-pending-123' }] }],
  ['reference document', { imports: [{ referenceFile: 'upload-pending-123' }] }],
  ['private audio', { imports: [{ audio: 'file:upload-pending-123' }] }],
  ['imported vocabulary', { importedWords: [{ originalFile: 'upload-pending-123' }] }],
]) {
  test(`backup rejects state-before-upload race for ${kind}, preserving the previous complete backup`, async (t) => {
    const f = await fixture(t);
    await backupServer({ dataDir: f.dataDir, output: f.output });
    const previousManifest = await readFile(path.join(f.output, 'backup-manifest.json'), 'utf8');
    f.store.writeState({ version: 1, ...partialState }, 1, new Date().toISOString());
    const pendingOutput = path.join(f.root, 'backup-during-upload');
    await assert.rejects(backupServer({ dataDir: f.dataDir, output: pendingOutput }), { code: 'ATTACHMENT_REFERENCE_MISSING' });
    await assert.rejects(stat(pendingOutput), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.output, 'backup-manifest.json'), 'utf8'), previousManifest);
    assert.equal(f.store.getState().revision, 2);
  });
}

test('complete private references and empty initial state both produce usable backups', async (t) => {
  const f = await fixture(t);
  f.store.writeState({ version: 1, imports: [{ originalFile: f.id, referenceFile: f.id, audio: `file:${f.id}` }, { audio: '/audio/public.mp3' }], importedWords: [{ originalFile: f.id }] }, 1, new Date().toISOString());
  const complete = await backupServer({ dataDir: f.dataDir, output: f.output });
  assert.equal(complete.fileCount, 1);
  f.store.writeState({}, 2, new Date().toISOString());
  const initial = await backupServer({ dataDir: f.dataDir, output: path.join(f.root, 'initial-state-backup') });
  assert.equal(initial.revision, 3);
});
