import express from 'express';
import { z } from 'zod';
import { randomBytes, randomInt, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { CHUNK_BYTES, MAX_FILE_BYTES, MAX_STATE_BYTES, digest, own } from './cloud-store.mjs';

const COOKIE = 'study77_session';
const SESSION_MS = 180 * 24 * 60 * 60 * 1000;
const PAIRING_MS = 10 * 60 * 1000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const fileIdPattern = /^[A-Za-z0-9_-]{8,100}$/;
const fileTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/flac', 'text/plain', 'text/csv', 'application/json', 'text/markdown']);
const record = z.record(z.string(), z.unknown());
const stateSchema = z.object({ state: record, revision: z.number().int().nonnegative() }).strict();
const bootstrapSchema = z.object({ token: z.string().min(32).max(256) }).strict();
const claimSchema = z.object({ code: z.string().min(8).max(32) }).strict();
const fileSchema = z.object({
  mimeType: z.string().refine((value) => fileTypes.has(value)), name: z.string().min(1).max(200),
  size: z.number().int().positive().max(MAX_FILE_BYTES), totalChunks: z.number().int().min(1).max(Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES)),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine((value) => value.totalChunks === Math.ceil(value.size / CHUNK_BYTES));
const attachmentSchema = z.object({
  name: z.string().min(1).max(200), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'text/plain']),
  dataUrl: z.string().max(3_000_000).optional(), text: z.string().max(100_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mimeType === 'text/plain') {
    if (!value.text || value.dataUrl) ctx.addIssue({ code: 'custom', message: 'Invalid text attachment.' });
  } else if (!value.dataUrl?.startsWith(`data:${value.mimeType};base64,`) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataUrl?.split(',')[1] || '')) {
    ctx.addIssue({ code: 'custom', message: 'Invalid image attachment.' });
  }
});
const jobSchema = z.object({
  kind: z.enum(['tutor', 'review', 'extract']), prompt: z.string().trim().min(1).max(20_000),
  context: z.union([z.string().max(100_000), record]).optional(), persona: z.string().max(4000).optional(),
  attachment: attachmentSchema.optional(), dedupeKey: z.string().min(1).max(200).optional(),
}).strict();
const workerStatus = () => ({
  enabled: false, provider: 'codex-local', reason: 'LOCAL_WORKER_NOT_CONNECTED',
  message: 'AI 请求已保留。线上空间尚未连接本机 Codex 工作端；普通练习、学习记录和同步可正常使用。',
});
const publicJob = ({ id, kind, status, result, error, createdAt, updatedAt }) => ({ id, kind, status, result, error, createdAt, updatedAt });
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const errorResult = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const authError = () => Object.assign(new Error('Authentication required.'), { status: 401, code: 'authentication_required' });

export function createCloudApp({ store, bootstrapHash = process.env.STUDY77_BOOTSTRAP_HASH || '', publicOrigin = process.env.STUDY77_PUBLIC_ORIGIN || '', secureCookies = true, now = () => Date.now() } = {}) {
  if (!store) throw new Error('A cloud store is required.');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const tokenOf = (req) => {
    const bearer = req.headers.authorization;
    if (typeof bearer === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(bearer)) return bearer.slice(7);
    const token = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  };
  const authenticated = (req, doc) => { const token = tokenOf(req); return !!token && own(doc.sessions, digest(token))?.expiresAt > now(); };
  const requireAuth = (req, doc) => { if (!authenticated(req, doc)) throw authError(); };
  const send = (res, result) => res.status(result.status || 200).json(result.body);
  const validate = (schema, req) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw Object.assign(new Error('Invalid request.'), { status: 400, code: 'invalid_request' });
    return parsed.data;
  };
  function prune(doc) {
    for (const [key, value] of Object.entries(doc.sessions)) if (value.expiresAt <= now()) delete doc.sessions[key];
    for (const [key, value] of Object.entries(doc.pairing)) if (value.expiresAt <= now() || value.consumedAt) delete doc.pairing[key];
    for (const [key, value] of Object.entries(doc.attempts)) if (value.expiresAt <= now()) delete doc.attempts[key];
  }
  function rate(doc, scope, identity, maximum, duration) {
    prune(doc);
    const key = digest(`${scope}:${identity}`);
    const bucket = own(doc.attempts, key) || { count: 0, expiresAt: now() + duration };
    if (bucket.count >= maximum) return false;
    bucket.count += 1;
    doc.attempts[key] = bucket;
    return bucket.count <= maximum;
  }
  // Vercel's trusted edge supplies this header. Never use arbitrary x-forwarded-for
  // as an authorization signal. The global fallback still bounds guessing.
  const clientKey = (req) => process.env.VERCEL ? (req.headers['x-vercel-forwarded-for'] || 'shared') : (req.socket.remoteAddress || 'shared');
  function createSession(doc, token) { prune(doc); doc.sessions[digest(token)] = { createdAt: now(), expiresAt: now() + SESSION_MS }; }
  function setCookie(res, token) { res.cookie(COOKIE, token, { httpOnly: true, secure: secureCookies, sameSite: 'strict', maxAge: SESSION_MS, path: '/' }); }
  const authorize = async (req, _res, next) => { const { document } = await store.read(); requireAuth(req, document); req.cloudDocument = document; next(); };
  const mutation = (req, mutate) => store.update((doc) => { requireAuth(req, doc); return mutate(doc); });
  const validFileId = (id) => { if (!fileIdPattern.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw Object.assign(new Error('Invalid file id.'), { status: 400, code: 'invalid_file_id' }); };
  const fileMetadata = (req) => { validFileId(req.params.id); const file = own(req.cloudDocument.files, req.params.id); if (!file) throw Object.assign(new Error('File not found.'), { status: 404, code: 'file_not_found' }); return file; };

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'private, no-store' });
    const expectedOrigin = publicOrigin || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `${req.protocol}://${req.headers.host}`);
    if ((req.headers.origin && req.headers.origin !== expectedOrigin) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'origin_forbidden', message: '请从学习空间本身访问。' });
    const rawFile = /^\/api\/files\/[A-Za-z0-9_-]{8,100}(?:\/chunks\/\d+)?$/.test(req.path);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !rawFile && !req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    next();
  });
  // Binary routes must precede JSON parsing so JSON/CSV imports remain raw bytes.
  app.post('/api/files/:id/chunks/:index', authorize, express.raw({ type: () => true, limit: CHUNK_BYTES }), async (req, res) => {
    validFileId(req.params.id);
    const index = Number(req.params.index);
    if (!/^(?:\d|10)$/.test(req.params.index) || index >= Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES)) return res.status(400).json({ error: 'invalid_chunk' });
    const mimeType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!fileTypes.has(mimeType)) return res.status(415).json({ error: 'unsupported_file_type' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty_file' });
    const existing = own(req.cloudDocument.files, req.params.id);
    if (existing && (index >= existing.totalChunks || mimeType !== existing.mimeType)) return res.status(409).json({ error: 'file_id_conflict' });
    await store.putChunk(req.params.id, index, req.body, mimeType);
    res.status(201).json({ id: req.params.id, index, size: req.body.length, contentHash: digest(req.body) });
  });
  app.post('/api/files/:id', authorize, express.raw({ type: () => true, limit: CHUNK_BYTES }), async (req, res) => {
    validFileId(req.params.id);
    const mimeType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!fileTypes.has(mimeType)) return res.status(415).json({ error: 'unsupported_file_type' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty_file' });
    let name = req.headers['x-filename'] || req.params.id;
    try { name = decodeURIComponent(name); } catch { name = req.params.id; }
    name = name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || req.params.id;
    const manifest = { id: req.params.id, mimeType, name, size: req.body.length, totalChunks: 1, contentHash: digest(req.body) };
    await store.putChunk(req.params.id, 0, req.body, mimeType);
    await mutation(req, (doc) => { const old = own(doc.files, manifest.id); if (old && (old.contentHash !== manifest.contentHash || old.mimeType !== mimeType)) throw Object.assign(new Error('File conflict.'), { status: 409, code: 'file_id_conflict' }); doc.files[manifest.id] = old || manifest; });
    res.status(201).json(manifest);
  });
  app.use(express.json({ limit: '4mb', strict: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: '77-study-space', version: 1, storage: 'private-blob' }));
  app.get('/api/session', async (req, res) => {
    const { document } = await store.read();
    res.json({ authenticated: authenticated(req, document), needsBootstrap: !document.initialized, localBootstrapAvailable: false, fileTransport: 'chunks', maxChunkBytes: CHUNK_BYTES, maxStateBytes: MAX_STATE_BYTES });
  });
  app.post('/api/bootstrap', async (req, res) => {
    const body = validate(bootstrapSchema, req), token = randomBytes(32).toString('base64url');
    if ((await store.read()).document.initialized) return res.status(401).json({ error: 'invalid_bootstrap_token' });
    const result = await store.update((doc) => {
      if (doc.initialized) return errorResult(401, 'invalid_bootstrap_token');
      if (!rate(doc, 'bootstrap', clientKey(req), 10, PAIRING_MS)) return errorResult(429, 'rate_limited');
      if (doc.initialized || !/^[a-f0-9]{64}$/.test(bootstrapHash) || !timingSafeEqual(Buffer.from(digest(body.token), 'hex'), Buffer.from(bootstrapHash, 'hex'))) return errorResult(401, 'invalid_bootstrap_token');
      doc.initialized = true; createSession(doc, token); return { body: { ok: true } };
    });
    if (!result.status) setCookie(res, token);
    send(res, result);
  });
  app.post('/api/logout', authorize, async (req, res) => {
    await mutation(req, (doc) => { delete doc.sessions[digest(tokenOf(req))]; });
    res.clearCookie(COOKIE, { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/state', authorize, (req, res) => res.json(req.cloudDocument.snapshot));
  app.put('/api/state', authorize, async (req, res) => {
    const body = validate(stateSchema, req);
    if (Buffer.byteLength(JSON.stringify(body.state)) > MAX_STATE_BYTES) return res.status(413).json({ error: 'state_too_large', message: '学习资料超过当前同步容量；本机记录仍然保留，请先导出备份。' });
    send(res, await mutation(req, (doc) => {
      if (body.revision !== doc.snapshot.revision) return { status: 409, body: { error: 'revision_conflict', ...doc.snapshot } };
      doc.snapshot = { state: body.state, revision: body.revision + 1, updatedAt: new Date(now()).toISOString() };
      return { body: doc.snapshot };
    }));
  });
  app.post('/api/pairing', authorize, async (req, res) => {
    const rawCode = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
    send(res, await mutation(req, (doc) => {
      if (!rate(doc, 'pairing-create', digest(tokenOf(req)), 10, PAIRING_MS)) return errorResult(429, 'rate_limited');
      const expiresAt = now() + PAIRING_MS;
      doc.pairing[digest(rawCode)] = { expiresAt, createdAt: now(), consumedAt: null };
      return { status: 201, body: { code: `${rawCode.slice(0, 5)}-${rawCode.slice(5)}`, expiresAt: new Date(expiresAt).toISOString() } };
    }));
  });
  app.post('/api/pairing/claim', async (req, res) => {
    const body = validate(claimSchema, req), code = body.code.replace(/[\s-]/g, '').toUpperCase(), token = randomBytes(32).toString('base64url');
    const result = await store.update((doc) => {
      if (!rate(doc, 'pairing-claim', clientKey(req), 10, PAIRING_MS)) return errorResult(429, 'rate_limited');
      const pairing = /^[A-Z2-9]{10}$/.test(code) ? own(doc.pairing, digest(code)) : null;
      if (!pairing || pairing.expiresAt <= now() || pairing.consumedAt) return errorResult(401, 'invalid_pairing_code', '配对码无效、已过期或已使用。');
      pairing.consumedAt = now(); createSession(doc, token); return { body: { ok: true } };
    });
    if (!result.status) setCookie(res, token);
    send(res, result);
  });
  app.post('/api/files/:id/complete', authorize, async (req, res) => {
    validFileId(req.params.id);
    const body = validate(fileSchema, req), old = own(req.cloudDocument.files, req.params.id);
    if (old) return send(res, old.contentHash === body.contentHash && old.mimeType === body.mimeType && old.size === body.size ? { body: old } : errorResult(409, 'file_id_conflict'));
    const hash = createHash('sha256');
    let size = 0;
    for (let index = 0; index < body.totalChunks; index += 1) {
      const chunk = await store.getChunk(req.params.id, index);
      const expected = index === body.totalChunks - 1 ? body.size - CHUNK_BYTES * index : CHUNK_BYTES;
      if (!chunk || chunk.mimeType !== body.mimeType || chunk.bytes.length !== expected) return res.status(400).json({ error: 'incomplete_upload' });
      hash.update(chunk.bytes); size += chunk.bytes.length;
    }
    if (size !== body.size || hash.digest('hex') !== body.contentHash) return res.status(400).json({ error: 'file_hash_mismatch' });
    const manifest = { id: req.params.id, ...body, name: body.name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || req.params.id };
    await mutation(req, (doc) => { const existing = own(doc.files, manifest.id); if (existing && (existing.contentHash !== manifest.contentHash || existing.mimeType !== manifest.mimeType)) throw Object.assign(new Error('File conflict.'), { status: 409, code: 'file_id_conflict' }); doc.files[manifest.id] = existing || manifest; });
    res.status(201).json(manifest);
  });
  app.get('/api/files/:id/meta', authorize, (req, res) => res.json(fileMetadata(req)));
  app.get('/api/files/:id/chunks/:index', authorize, async (req, res) => {
    const file = fileMetadata(req), index = Number(req.params.index);
    if (!/^(?:\d|10)$/.test(req.params.index) || index >= file.totalChunks) return res.status(404).json({ error: 'file_not_found' });
    const chunk = await store.getChunk(file.id, index);
    if (!chunk) return res.status(404).json({ error: 'file_unavailable' });
    res.set({ 'Content-Type': file.mimeType, 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(chunk.bytes);
  });
  app.get('/api/files/:id', authorize, async (req, res) => {
    const file = fileMetadata(req);
    if (file.totalChunks > 1) return res.status(413).json({ error: 'use_chunk_download' });
    const chunk = await store.getChunk(file.id, 0);
    if (!chunk) return res.status(404).json({ error: 'file_unavailable' });
    res.set({ 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(chunk.bytes);
  });
  app.get('/api/ai/status', authorize, (_req, res) => res.json(workerStatus()));
  app.post('/api/ai/jobs', authorize, async (req, res) => {
    const body = validate(jobSchema, req);
    if (body.context && Buffer.byteLength(JSON.stringify(body.context)) > 150_000) return res.status(413).json({ error: 'context_too_large' });
    if (body.kind === 'review' && (!body.context || (typeof body.context === 'object' && Object.keys(body.context).length === 0))) return res.status(400).json({ error: 'review_context_required' });
    const { dedupeKey: clientKey, ...input } = body;
    const dedupeKey = body.kind === 'review' ? `review:${digest(canonical(body.context))}` : clientKey ? `${body.kind}:client:${digest(clientKey)}` : `${body.kind}:content:${digest(canonical(input))}`;
    const id = randomUUID();
    send(res, await mutation(req, (doc) => {
      const jobs = Object.values(doc.jobs), existing = jobs.find((job) => job.dedupeKey === dedupeKey);
      if (existing) return { body: { job: publicJob(existing), duplicate: true, worker: workerStatus() } };
      if (jobs.filter((job) => ['queued', 'running', 'unavailable'].includes(job.status)).length >= 200) return errorResult(429, 'queue_full');
      const timestamp = new Date(now()).toISOString();
      const job = { id, kind: body.kind, status: 'unavailable', input, result: null, error: { code: 'WORKER_UNAVAILABLE', message: workerStatus().message }, dedupeKey, createdAt: timestamp, updatedAt: timestamp };
      if (Buffer.byteLength(JSON.stringify(doc.jobs)) + Buffer.byteLength(JSON.stringify(job)) > 6_000_000) return errorResult(429, 'queue_full', 'AI 待处理资料较多，请先等待工作端连接；学习记录仍正常保存。');
      doc.jobs[id] = job;
      return { status: 202, body: { job: publicJob(job), duplicate: false, worker: workerStatus() } };
    }));
  });
  app.get('/api/ai/jobs/:id', authorize, (req, res) => {
    const job = own(req.cloudDocument.jobs, req.params.id);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    res.json({ job: publicJob(job), worker: workerStatus() });
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'invalid_json' });
    if (error?.status && error?.code) return res.status(error.status).json({ error: error.code });
    res.status(503).json({ error: 'storage_unavailable', message: '云端暂时无法同步，本机学习记录仍然保留，请稍后重试。' });
  });
  return app;
}
