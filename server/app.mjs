import express from 'express';
import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { openStore, hashToken, newToken, equalHash, jobFromRow } from './store.mjs';
import { createWorker } from './worker.mjs';

const COOKIE = 'study77_session';
const SESSION_MS = 180 * 24 * 60 * 60 * 1000;
const PAIRING_MS = 10 * 60 * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const pairingAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const fileIdPattern = /^[A-Za-z0-9_-]{8,100}$/;
const rawFilePathPattern = /^\/files\/[A-Za-z0-9_-]{8,100}$/;
const fileMimeTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/flac', 'text/plain', 'text/csv', 'application/json', 'text/markdown']);
const jsonRecord = z.record(z.string(), z.unknown());
const stateSchema = z.object({ state: jsonRecord, revision: z.number().int().min(0) }).strict();
const claimSchema = z.object({ code: z.string().min(8).max(32) }).strict();
const bootstrapSchema = z.object({ token: z.string().min(32).max(256) }).strict();
const attachmentSchema = z.object({
  name: z.string().min(1).max(200),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'text/plain']),
  dataUrl: z.string().max(6_000_000).optional(),
  text: z.string().max(100_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mimeType === 'text/plain') {
    if (!value.text || value.dataUrl) ctx.addIssue({ code: 'custom', message: '文本附件必须包含 text。' });
  } else if (!value.dataUrl || !value.dataUrl.startsWith(`data:${value.mimeType};base64,`) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataUrl.split(',')[1] || '')) {
    ctx.addIssue({ code: 'custom', message: '图片附件必须是匹配类型的 base64 data URL。' });
  }
});
const jobSchema = z.object({
  kind: z.enum(['tutor', 'review', 'extract']),
  prompt: z.string().trim().min(1).max(20_000),
  context: z.union([z.string().max(100_000), jsonRecord]).optional(),
  persona: z.string().max(4000).optional(),
  attachment: attachmentSchema.optional(),
  dedupeKey: z.string().min(1).max(200).optional(),
}).strict();

function cookieValue(req) {
  const value = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function bearerValue(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(value) ? value.slice(7) : null;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function createApp({
  dataDir = path.resolve('data'),
  distDir = path.resolve('dist'),
  allowLocalBootstrap = process.env.NODE_ENV !== 'production',
  secureCookies = process.env.NODE_ENV === 'production',
  publicOrigin = process.env.STUDY77_PUBLIC_ORIGIN || '',
  now = () => Date.now(),
  runJob,
  disabledReason,
} = {}) {
  const store = openStore(dataDir);
  const worker = createWorker(store, { runJob, disabledReason, now });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Same-origin requests only. Public reverse proxies must set the fixed origin.
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    const sameOrigin = publicOrigin || `${req.protocol}://${req.headers.host}`;
    if (origin && origin !== sameOrigin) return res.status(403).json({ error: 'origin_forbidden', message: '请从学习空间本身访问。' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'origin_forbidden' });
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !rawFilePathPattern.test(req.path) && !req.is('application/json')) {
      return res.status(415).json({ error: 'json_required' });
    }
    next();
  });
  const parseJson = express.json({ limit: '16mb', strict: true });
  app.use('/api', (req, res, next) => {
    // Imported JSON is an attachment: preserve its original bytes and let the
    // authenticated file route apply its own size limit and raw body parser.
    if (req.method === 'POST' && rawFilePathPattern.test(req.path)) return next();
    return parseJson(req, res, next);
  });

  // In-memory limits are sufficient for one local process; tokens are still
  // cryptographically random and one-time checks are persisted in SQLite.
  const attempts = new Map();
  const limit = (scope, maximum, windowMs) => (req, res, next) => {
    const key = `${scope}:${req.socket.remoteAddress || 'unknown'}`;
    const time = now();
    let bucket = attempts.get(key);
    if (!bucket || bucket.expiresAt <= time) bucket = { count: 0, expiresAt: time + windowMs };
    bucket.count += 1;
    attempts.set(key, bucket);
    if (attempts.size > 1000) for (const [entry, value] of attempts) if (value.expiresAt <= time) attempts.delete(entry);
    if (bucket.count > maximum) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.expiresAt - time) / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: '尝试次数较多，请稍后再试。' });
    }
    next();
  };
  function setSession(res) {
    const token = newToken();
    store.db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(hashToken(token), now(), now() + SESSION_MS);
    res.cookie(COOKIE, token, { httpOnly: true, secure: secureCookies, sameSite: 'strict', maxAge: SESSION_MS, path: '/' });
  }
  function authenticated(req) {
    const token = bearerValue(req) || cookieValue(req);
    if (!token) return false;
    const session = store.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
    return !!session && session.expires_at > now();
  }
  function authorize(req, res, next) {
    if (!authenticated(req)) return res.status(401).json({ error: 'authentication_required', message: '请使用已登录设备生成的配对码连接。' });
    next();
  }
  function validate(schema, req, res) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: 'invalid_request', message: '请求格式不正确。', fields: result.error.issues.map((issue) => issue.path.join('.')).slice(0, 8) });
      return null;
    }
    return result.data;
  }
  function localBootstrapAllowed(req) {
    return allowLocalBootstrap && LOOPBACK.has(req.socket.remoteAddress) && LOCAL_HOSTS.has(req.hostname)
      && !req.headers.forwarded && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: '77-study-space', version: 1 }));
  app.get('/api/session', (req, res) => {
    let auth = authenticated(req);
    let needsBootstrap = store.getMeta('initialized') !== '1';
    const localBootstrapAvailable = localBootstrapAllowed(req);
    if (!auth && needsBootstrap && localBootstrapAvailable) {
      store.setMeta('initialized', '1');
      store.db.prepare("DELETE FROM metadata WHERE key = 'bootstrap_hash'").run();
      setSession(res);
      auth = true;
      needsBootstrap = false;
    }
    res.json({ authenticated: auth, needsBootstrap, localBootstrapAvailable });
  });
  app.post('/api/bootstrap', limit('bootstrap', 10, PAIRING_MS), (req, res) => {
    const body = validate(bootstrapSchema, req, res);
    if (!body) return;
    if (store.getMeta('initialized') === '1' || !equalHash(body.token, store.getMeta('bootstrap_hash'))) return res.status(401).json({ error: 'invalid_bootstrap_token' });
    store.setMeta('initialized', '1');
    store.db.prepare("DELETE FROM metadata WHERE key = 'bootstrap_hash'").run();
    setSession(res);
    res.json({ ok: true });
  });
  app.post('/api/logout', authorize, (req, res) => {
    const token = bearerValue(req) || cookieValue(req);
    store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    res.clearCookie(COOKIE, { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/state', authorize, (_req, res) => res.json(store.getState()));
  app.put('/api/state', authorize, limit('state', 180, 60_000), (req, res) => {
    const body = validate(stateSchema, req, res);
    if (!body) return;
    if (Buffer.byteLength(JSON.stringify(body.state)) > 12_000_000) return res.status(413).json({ error: 'state_too_large' });
    const result = store.writeState(body.state, body.revision, new Date(now()).toISOString());
    const { changed, ...snapshot } = result;
    return res.status(changed ? 200 : 409).json(changed ? snapshot : { error: 'revision_conflict', ...snapshot });
  });
  app.post('/api/pairing', authorize, limit('pairing-create', 10, PAIRING_MS), (_req, res) => {
    const rawCode = Array.from({ length: 10 }, () => pairingAlphabet[randomInt(pairingAlphabet.length)]).join('');
    const code = `${rawCode.slice(0, 5)}-${rawCode.slice(5)}`;
    const expiresAt = now() + PAIRING_MS;
    store.db.prepare('DELETE FROM pairing WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(now());
    store.db.prepare('INSERT INTO pairing (code_hash, expires_at, created_at) VALUES (?, ?, ?)').run(hashToken(rawCode), expiresAt, now());
    res.status(201).json({ code, expiresAt: new Date(expiresAt).toISOString() });
  });
  app.post('/api/pairing/claim', limit('pairing-claim', 10, PAIRING_MS), (req, res) => {
    const body = validate(claimSchema, req, res);
    if (!body) return;
    const code = body.code.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z2-9]{10}$/.test(code)) return res.status(401).json({ error: 'invalid_pairing_code', message: '配对码无效、已过期或已使用。' });
    const claimed = store.db.prepare('UPDATE pairing SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?').run(now(), hashToken(code), now());
    if (claimed.changes !== 1) return res.status(401).json({ error: 'invalid_pairing_code', message: '配对码无效、已过期或已使用。' });
    setSession(res);
    res.json({ ok: true });
  });
  app.post('/api/files/:id', authorize, limit('file-upload', 30, 60_000), (req, res, next) => {
    const mimeType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!fileIdPattern.test(req.params.id)) return res.status(400).json({ error: 'invalid_file_id' });
    if (!fileMimeTypes.has(mimeType)) return res.status(415).json({ error: 'unsupported_file_type' });
    next();
  }, express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty_file' });
    const id = req.params.id;
    const mimeType = req.headers['content-type'].split(';')[0].trim().toLowerCase();
    let name = req.headers['x-filename'] || id;
    try { name = decodeURIComponent(name); } catch { name = id; }
    name = path.basename(name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || id;
    const contentHash = hashToken(req.body);
    const existing = store.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (existing) {
      if (existing.content_hash !== contentHash || existing.mime_type !== mimeType) return res.status(409).json({ error: 'file_id_conflict' });
      return res.json({ id, mimeType: existing.mime_type, name: existing.name, size: existing.size });
    }
    const fileDir = path.join(dataDir, 'files');
    mkdirSync(fileDir, { recursive: true, mode: 0o700 });
    const target = path.join(fileDir, id);
    try {
      writeFileSync(target, req.body, { flag: 'wx', mode: 0o600 });
      store.db.prepare('INSERT INTO files (id, mime_type, name, size, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, mimeType, name, req.body.length, contentHash, new Date(now()).toISOString());
    } catch (error) {
      if (error.code !== 'EEXIST') { try { unlinkSync(target); } catch {} }
      throw error;
    }
    res.status(201).json({ id, mimeType, name, size: req.body.length });
  });
  app.get('/api/files/:id', authorize, (req, res) => {
    if (!fileIdPattern.test(req.params.id)) return res.status(404).json({ error: 'file_not_found' });
    const file = store.db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'file_not_found' });
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `${file.mime_type === 'application/pdf' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.sendFile(path.resolve(dataDir, 'files', file.id), { dotfiles: 'deny', acceptRanges: true, cacheControl: false }, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 500).json({ error: 'file_unavailable' });
    });
  });
  app.get('/api/ai/status', authorize, (_req, res) => res.json(worker.status()));
  app.post('/api/ai/jobs', authorize, limit('ai-create', 30, 60_000), (req, res) => {
    const body = validate(jobSchema, req, res);
    if (!body) return;
    if (body.context && Buffer.byteLength(JSON.stringify(body.context)) > 150_000) return res.status(413).json({ error: 'context_too_large' });
    // A review of identical learning data is generated only once even if the
    // UI retries or the wording/persona changes. A new data snapshot is needed.
    if (body.kind === 'review' && (!body.context || (typeof body.context === 'object' && Object.keys(body.context).length === 0))) {
      return res.status(400).json({ error: 'review_context_required' });
    }
    const { dedupeKey: clientKey, ...input } = body;
    const dedupeKey = body.kind === 'review'
      ? `review:${hashToken(canonical(body.context))}`
      : clientKey ? `${body.kind}:client:${hashToken(clientKey)}` : `${body.kind}:content:${hashToken(canonical(input))}`;
    const pendingCount = store.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running', 'unavailable')").get().count;
    if (pendingCount >= 200 && !store.db.prepare('SELECT id FROM jobs WHERE dedupe_key = ?').get(dedupeKey)) {
      return res.status(429).json({ error: 'queue_full', message: '待处理任务已达上限，请先完成已有任务。' });
    }
    const result = worker.enqueue(input, dedupeKey);
    res.status(result.duplicate ? 200 : 202).json({ ...result, worker: worker.status() });
  });
  app.get('/api/ai/jobs/:id', authorize, (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'job_not_found' });
    const job = jobFromRow(store.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    res.json({ job, worker: worker.status() });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  if (existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: 'index.html', dotfiles: 'deny' }));
    app.use((req, res, next) => req.method === 'GET' && req.accepts('html') ? res.sendFile(path.join(distDir, 'index.html')) : next());
  }
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'invalid_json' });
    res.status(500).json({ error: 'internal_error', message: '服务暂时无法完成请求，请稍后再试。' });
  });
  worker.start();
  return { app, store, worker, close() { worker.close(); store.close(); } };
}
