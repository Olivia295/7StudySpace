import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fileId = /^[A-Za-z0-9_-]{8,100}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });
const isWithin = (directory, target) => {
  const relative = path.relative(directory, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

async function regularFile(filePath, code) {
  let info;
  try { info = await lstat(filePath); } catch { throw fail(code, '缺少备份所需的原始文件。'); }
  if (!info.isFile() || info.isSymbolicLink()) throw fail(code, '原始文件必须是普通文件，不能使用符号链接。');
  return info;
}

async function copyVerifiedAttachment(sourcePath, targetPath, expected) {
  const info = await regularFile(sourcePath, 'ATTACHMENT_MISSING');
  if (info.size !== expected.size) throw fail('ATTACHMENT_SIZE_MISMATCH', '原始附件大小与数据库记录不一致，备份已取消。');
  const input = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw fail('ATTACHMENT_CHANGED', '原始附件在备份时发生变化，请重试。');
    output = await open(targetPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > expected.size) throw fail('ATTACHMENT_SIZE_MISMATCH', '原始附件大小与数据库记录不一致，备份已取消。');
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    if (bytes !== expected.size || hash.digest('hex') !== expected.content_hash) throw fail('ATTACHMENT_HASH_MISMATCH', '原始附件校验不通过，备份已取消。');
    await output.sync();
  } finally {
    await output?.close();
    await input.close();
  }
}

async function fileHash(filePath) {
  const input = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await input.close(); }
}

function verifyStateReferences(payload, attachments) {
  let state;
  try { state = JSON.parse(payload); } catch { throw fail('DATABASE_INVALID', '学习记录格式不正确，备份已取消。'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw fail('DATABASE_INVALID', '学习记录格式不正确，备份已取消。');
  const available = new Set(attachments.map((entry) => entry.id));
  const check = (id) => {
    if (id === undefined) return;
    if (typeof id !== 'string' || !fileId.test(id) || !available.has(id)) throw fail('ATTACHMENT_REFERENCE_MISSING', '学习记录中的附件尚未完整上传，请同步完成后重试备份。');
  };
  for (const key of ['imports', 'importedWords']) {
    if (state[key] === undefined) continue;
    if (!Array.isArray(state[key])) throw fail('DATABASE_INVALID', '学习记录格式不正确，备份已取消。');
    for (const item of state[key]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('DATABASE_INVALID', '学习记录格式不正确，备份已取消。');
      check(item.originalFile);
      if (key === 'imports') {
        check(item.referenceFile);
        if (item.audio !== undefined && typeof item.audio !== 'string') throw fail('DATABASE_INVALID', '学习记录格式不正确，备份已取消。');
        if (item.audio?.startsWith('file:')) check(item.audio.slice(5));
      }
    }
  }
}

/** Create a private, self-contained snapshot; never copy a live SQLite file.
 * VACUUM INTO reads the WAL and produces a consistent independent database.
 * Only attachment rows from that completed snapshot determine which files copy.
 * A manifest is written last: directories without it are incomplete backups.
 */
export async function backupServer({ dataDir, output } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof output !== 'string' || !output) throw fail('ARGUMENTS_REQUIRED', '请同时指定 --data-dir 和 --output。');
  let source;
  try { source = await realpath(path.resolve(dataDir)); } catch { throw fail('SOURCE_MISSING', '源数据目录不存在。'); }
  if (!(await stat(source)).isDirectory()) throw fail('SOURCE_MISSING', '源数据目录不存在。');
  const sourceDatabase = path.join(source, 'study77.sqlite');
  await regularFile(sourceDatabase, 'DATABASE_MISSING');

  const requestedOutput = path.resolve(output);
  let parent;
  try { parent = await realpath(path.dirname(requestedOutput)); } catch { throw fail('OUTPUT_PARENT_MISSING', '备份父目录必须事先存在。'); }
  const destination = path.join(parent, path.basename(requestedOutput));
  if (isWithin(source, destination)) throw fail('OUTPUT_INSIDE_SOURCE', '备份目录不能位于源数据目录内。');
  try { await lstat(destination); throw fail('OUTPUT_EXISTS', '备份目标已存在，请使用一个新的目录。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

  let created = false, sourceDb, snapshotDb;
  try {
    // No recursive mkdir: the final directory is our exclusive reservation.
    await mkdir(destination, { mode: 0o700 });
    created = true;
    await chmod(destination, 0o700);
    const targetDatabase = path.join(destination, 'study77.sqlite');
    const reservedDatabase = await open(targetDatabase, 'wx', 0o600);
    await reservedDatabase.close();
    sourceDb = new DatabaseSync(sourceDatabase, { readOnly: true });
    sourceDb.exec('PRAGMA busy_timeout = 5000');
    sourceDb.prepare('VACUUM INTO ?').run(targetDatabase);
    sourceDb.close(); sourceDb = null;
    await chmod(targetDatabase, 0o600);

    snapshotDb = new DatabaseSync(targetDatabase, { readOnly: true });
    if (snapshotDb.prepare('PRAGMA quick_check').all().some((row) => Object.values(row)[0] !== 'ok')) throw fail('DATABASE_INVALID', '备份数据库完整性校验未通过。');
    const attachments = snapshotDb.prepare('SELECT id, size, content_hash FROM files ORDER BY id').all();
    const snapshotState = snapshotDb.prepare('SELECT payload, revision FROM state WHERE id = 1').get();
    const revision = snapshotState?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw fail('DATABASE_INVALID', '源数据库不是可识别的学习空间数据。');
    snapshotDb.close(); snapshotDb = null;

    for (const entry of attachments) {
      if (!fileId.test(entry.id) || ['__proto__', 'constructor', 'prototype'].includes(entry.id) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.content_hash)) throw fail('ATTACHMENT_METADATA_INVALID', '附件记录格式不正确，备份已取消。');
    }
    // Sync saves state before uploading its attachments. A valid SQLite snapshot
    // can therefore be an incomplete study-space backup; reject that window.
    verifyStateReferences(snapshotState.payload, attachments);
    const sourceFiles = path.join(source, 'files');
    if (attachments.length) {
      let info;
      try { info = await lstat(sourceFiles); } catch { throw fail('ATTACHMENT_MISSING', '缺少原始附件目录。'); }
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail('ATTACHMENT_PATH_UNSAFE', '原始附件目录不能使用符号链接。');
    }
    const targetFiles = path.join(destination, 'files');
    await mkdir(targetFiles, { mode: 0o700 });
    await chmod(targetFiles, 0o700);
    let totalFileBytes = 0;
    for (const entry of attachments) {
      await copyVerifiedAttachment(path.join(sourceFiles, entry.id), path.join(targetFiles, entry.id), entry);
      totalFileBytes += entry.size;
    }
    const databaseHandle = await open(targetDatabase, 'r');
    await databaseHandle.sync();
    await databaseHandle.close();
    const manifest = {
      format: 'study77-server-backup', version: 1, createdAt: new Date().toISOString(),
      revision, fileCount: attachments.length, totalFileBytes,
      databaseBytes: (await stat(targetDatabase)).size, databaseSha256: await fileHash(targetDatabase),
      containsPrivateSessions: true,
    };
    const manifestFile = await open(path.join(destination, 'backup-manifest.json'), 'wx', 0o600);
    try { await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await manifestFile.sync(); } finally { await manifestFile.close(); }
    return { revision, fileCount: manifest.fileCount, totalFileBytes, databaseBytes: manifest.databaseBytes };
  } catch (error) {
    snapshotDb?.close(); snapshotDb = null;
    sourceDb?.close(); sourceDb = null;
    if (created) await rm(destination, { recursive: true, force: true });
    if (error.code === 'EEXIST') throw fail('OUTPUT_EXISTS', '备份目标已存在，请使用一个新的目录。');
    throw error;
  } finally {
    snapshotDb?.close(); sourceDb?.close();
  }
}

function argumentsFrom(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null;
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--data-dir': 'dataDir', '--output': 'output' }[argv[i]];
    if (!key || result[key] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw fail('INVALID_ARGUMENTS', '用法：node scripts/backup-server.mjs --data-dir /源数据目录 --output /已有父目录/新备份目录');
    result[key] = argv[i + 1];
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = argumentsFrom(process.argv.slice(2));
    if (!args) console.log('用法：node scripts/backup-server.mjs --data-dir /源数据目录 --output /已有父目录/新备份目录\n备份包含私人资料及设备会话，目录不可公开；仅复制数据库快照和其引用附件。');
    else console.log(JSON.stringify({ ok: true, ...await backupServer(args) }));
  } catch (error) {
    const known = ['ARGUMENTS_REQUIRED', 'INVALID_ARGUMENTS', 'SOURCE_MISSING', 'DATABASE_MISSING', 'OUTPUT_PARENT_MISSING', 'OUTPUT_INSIDE_SOURCE', 'OUTPUT_EXISTS', 'DATABASE_INVALID', 'ATTACHMENT_METADATA_INVALID', 'ATTACHMENT_REFERENCE_MISSING', 'ATTACHMENT_MISSING', 'ATTACHMENT_PATH_UNSAFE', 'ATTACHMENT_SIZE_MISMATCH', 'ATTACHMENT_HASH_MISMATCH', 'ATTACHMENT_CHANGED'];
    console.error(JSON.stringify({ ok: false, error: known.includes(error.code) ? error.code : 'BACKUP_FAILED', message: known.includes(error.code) ? error.message : '备份未完成，请检查源数据、访问权限和磁盘空间；不会覆盖现有备份。' }));
    process.exitCode = 1;
  }
}
