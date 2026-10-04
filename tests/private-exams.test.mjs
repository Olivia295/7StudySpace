import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importPrivateExams } from '../scripts/import-private-exams.mjs';
import { openStore } from '../server/store.mjs';

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'study77-private-exams-'));
  const dataDir = path.join(directory, 'private-data');
  const pdfPath = path.join(directory, 'exam.pdf');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  writeFileSync(pdfPath, pdf);
  const manifestPath = path.join(directory, 'manifest.json');
  const entry = { paperId: 'cet6-2025-06-1', title: '2025年6月六级 · 第一套', exam: 'cet6', year: 2025, sourceName: '来源机构', sourceUrl: 'https://example.org/exam', pdfPath, sections: ['阅读', '写作'], note: '原卷与机构参考答案。' };
  writeFileSync(manifestPath, JSON.stringify([entry]));
  return { directory, dataDir, pdfPath, pdf, manifestPath, entry, close: () => rmSync(directory, { recursive: true, force: true }) };
}

function existingState() {
  const at = '2026-10-01T00:00:00.000Z';
  return {
    version: 1,
    settings: { name: '77', budget: 40, companion: '小叶', tone: '耐心', instruction: '按自己的节奏', weeklyReview: false, updatedAt: at },
    events: [{ id: 'old-event', at, itemId: 'word-1', title: 'word', kind: 'vocabulary', rating: 'hard' }],
    reviews: { 'word-1': { due: at, interval: 1, lapses: 0, successes: 1, updatedAt: at } },
    progress: { 'word-1': { draft: 'Keep this draft', note: 'Keep this note', answers: {}, position: 3, completed: false, updatedAt: at } },
    imports: [], reports: [], chats: [{ id: 'old-chat', role: 'user', text: 'Keep this message', at }],
    session: { ids: ['word-1'], index: 0, kind: 'vocabulary', startedAt: at, updatedAt: at },
    futureField: { retained: true },
  };
}

test('private exam import preserves all existing records and stores originals behind the file API', async () => {
  const f = fixture();
  try {
    const before = existingState();
    const initial = openStore(f.dataDir);
    initial.writeState(before, 0, new Date().toISOString());
    initial.close();
    const result = await importPrivateExams(f);
    assert.equal(result.added, 1);
    assert.equal(result.backupCreated, true);
    const store = openStore(f.dataDir);
    try {
      const after = store.getState().state;
      assert.deepEqual({ ...after, imports: [] }, before);
      const lesson = after.imports[0];
      assert.equal(lesson.id, `import-paper-${f.entry.paperId}`);
      assert.deepEqual(lesson.tags, ['原卷阅读', `paper:${f.entry.paperId}`, '英语六级', '2025']);
      assert.equal(lesson.questions, undefined);
      assert.deepEqual(lesson.source, { title: f.entry.sourceName, url: f.entry.sourceUrl });
      assert.match(lesson.originalFile, /^pdf-[a-f0-9]{64}$/);
      assert.deepEqual(readFileSync(path.join(f.dataDir, 'files', lesson.originalFile)), f.pdf);
      const attachment = store.db.prepare('SELECT * FROM files WHERE id = ?').get(lesson.originalFile);
      assert.equal(attachment.mime_type, 'application/pdf');
      assert.equal(attachment.size, f.pdf.length);
      assert.equal(statSync(path.join(f.dataDir, 'files', lesson.originalFile)).mode & 0o777, 0o600);
      const backups = readdirSync(path.join(f.dataDir, 'backups'));
      assert.equal(backups.length, 1);
      assert.deepEqual(JSON.parse(readFileSync(path.join(f.dataDir, 'backups', backups[0]), 'utf8')).state, before);
      assert.equal(statSync(path.join(f.dataDir, 'backups', backups[0])).mode & 0o777, 0o600);
    } finally { store.close(); }
  } finally { f.close(); }
});

test('repeated import is idempotent and preserves later learner edits to an imported paper', async () => {
  const f = fixture();
  try {
    await importPrivateExams(f);
    const store = openStore(f.dataDir);
    const snapshot = store.getState();
    snapshot.state.imports[0].title = 'My edited title';
    snapshot.state.imports[0].body = 'My edited original-reading instructions';
    const edit = store.writeState(snapshot.state, snapshot.revision, new Date().toISOString());
    store.close();
    const result = await importPrivateExams(f);
    assert.deepEqual(result, { added: 0, skipped: 1, revision: edit.revision, backupCreated: false });
    const reopened = openStore(f.dataDir);
    try {
      assert.equal(reopened.getState().state.imports.length, 1);
      assert.equal(reopened.getState().state.imports[0].title, 'My edited title');
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM files').get().count, 1);
      assert.equal(readdirSync(path.join(f.dataDir, 'backups')).length, 1);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('reference answers are separate private attachments on the same lesson', async () => {
  const f = fixture();
  try {
    const referencePdfPath = path.join(f.directory, 'reference.pdf');
    const referenceBytes = Buffer.from('%PDF-1.4\nReference answers\n%%EOF\n');
    writeFileSync(referencePdfPath, referenceBytes);
    writeFileSync(f.manifestPath, JSON.stringify([{ ...f.entry, referencePdfPath, sourceDocumentUrl: 'https://example.org/original.pdf' }]));
    await importPrivateExams(f);
    const store = openStore(f.dataDir);
    try {
      const { imports } = store.getState().state;
      assert.equal(imports.length, 1);
      assert.match(imports[0].referenceFile, /^pdf-[a-f0-9]{64}$/);
      assert.notEqual(imports[0].referenceFile, imports[0].originalFile);
      assert.equal(imports[0].referenceName, 'reference.pdf');
      assert.deepEqual(readFileSync(path.join(f.dataDir, 'files', imports[0].referenceFile)), referenceBytes);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM files').get().count, 2);
      assert.equal(imports[0].source.url, f.entry.sourceUrl);
      assert.equal(JSON.parse(store.getMeta(`private_exam_source:${f.entry.paperId}`)).sourceDocumentUrl, 'https://example.org/original.pdf');
    } finally { store.close(); }
  } finally { f.close(); }
});

test('a bad PDF rejects the whole batch before adding the valid paper', async () => {
  const f = fixture();
  try {
    const wrong = path.join(f.directory, 'not-a-pdf.pdf');
    writeFileSync(wrong, '<html>Not a PDF</html>');
    writeFileSync(f.manifestPath, JSON.stringify([f.entry, { ...f.entry, paperId: 'invalid-paper', pdfPath: wrong }]));
    await assert.rejects(importPrivateExams(f), /不是有效的 PDF/);
    assert.equal(readdirSync(f.directory).includes('private-data'), false);
  } finally { f.close(); }
});

test('missing, oversized and directory PDF paths are rejected without modifying old records', async () => {
  const f = fixture();
  try {
    const before = existingState();
    const store = openStore(f.dataDir);
    store.writeState(before, 0, new Date().toISOString());
    store.close();
    const large = path.join(f.directory, 'large.pdf');
    writeFileSync(large, Buffer.alloc(30 * 1024 * 1024 + 1));
    const folder = path.join(f.directory, 'folder.pdf');
    mkdirSync(folder);
    for (const pdfPath of [path.join(f.directory, 'missing.pdf'), large, folder]) {
      writeFileSync(f.manifestPath, JSON.stringify([{ ...f.entry, pdfPath }]));
      await assert.rejects(importPrivateExams(f));
    }
    const reopened = openStore(f.dataDir);
    try { assert.deepEqual(reopened.getState().state, before); } finally { reopened.close(); }
  } finally { f.close(); }
});

test('malformed existing state is retained without adding private attachments', async () => {
  const f = fixture();
  try {
    const store = openStore(f.dataDir);
    const malformed = { version: 1, important: 'keep this evidence' };
    store.writeState(malformed, 0, new Date().toISOString());
    store.close();
    await assert.rejects(importPrivateExams(f), /已有记录不符合/);
    const reopened = openStore(f.dataDir);
    try {
      assert.deepEqual(reopened.getState().state, malformed);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM files').get().count, 0);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('duplicate manifest IDs and relative original paths are rejected', async () => {
  const f = fixture();
  try {
    for (const entries of [[f.entry, f.entry], [{ ...f.entry, pdfPath: 'exam.pdf' }]]) {
      writeFileSync(f.manifestPath, JSON.stringify(entries));
      await assert.rejects(importPrivateExams(f), /清单无法读取或格式不正确/);
    }
  } finally { f.close(); }
});
