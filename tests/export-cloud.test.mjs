import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportCloudForServer, parseExportArguments } from '../scripts/export-cloud-for-server.mjs';
import { openStore } from '../server/store.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'study77-cloud-export-'));
  const sessionFile = path.join(directory, 'session.json'), outputDir = path.join(directory, 'new-server-data');
  const cookie = 'study77_session=unit_test_session_token_value';
  writeFileSync(sessionFile, JSON.stringify({ origin: 'https://test.example', cookie }), { mode: 0o600 });
  const at = '2026-10-04T00:00:00.000Z';
  const state = {
    version: 1,
    settings: { name: '77', budget: 40, companion: '小叶', tone: '耐心', instruction: '自己的节奏', weeklyReview: false, updatedAt: at },
    events: [{ id: 'event-one', at, itemId: 'reading-one', title: '保留记录', kind: 'reading', correct: 2, total: 3 }],
    reviews: { 'reading-one': { due: at, interval: 1, lapses: 0, successes: 1, updatedAt: at } },
    progress: { 'reading-one': { draft: '私人草稿', note: '私人笔记', answers: { q1: 1 }, position: 4, completed: false, updatedAt: at } },
    imports: [{ id: 'import-one', kind: 'reading', title: '私人原卷', subtitle: '原卷', level: '真题', minutes: 18, tags: ['原卷阅读'], body: '私人正文', source: { title: '原始资料' }, originalFile: 'original-01', referenceFile: 'reference-01', audio: 'file:audio-file-01' }],
    importedWords: [{ id: 'word-one', word: 'learn', pos: 'v.', meaning: '学习', example: 'Learn.', tags: [], source: '私人词本', originalFile: 'words-file-01' }],
    reports: [], chats: [{ id: 'chat-one', role: 'user', text: '私人对话', at }],
    session: { ids: ['import-one'], kind: 'lesson', index: 0, startedAt: at, updatedAt: at },
    futureField: { retained: true },
  };
  const snapshot = { state, revision: 42, updatedAt: at };
  const files = Object.fromEntries([
    ['original-01', '%PDF1', 'application/pdf', '原卷.pdf'],
    ['reference-01', 'answer', 'application/pdf', '参考.pdf'],
    ['audio-file-01', 'sound', 'audio/wav', '听力.wav'],
    ['words-file-01', 'word', 'text/csv', '词本.csv'],
  ].map(([id, text, mimeType, name]) => { const bytes = Buffer.from(text); return [id, { bytes, meta: { id, mimeType, name, size: bytes.length, totalChunks: Math.ceil(bytes.length / 3), contentHash: sha(bytes) } }]; }));
  const calls = []; let stateReads = 0;
  const f = {
    directory, sessionFile, outputDir, cookie, snapshot, files, calls,
    session: { authenticated: true, fileTransport: 'chunks', maxChunkBytes: 3 },
    mutateState: undefined, mutateMeta: undefined, mutateChunk: undefined,
    async fetchImpl(url, options) {
      assert.equal(url.origin, 'https://test.example');
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Cookie, cookie); assert.equal(options.headers.Origin, url.origin);
      calls.push(url.pathname);
      if (url.pathname === '/api/session') return json(f.session);
      if (url.pathname === '/api/state') { stateReads++; return json(f.mutateState?.(structuredClone(snapshot), stateReads) ?? snapshot); }
      const match = url.pathname.match(/^\/api\/files\/([^/]+)\/(meta|chunks\/(\d+))$/);
      if (!match || !files[match[1]]) return new Response(null, { status: 404 });
      const file = files[match[1]];
      if (match[2] === 'meta') return json(f.mutateMeta?.(structuredClone(file.meta)) ?? file.meta);
      const index = Number(match[3]); const bytes = file.bytes.subarray(index * 3, (index + 1) * 3);
      return new Response(f.mutateChunk?.(match[1], index, bytes) ?? bytes);
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
  return f;
}

test('exports the exact snapshot and every referenced attachment using GET only, with no migrated credentials or jobs', async () => {
  const f = fixture();
  try {
    // Same attachment referenced twice must not trigger another download.
    f.snapshot.state.importedWords.push({ ...f.snapshot.state.importedWords[0], id: 'word-two', originalFile: 'original-01' });
    const result = await exportCloudForServer(f);
    assert.deepEqual(result, { verified: true, revision: 42, updatedAt: f.snapshot.updatedAt, files: 4, imports: 1, events: 1, aiQueueMigrated: false, requiresBootstrap: true });
    const manifestPath = path.join(f.outputDir, 'export-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.format, 'study77-server-export'); assert.equal(manifest.verified, true);
    assert.equal(manifest.revision, f.snapshot.revision); assert.equal(manifest.files, 4);
    assert.equal(manifest.database.sha256, sha(readFileSync(path.join(f.outputDir, 'study77.sqlite'))));
    assert.equal(manifest.stateHash, sha(Buffer.from(JSON.stringify(f.snapshot.state))));
    assert.equal(manifest.attachments.length, 4);
    assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
    const manifestText = readFileSync(manifestPath, 'utf8');
    assert.ok(!manifestText.includes(f.cookie)); assert.ok(!manifestText.includes('私人正文')); assert.ok(!manifestText.includes('私人草稿'));
    const store = openStore(f.outputDir);
    try {
      assert.deepEqual(store.getState(), f.snapshot);
      for (const name of ['sessions', 'pairing', 'jobs']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count, 0);
      assert.equal(store.getMeta('initialized'), undefined); assert.equal(store.getMeta('bootstrap_hash'), undefined);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM files').get().count, 4);
      for (const [id, file] of Object.entries(f.files)) {
        assert.deepEqual(readFileSync(path.join(f.outputDir, 'files', id)), file.bytes);
        const saved = store.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
        assert.equal(saved.content_hash, file.meta.contentHash); assert.equal(saved.size, file.meta.size);
        assert.equal(saved.name, file.meta.name); assert.equal(saved.mime_type, file.meta.mimeType);
        assert.equal(statSync(path.join(f.outputDir, 'files', id)).mode & 0o777, 0o600);
      }
      assert.equal(JSON.parse(store.getMeta('migration_export')).aiQueueMigrated, false);
    } finally { store.close(); }
    assert.equal(statSync(f.outputDir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(f.outputDir, 'study77.sqlite')).mode & 0o777, 0o600);
    assert.equal(f.calls.filter(route => route === '/api/files/original-01/meta').length, 1);
    assert.equal(f.calls.filter(route => route === '/api/state').length, 2);
    assert.ok(!JSON.stringify(result).includes(f.cookie));
    assert.ok(!readFileSync(path.join(f.outputDir, 'study77.sqlite')).includes(Buffer.from(f.cookie)));
  } finally { f.close(); }
});

test('refuses existing output directories and does not change any old data', async () => {
  const f = fixture();
  try {
    mkdirSync(f.outputDir); writeFileSync(path.join(f.outputDir, 'keep'), 'existing private record');
    await assert.rejects(exportCloudForServer(f), /输出目录已存在/);
    assert.equal(f.calls.length, 0);
    assert.equal(readFileSync(path.join(f.outputDir, 'keep'), 'utf8'), 'existing private record');
  } finally { f.close(); }
});

test('refuses dangling output symlinks without deleting the symlink', async () => {
  const f = fixture();
  try {
    symlinkSync(path.join(f.directory, 'absent-data'), f.outputDir);
    await assert.rejects(exportCloudForServer(f), /输出目录已存在/);
    assert.ok(readdirSync(f.directory).includes('new-server-data')); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('rejects insecure origins and invalid credentials before making requests', async () => {
  const f = fixture();
  try {
    for (const origin of ['http://test.example', 'https://test.example/private', 'https://user:secret@test.example', 'https://test.example?token=secret']) {
      writeFileSync(f.sessionFile, JSON.stringify({ origin, cookie: f.cookie }));
      await assert.rejects(exportCloudForServer(f), /只允许 HTTPS/);
      assert.equal(existsSync(f.outputDir), false);
    }
    writeFileSync(f.sessionFile, JSON.stringify({ origin: 'https://test.example', cookie: `${f.cookie}\r\nInjected: header` }));
    await assert.rejects(exportCloudForServer(f), /有效的学习室会话/); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('cleans only its new directory after hash mismatch, leaving credentials and sibling data intact', async () => {
  const f = fixture();
  try {
    const untouched = path.join(f.directory, 'old-data'); mkdirSync(untouched); writeFileSync(path.join(untouched, 'keep'), 'do not delete');
    const credentials = readFileSync(f.sessionFile);
    f.mutateChunk = (id, index, bytes) => id === 'reference-01' && index === 0 ? Buffer.alloc(bytes.length, 65) : bytes;
    await assert.rejects(exportCloudForServer(f), /附件内容校验失败/);
    assert.equal(existsSync(f.outputDir), false);
    assert.equal(readFileSync(path.join(untouched, 'keep'), 'utf8'), 'do not delete');
    assert.deepEqual(readFileSync(f.sessionFile), credentials);
  } finally { f.close(); }
});

test('rejects truncated files, oversized metadata and invalid file IDs without creating a completed export', async () => {
  for (const problem of ['truncated', 'oversized', 'id']) {
    const f = fixture();
    try {
      if (problem === 'truncated') f.mutateChunk = (_id, _index, bytes) => bytes.subarray(1);
      if (problem === 'oversized') f.mutateMeta = meta => ({ ...meta, size: 30 * 1024 * 1024 + 1 });
      if (problem === 'id') f.snapshot.state.imports[0].originalFile = '../../outside';
      await assert.rejects(exportCloudForServer(f), /完整下载|超过 30 MB|无效附件编号/);
      assert.equal(existsSync(f.outputDir), false);
    } finally { f.close(); }
  }
});

test('requires unchanged revision, update time and state at the end, including same-payload new revisions', async () => {
  for (const change of ['revision', 'updatedAt', 'state']) {
    const f = fixture();
    try {
      f.mutateState = (snapshot, reads) => {
        if (reads === 2) {
          if (change === 'revision') snapshot.revision++;
          if (change === 'updatedAt') snapshot.updatedAt = '2026-10-04T00:01:00.000Z';
          if (change === 'state') snapshot.state.progress['reading-one'].draft = 'concurrent edit';
        }
        return snapshot;
      };
      await assert.rejects(exportCloudForServer(f), /发生了变化/);
      assert.equal(existsSync(f.outputDir), false);
    } finally { f.close(); }
  }
});

test('does not expose unexpected network error text or leave a partial directory', async () => {
  const f = fixture();
  try {
    f.fetchImpl = async () => { throw new Error(`${f.cookie} private response body`); };
    await assert.rejects(exportCloudForServer(f), error => /连接中断/.test(error.message) && !error.message.includes(f.cookie) && !error.message.includes('private response'));
    assert.equal(existsSync(f.outputDir), false);
  } finally { f.close(); }
});

test('refuses unsupported state or expired pairing instead of exporting an empty replacement', async () => {
  for (const problem of ['state', 'auth', 'transport']) {
    const f = fixture();
    try {
      if (problem === 'state') f.snapshot.state.version = 2;
      if (problem === 'auth') f.session.authenticated = false;
      if (problem === 'transport') f.session.fileTransport = 'raw';
      await assert.rejects(exportCloudForServer(f), /记录格式不完整|会话已失效|传输方式不受支持/);
      assert.equal(existsSync(f.outputDir), false);
    } finally { f.close(); }
  }
});


test('CLI accepts relative paths, prefers --output, supports its alias and help', () => {
  const expected = { sessionFile: path.resolve('data/cloud-session.json'), outputDir: path.resolve('data/hk-migration-01') };
  assert.deepEqual(parseExportArguments(['--session-file', 'data/cloud-session.json', '--output', 'data/hk-migration-01']), expected);
  assert.deepEqual(parseExportArguments(['--session-file', 'data/cloud-session.json', '--output-dir', 'data/hk-migration-01']), expected);
  assert.equal(parseExportArguments(['--help']), null); assert.equal(parseExportArguments(['-h']), null);
  assert.throws(() => parseExportArguments(['--session-file', 'data/session.json', '--output', 'data/one', '--output-dir', 'data/two']), /用法/);
});
