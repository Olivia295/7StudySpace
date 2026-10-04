#!/usr/bin/env node
// Owner-only local import. Originals stay behind the authenticated file API.
// Usage: node scripts/import-private-exams.mjs --manifest /absolute/exams.json --data-dir /absolute/data
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import ts from 'typescript';
import { openStore } from '../server/store.mjs';

const MAX_PDF_BYTES = 30 * 1024 * 1024;
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceUrl = z.string().url().refine(value => /^https?:\/\//i.test(value), '来源网址需要使用 http 或 https');
const manifestSchema = z.array(z.object({
  paperId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/),
  title: z.string().trim().min(1).max(190),
  exam: z.enum(['cet6', 'postgraduate']),
  year: z.number().int().min(1900).max(2200),
  sourceName: z.string().trim().min(1).max(200),
  sourceUrl,
  sourceDocumentUrl: sourceUrl.optional(),
  pdfPath: z.string().refine(value => path.isAbsolute(value), 'PDF 路径需要是绝对路径'),
  referencePdfPath: z.string().refine(value => path.isAbsolute(value), '参考答案 PDF 路径需要是绝对路径').optional(),
  sections: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  note: z.string().max(25000).optional(),
}).strict()).min(1).max(200).superRefine((entries, context) => {
  const seen = new Set();
  entries.forEach((entry, index) => {
    if (seen.has(entry.paperId)) context.addIssue({ code: 'custom', path: [index, 'paperId'], message: '同一清单内试卷编号不能重复' });
    seen.add(entry.paperId);
  });
});

let validationModules;
async function currentValidation() {
  // Keep the importer aligned with the app without generated files or a second schema.
  validationModules ??= Promise.all(['schema', 'study'].map(async name => {
    const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    if (compiled.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error('当前数据校验模块无法载入，未修改学习记录。');
    const javascript = compiled.outputText.replace(/from (['"])zod\1/g, `from ${JSON.stringify(import.meta.resolve('zod'))}`);
    return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
  })).then(([schema, study]) => ({ ...schema, freshState: study.freshState }));
  return validationModules;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function privateDirectory(dataDir) {
  if (!path.isAbsolute(dataDir) || path.resolve(dataDir) === path.parse(dataDir).root || path.resolve(dataDir) === path.resolve(root)) {
    throw new Error('请指定独立私有 data 文件夹的绝对路径。');
  }
  const forbidden = ['public', 'dist', '.git'].map(name => path.resolve(root, name));
  if (forbidden.some(directory => isInside(directory, path.resolve(dataDir)))) throw new Error('原卷不能写入公开资源或代码元数据目录。');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const actual = realpathSync(dataDir);
  if (forbidden.some(directory => isInside(directory, actual))) throw new Error('原卷不能写入指向公开目录的位置。');
  chmodSync(actual, 0o700);
  return actual;
}

function checkedPdf(pdfPath, index) {
  try {
    const metadata = statSync(pdfPath);
    if (!metadata.isFile() || path.extname(pdfPath).toLowerCase() !== '.pdf') throw new Error('not_pdf');
    if (!metadata.size || metadata.size > MAX_PDF_BYTES) throw new Error('size');
    const bytes = readFileSync(pdfPath);
    if (bytes.length > MAX_PDF_BYTES || !/^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii')) || !bytes.subarray(-2048).includes(Buffer.from('%%EOF'))) throw new Error('not_pdf');
    return bytes;
  } catch (error) {
    if (error.message === 'size') throw new Error(`第 ${index + 1} 份 PDF 为空或超过 30MB，未导入。`);
    if (error.message === 'not_pdf') throw new Error(`第 ${index + 1} 份文件不是有效的 PDF 原件，未导入。`);
    throw new Error(`第 ${index + 1} 份 PDF 无法读取，请核对本机文件路径。`);
  }
}

const contentHash = bytes => createHash('sha256').update(bytes).digest('hex');
function assertStudyState(schema, state, label) {
  if (!schema.safeParse(state).success) throw new Error(`${label}不符合学习室数据格式，已停止导入以保留原记录。`);
  if (Buffer.byteLength(JSON.stringify(state)) > 12_000_000) throw new Error('合并后的记录超过同步容量，已停止导入。');
}

function createLesson(entry, fileId, at, reference) {
  const examName = entry.exam === 'cet6' ? '英语六级' : '考研英语一';
  return {
    id: `import-paper-${entry.paperId}`,
    kind: 'reading',
    title: entry.title,
    subtitle: '真题原卷 · 已导入 · 可逐页阅读',
    level: '自选',
    minutes: 30,
    tags: ['原卷阅读', `paper:${entry.paperId}`, examName, String(entry.year)],
    body: [
      '这份真题原卷已保存在学习室。可以逐页阅读 PDF，分次练习，并在作答区留下答案、思路与笔记。',
      '当前保留原卷版式，尚未自动拆成选择题，不会据此计算客观题正确率。',
      reference ? '参考答案单独保存。可以先独立作答，再打开参考答案核对。' : '',
      `资料来源：${entry.sourceName}。如原卷附有机构整理的答案或解析，请把它作为参考，结合原题核对。`,
      entry.sections?.length ? `收录部分：${entry.sections.join('、')}。` : '',
      entry.note ?? '',
    ].filter(Boolean).join('\n\n'),
    originalFile: fileId,
    originalName: path.basename(entry.pdfPath).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200),
    ...(reference ? { referenceFile: reference.fileId, referenceName: reference.name } : {}),
    source: { title: entry.sourceName, url: entry.sourceUrl },
    updatedAt: at,
  };
}

function retainFile(store, directory, prepared) {
  const bytes = checkedPdf(prepared.pdfPath, prepared.index);
  if (contentHash(bytes) !== prepared.hash) throw new Error('准备期间有 PDF 文件发生变化，请重新核对后导入。');
  const target = path.join(directory, prepared.fileId);
  const existing = store.db.prepare('SELECT mime_type, content_hash FROM files WHERE id = ?').get(prepared.fileId);
  if (existing && (existing.mime_type !== 'application/pdf' || existing.content_hash !== prepared.hash)) throw new Error('原件编号发生冲突，已有文件未被替换。');
  try {
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('原卷无法保存，学习记录尚未更新。');
    if (contentHash(readFileSync(target)) !== prepared.hash) throw new Error('私有附件与导入原卷不一致，已有文件未被替换。');
  }
  chmodSync(target, 0o600);
}

export async function importPrivateExams({ manifestPath, dataDir }) {
  if (!path.isAbsolute(manifestPath)) throw new Error('导入清单需要使用绝对路径。');
  let manifest;
  try {
    if (statSync(manifestPath).size > 2_000_000) throw new Error('manifest_size');
    manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch {
    throw new Error('导入清单无法读取或格式不正确，请检查字段、绝对路径和重复试卷编号。');
  }
  const { stateSchema, lessonSchema, freshState } = await currentValidation();
  const at = new Date().toISOString();
  // Validate the entire batch before opening or changing the target database.
  const prepared = manifest.map((entry, index) => {
    const bytes = checkedPdf(entry.pdfPath, index);
    const hash = contentHash(bytes), fileId = `pdf-${hash}`;
    let reference;
    if (entry.referencePdfPath) {
      const referenceBytes = checkedPdf(entry.referencePdfPath, index);
      const referenceHash = contentHash(referenceBytes);
      reference = { pdfPath: entry.referencePdfPath, index, hash: referenceHash, fileId: `pdf-${referenceHash}`, size: referenceBytes.length, name: path.basename(entry.referencePdfPath).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) };
    }
    const lesson = createLesson(entry, fileId, at, reference);
    if (!lessonSchema.safeParse(lesson).success) throw new Error(`第 ${index + 1} 份试卷资料格式不正确，未导入。`);
    return { entry, index, hash, fileId, size: bytes.length, lesson, reference, pdfPath: entry.pdfPath, name: lesson.originalName };
  });
  const directory = privateDirectory(dataDir);
  const store = openStore(directory);
  let backupCreated = false;
  try {
    for (let retry = 0; retry < 8; retry++) {
      const snapshot = store.getState();
      const current = Object.keys(snapshot.state).length === 0 ? freshState() : snapshot.state;
      assertStudyState(stateSchema, current, '已有记录');
      const ids = new Set(current.imports.map(lesson => lesson.id));
      const missing = prepared.filter(item => !ids.has(item.lesson.id));
      if (!missing.length) return { added: 0, skipped: prepared.length, revision: snapshot.revision, backupCreated };
      const next = { ...current, imports: [...current.imports, ...missing.map(item => item.lesson)] };
      assertStudyState(stateSchema, next, '合并记录');

      const backups = path.join(directory, 'backups');
      mkdirSync(backups, { recursive: true, mode: 0o700 });
      chmodSync(backups, 0o700);
      const backupPath = path.join(backups, `before-private-exams-${at.replace(/[:.]/g, '-')}-r${snapshot.revision}-${randomUUID()}.json`);
      writeFileSync(backupPath, JSON.stringify({ exportedAt: at, ...snapshot }, null, 2), { flag: 'wx', mode: 0o600 });
      backupCreated = true;

      const files = path.join(directory, 'files');
      mkdirSync(files, { recursive: true, mode: 0o700 });
      chmodSync(files, 0o700);
      const attachments = missing.flatMap(item => item.reference ? [item, item.reference] : [item]);
      for (const item of attachments) retainFile(store, files, item);
      store.db.exec('BEGIN IMMEDIATE');
      try {
        const insert = store.db.prepare('INSERT OR IGNORE INTO files (id, mime_type, name, size, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (const item of attachments) insert.run(item.fileId, 'application/pdf', item.name, item.size, item.hash, at);
        const provenance = store.db.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)');
        for (const item of missing) provenance.run(`private_exam_source:${item.entry.paperId}`, JSON.stringify({
          sourceName: item.entry.sourceName, sourceUrl: item.entry.sourceUrl,
          ...(item.entry.sourceDocumentUrl ? { sourceDocumentUrl: item.entry.sourceDocumentUrl } : {}),
          originalFile: item.fileId, ...(item.reference ? { referenceFile: item.reference.fileId } : {}), importedAt: at,
        }));
        store.db.exec('COMMIT');
      } catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
      }
      // A running browser may save during PDF copying. Retry from its newer state.
      const result = store.writeState(next, snapshot.revision, new Date().toISOString());
      if (result.changed) return { added: missing.length, skipped: prepared.length - missing.length, revision: result.revision, backupCreated };
    }
    throw new Error('学习记录正在持续更新，原卷已私下保留；请稍后再次导入，旧记录没有被覆盖。');
  } finally {
    store.close();
  }
}

function argumentsFromCli(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index], value = args[index + 1];
    if (!['--manifest', '--data-dir'].includes(option) || !value || Object.hasOwn(values, option)) throw new Error('用法：--manifest /绝对路径/清单.json --data-dir /绝对路径/data');
    values[option] = value;
  }
  if (!values['--manifest'] || !values['--data-dir']) throw new Error('必须同时指定 --manifest 和 --data-dir 的绝对路径。');
  return { manifestPath: values['--manifest'], dataDir: values['--data-dir'] };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await importPrivateExams(argumentsFromCli(process.argv.slice(2)));
    // Counts only: never print private state, attachment content or credentials.
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : '导入未完成，原记录仍保留。');
    process.exitCode = 1;
  }
}
