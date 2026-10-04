import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.mjs';
import { issueBootstrapToken } from '../server/store.mjs';

async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'study77-test-'));
  const runtime = createApp({ dataDir, distDir: path.join(dataDir, 'no-dist'), allowLocalBootstrap: false, secureCookies: false, ...options });
  const listener = await new Promise((resolve, reject) => {
    const server = runtime.app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(server));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  async function request(url, { cookie, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    const response = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  async function login() {
    const token = issueBootstrapToken(runtime.store);
    const response = await request('/api/bootstrap', { body: { token } });
    assert.equal(response.status, 200);
    return response.cookie;
  }
  async function close() {
    await new Promise((resolve) => listener.close(resolve));
    runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  return { ...runtime, dataDir, base, request, login, close };
}

test('public API denies private reads/writes and bootstrap is single use', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/health')).status, 200);
    assert.equal((await f.request('/api/state')).status, 401);
    assert.equal((await f.request('/api/state', { method: 'PUT', body: { state: {}, revision: 0 } })).status, 401);
    assert.equal((await f.request('/api/ai/status')).status, 401);
    assert.deepEqual((await f.request('/api/session')).body, { authenticated: false, needsBootstrap: true, localBootstrapAvailable: false });
    const token = issueBootstrapToken(f.store);
    const init = await f.request('/api/bootstrap', { body: { token } });
    assert.equal(init.status, 200);
    assert.match(init.headers.get('set-cookie'), /HttpOnly/);
    assert.match(init.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal((await f.request('/api/bootstrap', { body: { token } })).status, 401);
    assert.equal((await f.request('/api/state', { cookie: init.cookie })).status, 200);
    assert.equal(f.store.getMeta('bootstrap_hash'), undefined);
  } finally { await f.close(); }
});

test('local auto bootstrap requires true local host and is one time', async () => {
  const f = await fixture({ allowLocalBootstrap: true });
  try {
    const proxied = await f.request('/api/session', { headers: { 'X-Forwarded-For': '203.0.113.2' } });
    assert.equal(proxied.body.authenticated, false);
    const rebinding = await new Promise((resolve, reject) => {
      const request = httpRequest(f.base + '/api/session', { headers: { Host: 'attacker.example' } }, (response) => {
        let text = '';
        response.on('data', (part) => { text += part; });
        response.on('end', () => resolve(JSON.parse(text)));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(rebinding.authenticated, false);
    const local = await f.request('/api/session');
    assert.equal(local.body.authenticated, true);
    assert.ok(local.cookie);
    assert.equal((await f.request('/api/session')).body.authenticated, false);
  } finally { await f.close(); }
});

test('optimistic concurrency returns server snapshot without overwriting it', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    const first = await f.request('/api/state', { cookie, method: 'PUT', body: { state: { sessions: [{ id: 'one' }] }, revision: 0 } });
    assert.equal(first.body.revision, 1);
    const stale = await f.request('/api/state', { cookie, method: 'PUT', body: { state: { sessions: [] }, revision: 0 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'revision_conflict');
    assert.deepEqual(stale.body.state, { sessions: [{ id: 'one' }] });
    assert.deepEqual((await f.request('/api/state', { cookie })).body.state, first.body.state);
  } finally { await f.close(); }
});

test('pairing code expires, is consumed once, and supports second-device access', async () => {
  let time = Date.now();
  const f = await fixture({ now: () => time });
  try {
    const cookie = await f.login();
    const pairing = await f.request('/api/pairing', { cookie, body: {} });
    assert.equal(pairing.status, 201);
    const claim = await f.request('/api/pairing/claim', { body: { code: pairing.body.code.toLowerCase() } });
    assert.equal(claim.status, 200);
    assert.equal((await f.request('/api/state', { cookie: claim.cookie })).status, 200);
    assert.equal((await f.request('/api/pairing/claim', { body: { code: pairing.body.code } })).status, 401);
    const old = await f.request('/api/pairing', { cookie, body: {} });
    time += 10 * 60 * 1000 + 1;
    assert.equal((await f.request('/api/pairing/claim', { body: { code: old.body.code } })).status, 401);
    const row = f.store.db.prepare('SELECT code_hash FROM pairing LIMIT 1').get();
    assert.equal(row.code_hash.length, 64);
    assert.notEqual(row.code_hash, old.body.code);
  } finally { await f.close(); }
});

test('pairing guessing is rate limited and CSRF origins are rejected', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    const csrf = await f.request('/api/pairing', { cookie, body: {}, headers: { Origin: 'https://attacker.example' } });
    assert.equal(csrf.status, 403);
    for (let index = 0; index < 10; index++) await f.request('/api/pairing/claim', { body: { code: 'AAAAA-AAAAA' } });
    assert.equal((await f.request('/api/pairing/claim', { body: { code: 'AAAAA-AAAAA' } })).status, 429);
  } finally { await f.close(); }
});

test('request validation rejects malformed state, unsafe attachments and missing review data', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    assert.equal((await f.request('/api/state', { cookie, method: 'PUT', body: { state: [], revision: -1 } })).status, 400);
    assert.equal((await f.request('/api/ai/jobs', { cookie, body: { kind: 'shell', prompt: 'anything' } })).status, 400);
    assert.equal((await f.request('/api/ai/jobs', { cookie, body: { kind: 'review', prompt: 'review' } })).status, 400);
    assert.equal((await f.request('/api/ai/jobs', { cookie, body: { kind: 'extract', prompt: 'extract', attachment: { name: 'file', mimeType: 'image/png', dataUrl: 'https://example.com/private.png' } } })).status, 400);
    assert.equal((await f.request('/api/ai/jobs', { cookie, body: { kind: 'tutor', prompt: 'help', command: 'rm' } })).status, 400);
  } finally { await f.close(); }
});

test('disabled worker persists honest unavailable jobs and deduplicates review data', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    assert.equal((await f.request('/api/ai/status', { cookie })).body.enabled, false);
    const first = await f.request('/api/ai/jobs', { cookie, body: { kind: 'review', prompt: 'weekly', context: { completed: 3, words: ['a'] } } });
    assert.equal(first.status, 202);
    assert.equal(first.body.job.status, 'unavailable');
    assert.equal(first.body.job.result, null);
    const duplicate = await f.request('/api/ai/jobs', { cookie, body: { kind: 'review', prompt: 'different prompt', context: { words: ['a'], completed: 3 } } });
    assert.equal(duplicate.body.job.id, first.body.job.id);
    assert.equal(duplicate.body.duplicate, true);
    const changed = await f.request('/api/ai/jobs', { cookie, body: { kind: 'review', prompt: 'weekly', context: { completed: 4, words: ['a'] } } });
    assert.notEqual(changed.body.job.id, first.body.job.id);
    assert.equal((await f.request(`/api/ai/jobs/${first.body.job.id}`, { cookie })).body.job.status, 'unavailable');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 2);
  } finally { await f.close(); }
});

test('trusted worker completes queued jobs; failure output never exposes process details', async () => {
  let executions = 0;
  const f = await fixture({ runJob: async (input) => {
    executions += 1;
    if (input.prompt === 'fail') throw new Error('sensitive internal output');
    return { text: 'A verified test answer.' };
  } });
  try {
    const cookie = await f.login();
    const submitted = await f.request('/api/ai/jobs', { cookie, body: { kind: 'tutor', prompt: 'help' } });
    const failed = await f.request('/api/ai/jobs', { cookie, body: { kind: 'tutor', prompt: 'fail' } });
    let complete, failure;
    for (let attempt = 0; attempt < 40; attempt++) {
      complete = await f.request(`/api/ai/jobs/${submitted.body.job.id}`, { cookie });
      failure = await f.request(`/api/ai/jobs/${failed.body.job.id}`, { cookie });
      if (complete.body.job.status === 'completed' && failure.body.job.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(complete.body.job.result.text, 'A verified test answer.');
    assert.equal(failure.body.job.error.code, 'WORKER_FAILED');
    assert.ok(!JSON.stringify(failure.body).includes('sensitive'));
    assert.equal(executions, 2);
  } finally { await f.close(); }
});

test('logout revokes device credentials and retained data survives reopening', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    await f.request('/api/state', { cookie, method: 'PUT', body: { state: { note: 'retain me' }, revision: 0 } });
    assert.equal((await f.request('/api/logout', { cookie, body: {} })).status, 200);
    assert.equal((await f.request('/api/state', { cookie })).status, 401);
    const reopened = createApp({ dataDir: f.dataDir, allowLocalBootstrap: false });
    assert.deepEqual(reopened.store.getState().state, { note: 'retain me' });
    reopened.close();
  } finally { await f.close(); }
});

test('original files require authentication, sync across devices and support audio ranges', async () => {
  const f = await fixture();
  try {
    const id = 'audio-fixture-12345678';
    const audio = Buffer.from('fake-audio-test-bytes');
    assert.equal((await fetch(`${f.base}/api/files/${id}`, { method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: audio })).status, 401);
    const cookie = await f.login();
    const upload = await fetch(`${f.base}/api/files/${id}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/mpeg', 'X-Filename': encodeURIComponent('练习音频.mp3') }, body: audio });
    assert.equal(upload.status, 201);
    assert.equal((await upload.json()).size, audio.length);
    const duplicate = await fetch(`${f.base}/api/files/${id}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/mpeg' }, body: audio });
    assert.equal(duplicate.status, 200);
    const mismatch = await fetch(`${f.base}/api/files/${id}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/mpeg' }, body: Buffer.from('different') });
    assert.equal(mismatch.status, 409);
    const pairing = await f.request('/api/pairing', { cookie, body: {} });
    const second = await f.request('/api/pairing/claim', { body: { code: pairing.body.code } });
    const downloaded = await fetch(`${f.base}/api/files/${id}`, { headers: { Cookie: second.cookie } });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), audio);
    const range = await fetch(`${f.base}/api/files/${id}`, { headers: { Cookie: second.cookie, Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), 'fake');
    assert.equal((await fetch(`${f.base}/api/files/${id}`)).status, 401);
    const unsupported = await fetch(`${f.base}/api/files/unsafe-file-123`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/html' }, body: '<script>alert(1)</script>' });
    assert.equal(unsupported.status, 415);
  } finally { await f.close(); }
});

test('JSON attachments round-trip unchanged while ordinary API requests still validate JSON', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login();
    const originals = [' \n{\n  "title": "原始资料", "answer": 2\n}\n', '["一", 2]\n', '"原始文字 JSON"\n'];
    for (const [index, original] of originals.entries()) {
      const id = `json-fixture-${index}-12345678`;
      const bytes = Buffer.from(original);
      const upload = await fetch(`${f.base}/api/files/${id}`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json; charset=utf-8' }, body: bytes,
      });
      assert.equal(upload.status, 201);
      assert.equal((await upload.json()).size, bytes.length);
      const download = await fetch(`${f.base}/api/files/${id}`, { headers: { Cookie: cookie } });
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-type'), /^application\/json/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      assert.equal((await fetch(`${f.base}/api/files/${id}`)).status, 401);
    }
    const unauthorized = await fetch(`${f.base}/api/files/json-private-12345678`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not parsed before authentication',
    });
    assert.equal(unauthorized.status, 401);
    const malformedState = await fetch(`${f.base}/api/state`, {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{invalid',
    });
    assert.equal(malformedState.status, 400);
    assert.equal((await malformedState.json()).error, 'invalid_json');
  } finally { await f.close(); }
});
