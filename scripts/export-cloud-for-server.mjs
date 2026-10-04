#!/usr/bin/env node
// Read-only cloud export. Never copies login credentials or the server's AI queue.
// node scripts/export-cloud-for-server.mjs --session-file /private/session.json --output /private/new-server-data
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { openStore } from '../server/store.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_CHUNK_BYTES = 3_000_000;
const MAX_STATE_BYTES = 12_000_000;
const FILE_ID = /^[A-Za-z0-9_-]{8,100}$/;
const FILE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/flac', 'text/plain', 'text/csv', 'application/json', 'text/markdown']);
class ExportError extends Error {}
const fail = message => { throw new ExportError(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, target) => { const relative = path.relative(parent, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value));
let validation;
async function stateValidator() {
  validation ??= (async () => {
    const source = readFileSync(new URL('../src/lib/schema.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
    if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) fail('当前记录校验程序无法载入，未开始导出。');
    const javascript = compiled.outputText.replace(/from (['"])zod\1/g, `from ${JSON.stringify(import.meta.resolve('zod'))}`);
    return (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)).stateSchema;
  })();
  return validation;
}
function readCredentials(sessionFile) {
  if (typeof sessionFile !== 'string' || !path.isAbsolute(sessionFile)) fail('--session-file 必须是私有凭据文件的绝对路径。');
  let actual, credentials;
  try {
    actual = realpathSync(sessionFile);
    const stat = statSync(actual);
    if (!stat.isFile() || stat.size > 16_384) fail('配对凭据文件无法读取或格式不正确。');
    if (inside(ROOT, actual)) {
      const ignored = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path.relative(ROOT, actual)], { cwd: ROOT, stdio: 'ignore' });
      if (ignored.status !== 0) fail('请把配对凭据放在 Git 忽略的私有目录，或代码仓库外。');
    }
    credentials = JSON.parse(readFileSync(actual, 'utf8'));
  } catch (error) { if (error instanceof ExportError) throw error; fail('配对凭据文件无法读取或格式不正确。'); }
  let origin;
  try { origin = new URL(credentials.origin); } catch { fail('凭据中必须提供完整的 HTTPS 站点来源。'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('只允许 HTTPS 站点来源，不允许路径、查询参数或内嵌凭据。');
  if (typeof credentials.cookie !== 'string' || !/^study77_session=[A-Za-z0-9_-]{20,256}$/.test(credentials.cookie)) fail('配对凭据缺少有效的学习室会话。');
  return { origin: origin.origin, cookie: credentials.cookie };
}
function destinationPath(outputDir) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) fail('--output 必须是全新私有目录的绝对路径。');
  try { lstatSync(outputDir); fail('输出目录已存在；为保护旧资料，请换一个全新目录。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let parent;
  try { parent = realpathSync(path.dirname(outputDir)); if (!statSync(parent).isDirectory()) throw Error(); }
  catch { fail('输出目录的父文件夹必须已经存在。'); }
  const target = path.join(parent, path.basename(outputDir));
  if (['public', 'dist', '.git', 'node_modules'].some(name => inside(path.join(ROOT, name), target))) fail('迁移数据不能写入公开资源或代码元数据目录。');
  return target;
}
async function readBytes(response, limit) {
  const length = response.headers.get('content-length');
  if (length !== null && (!Number.isSafeInteger(Number(length)) || Number(length) < 0 || Number(length) > limit)) fail('云端响应大小异常，导出已停止。');
  const chunks = []; let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) fail('云端响应超过大小限制，导出已停止。');
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks, size);
}
function checkedSnapshot(snapshot, schema) {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !timestamp(snapshot.updatedAt) || !schema.safeParse(snapshot.state).success) fail('云端学习记录格式不完整，已停止导出以保留原记录。');
  // Validate without using Zod's parsed copy: unknown future fields must survive.
  if (Buffer.byteLength(JSON.stringify(snapshot.state)) > MAX_STATE_BYTES) fail('云端学习记录超过当前服务器容量，导出已停止。');
  return snapshot;
}
function referencedFiles(state) {
  const ids = new Set([
    ...state.imports.flatMap(lesson => [lesson.originalFile, lesson.referenceFile, lesson.audio?.startsWith('file:') ? lesson.audio.slice(5) : undefined]),
    ...(state.importedWords ?? []).map(word => word.originalFile),
  ].filter(value => value !== undefined && value !== null));
  if ([...ids].some(id => typeof id !== 'string' || !FILE_ID.test(id))) fail('学习记录含有无效附件编号，导出已停止。');
  return ids;
}
function checkedMetadata(value, id, chunkBytes) {
  if (!value || value.id !== id || !FILE_TYPES.has(value.mimeType) || typeof value.name !== 'string' || !value.name || value.name.length > 200 || /[\x00-\x1f\x7f]/.test(value.name) ||
      !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_FILE_BYTES || !Number.isSafeInteger(value.totalChunks) || value.totalChunks !== Math.ceil(value.size / chunkBytes) ||
      typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash)) fail('附件元数据不完整或超过 30 MB，导出已停止。');
  return value;
}

/** fetchImpl is injected in tests. The CLI always uses native HTTPS fetch. */
export async function exportCloudForServer({ sessionFile, outputDir, fetchImpl = globalThis.fetch }) {
  const { origin, cookie } = readCredentials(sessionFile);
  const target = destinationPath(outputDir);
  const schema = await stateValidator();
  let ownedDirectory, store;
  try {
    // Non-recursive and exclusive: never claim or clean a pre-existing directory.
    try { mkdirSync(target, { mode: 0o700 }); ownedDirectory = lstatSync(target); }
    catch (error) { if (error.code === 'EEXIST') fail('输出目录已存在；为保护旧资料，请换一个全新目录。'); throw error; }
    chmodSync(target, 0o700);
    async function request(route, limit, json = false) {
      let response;
      try {
        response = await fetchImpl(new URL(`/api${route}`, origin), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { Origin: origin, Cookie: cookie, Accept: json ? 'application/json' : 'application/octet-stream' } });
      } catch { fail('云端连接中断或发生重定向，导出未完成，请重新尝试。'); }
      if (!response.ok) fail(response.status === 401 ? '配对会话已失效，请重新配对后再导出。' : `云端读取失败（HTTP ${response.status}），导出未完成。`);
      const bytes = await readBytes(response, limit);
      if (!json) return bytes;
      try { return JSON.parse(bytes.toString('utf8')); } catch { fail('云端响应不是完整的数据，导出已停止。'); }
    }
    const session = await request('/session', 16_384, true);
    if (session?.authenticated !== true) fail('配对会话已失效，请重新配对后再导出。');
    const transport = session.fileTransport ?? session.fileTransfer;
    if (transport !== 'chunks' || !Number.isSafeInteger(session.maxChunkBytes) || session.maxChunkBytes <= 0 || session.maxChunkBytes > MAX_CHUNK_BYTES) fail('此工具需要云端分块附件接口，当前站点的传输方式不受支持。');
    const chunkBytes = session.maxChunkBytes;
    const snapshot = checkedSnapshot(await request('/state', MAX_STATE_BYTES + 1024, true), schema);
    const ids = referencedFiles(snapshot.state), attachments = [], at = new Date().toISOString();
    const filesDir = path.join(target, 'files'); mkdirSync(filesDir, { mode: 0o700 });
    for (const id of ids) {
      const meta = checkedMetadata(await request(`/files/${id}/meta`, 16_384, true), id, chunkBytes);
      const parts = []; let size = 0;
      for (let index = 0; index < meta.totalChunks; index++) {
        const expected = Math.min(chunkBytes, meta.size - size);
        const chunk = await request(`/files/${id}/chunks/${index}`, expected);
        if (chunk.length !== expected) fail('附件没有完整下载，导出已停止，请重新尝试。');
        parts.push(chunk); size += chunk.length;
      }
      const bytes = Buffer.concat(parts, size);
      if (size !== meta.size || hash(bytes) !== meta.contentHash) fail('附件内容校验失败，导出已停止，请重新尝试。');
      const filePath = path.join(filesDir, id);
      writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 });
      const saved = readFileSync(filePath);
      if (saved.length !== meta.size || hash(saved) !== meta.contentHash) fail('本地附件写入校验失败，导出未完成。');
      attachments.push(meta);
    }
    const final = checkedSnapshot(await request('/state', MAX_STATE_BYTES + 1024, true), schema);
    if (snapshot.revision !== final.revision || snapshot.updatedAt !== final.updatedAt || !isDeepStrictEqual(snapshot.state, final.state)) fail('导出期间云端学习记录发生了变化；请暂停其他设备的编辑后重新导出。');
    store = openStore(target);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db.prepare('UPDATE state SET payload = ?, revision = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(snapshot.state), snapshot.revision, snapshot.updatedAt);
      const insert = store.db.prepare('INSERT INTO files (id, mime_type, name, size, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const file of attachments) insert.run(file.id, file.mimeType, file.name, file.size, file.contentHash, timestamp(file.createdAt) ? file.createdAt : at);
      store.setMeta('migration_export', JSON.stringify({ exportedAt: at, sourceOrigin: origin, revision: snapshot.revision, files: attachments.length, aiQueueMigrated: false, requiresBootstrap: true }));
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    if (!isDeepStrictEqual(store.getState(), snapshot) || store.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        ['sessions', 'pairing', 'jobs'].some(table => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count !== 0) || store.getMeta('initialized') !== undefined) fail('导出的数据库校验失败，导出未完成。');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close(); store = undefined;
    const result = { verified: true, revision: snapshot.revision, updatedAt: snapshot.updatedAt, files: attachments.length, imports: snapshot.state.imports.length, events: snapshot.state.events.length, aiQueueMigrated: false, requiresBootstrap: true };
    // Written last: this private manifest is the completion marker for transfer.
    const manifest = {
      format: 'study77-server-export', version: 1, completedAt: new Date().toISOString(), ...result,
      database: { file: 'study77.sqlite', sha256: hash(readFileSync(path.join(target, 'study77.sqlite'))) },
      stateHash: hash(Buffer.from(JSON.stringify(snapshot.state))),
      attachments: attachments.map(file => ({ id: file.id, size: file.size, contentHash: file.contentHash })),
    };
    const manifestPath = path.join(target, 'export-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (!isDeepStrictEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest)) fail('导出完成清单校验失败，导出未完成。');
    return result;
  } catch (error) {
    try { store?.close(); } catch {}
    if (ownedDirectory) {
      try {
        const current = lstatSync(target);
        if (current.isDirectory() && current.dev === ownedDirectory.dev && current.ino === ownedDirectory.ino) rmSync(target, { recursive: true, force: true });
      } catch {}
    }
    if (error instanceof ExportError) throw error;
    fail('导出未完成。本次创建的目录已尝试清理，云端与原有本机资料均未修改。');
  }
}

const HELP = `用法：node scripts/export-cloud-for-server.mjs --session-file <凭据.json> --output <全新目录>

示例：node scripts/export-cloud-for-server.mjs --session-file data/cloud-session.json --output data/hk-migration-01

--session-file  Git 忽略目录或仓库外的配对凭据 JSON
--output        全新私有输出目录；父目录必须存在
--output-dir    --output 的兼容别名
--help, -h      显示本说明

CLI 接受相对路径。仅读取 HTTPS 云端，不迁移旧登录凭据或 AI 队列。
成功后以 export-manifest.json 标识完整导出。`;
export function parseExportArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return null;
  const values = {}, names = { '--session-file': 'sessionFile', '--output': 'outputDir', '--output-dir': 'outputDir' };
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(values, key)) fail('用法：--session-file <私有凭据.json> --output <全新私有目录>；可使用 --help 查看说明。');
    values[key] = path.resolve(value);
  }
  if (!values.sessionFile || !values.outputDir) fail('必须同时指定 --session-file 与 --output。');
  return values;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseExportArguments(process.argv.slice(2));
    console.log(options ? JSON.stringify(await exportCloudForServer(options)) : HELP);
  } catch (error) { console.error(error instanceof ExportError ? error.message : '导出未完成，未修改云端资料。'); process.exitCode = 1; }
}
