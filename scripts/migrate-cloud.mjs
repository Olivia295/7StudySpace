#!/usr/bin/env node
// Explicit owner-only migration. Private contents and credentials never enter the build.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { openStore } from '../server/store.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const origin = new URL(args.url);
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Provide the HTTPS application origin only.');
const dataDir = path.resolve(args.dataDir || 'data');
const credentialsPath = path.join(dataDir, 'cloud-session.json');
let credentials;
try { credentials = JSON.parse(readFileSync(credentialsPath, 'utf8')); } catch {}
if (credentials && credentials.origin !== origin.origin) throw Error('Saved cloud credentials belong to a different origin.');
async function request(route, options = {}) {
  const response = await fetch(new URL(`/api${route}`, origin), {
    ...options, redirect: 'error', headers: { Origin: origin.origin, ...(credentials ? { Cookie: credentials.cookie } : {}), ...options.headers },
  });
  if (!response.ok) {
    const message = await response.json().catch(() => ({}));
    throw Object.assign(Error(`${route}: HTTP ${response.status} (${message.error || 'request_failed'})`), { status: response.status });
  }
  return response;
}
if (!credentials) {
  const token = readFileSync(path.join(dataDir, 'cloud-bootstrap'), 'utf8').trim();
  const response = await request('/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie?.startsWith('study77_session=')) throw Error('Cloud initialization did not return a session.');
  credentials = { origin: origin.origin, cookie };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
}
const store = openStore(dataDir);
const snapshot = store.getState();
const rows = store.db.prepare('SELECT id, mime_type, name, size, content_hash FROM files').all();
store.close();
const state = snapshot.state;
if (state.version !== 1 || !Array.isArray(state.imports)) throw Error('Local state format is unsupported.');
const remote = await (await request('/state')).json();
if (Object.keys(remote.state).length && JSON.stringify(remote.state) !== JSON.stringify(state)) throw Error('Cloud already contains different records. Stopped without overwriting.');
const referenced = new Set([
  ...state.imports.flatMap(lesson => [lesson.originalFile, lesson.referenceFile, lesson.audio?.startsWith('file:') ? lesson.audio.slice(5) : undefined]),
  ...(state.importedWords || []).map(word => word.originalFile),
].filter(Boolean));
let files = 0;
for (const id of referenced) {
  const row = rows.find(file => file.id === id);
  if (!row || !/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw Error('A referenced local attachment is missing.');
  const bytes = readFileSync(path.join(dataDir, 'files', id));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== row.content_hash || bytes.length !== row.size) throw Error('Local attachment failed integrity validation.');
  let existing;
  try { existing = await (await request(`/files/${id}/meta`)).json(); }
  catch (error) { if (error.status !== 404) throw error; }
  if (existing) {
    if (existing.contentHash !== hash || existing.size !== bytes.length || existing.mimeType !== row.mime_type) throw Error('Cloud attachment conflicts with the local copy.');
    files++;
    console.log(`Verified private attachment ${files}/${referenced.size}`);
    continue;
  }
  const chunkSize = 3_000_000, totalChunks = Math.ceil(bytes.length / chunkSize);
  for (let index = 0; index < totalChunks; index++) {
    await request(`/files/${id}/chunks/${index}`, { method: 'POST', headers: { 'Content-Type': row.mime_type }, body: bytes.subarray(index * chunkSize, (index + 1) * chunkSize) });
  }
  await request(`/files/${id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mimeType: row.mime_type, name: row.name, size: bytes.length, totalChunks, contentHash: hash }) });
  files++;
  console.log(`Verified private attachment ${files}/${referenced.size}`);
}
if (!Object.keys(remote.state).length) await request('/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, revision: remote.revision }) });
const verified = await (await request('/state')).json();
if (JSON.stringify(verified.state) !== JSON.stringify(state)) throw Error('Migrated state verification failed.');
console.log(JSON.stringify({ verified: true, imports: state.imports.length, questions: state.imports.reduce((sum, lesson) => sum + (lesson.questions?.length || 0), 0), events: state.events?.length || 0, files }));
