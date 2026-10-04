import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { createCloudStore, digest, CHUNK_BYTES } from '../server/cloud-store.mjs';
import { createCloudApp } from '../server/cloud-app.mjs';

function memoryBlob() {
  const objects = new Map(), reads = [];
  let writes = 0;
  return {
    objects, reads, get writes() { return writes; },
    async get(path, options) {
      reads.push(options);
      const old = objects.get(path);
      if (!old) return null;
      return { statusCode: 200, stream: new Blob([old.bytes]).stream(), blob: { etag: old.etag, contentType: old.mimeType } };
    },
    async put(path, body, options) {
      const old = objects.get(path);
      if (old && !options.allowOverwrite) throw new Error('Vercel Blob: This blob already exists.');
      if (options.ifMatch && old?.etag !== options.ifMatch) throw new BlobPreconditionFailedError();
      const value = { bytes: Buffer.from(body), etag: `"${++writes}"`, mimeType: options.contentType };
      assert.equal(options.access, 'private');
      objects.set(path, value);
      return { etag: value.etag };
    },
  };
}
async function appFixture(t) {
  const blob = memoryBlob(), store = createCloudStore({ blob }), bootstrap = randomBytes(32).toString('base64url');
  let time = Date.now();
  const app = createCloudApp({ store, bootstrapHash: digest(bootstrap), secureCookies: false, now: () => time });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { json, cookie, ...options } = {}) => fetch(`${base}/api${path}`, {
    ...options, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
    ...(json ? { body: JSON.stringify(json) } : {}),
  });
  const response = await request('/bootstrap', { method: 'POST', json: { token: bootstrap } });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { blob, store, bootstrap, request, cookie, advance: (milliseconds) => { time += milliseconds; } };
}

test('private cloud CAS retries real SDK ETag conflicts and preserves parallel writes', async () => {
  const blob = memoryBlob(), store = createCloudStore({ blob, retries: 20 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.update((doc) => { doc.sessions[`s${i}`] = { expiresAt: 100 }; })));
  const { document } = await store.read();
  assert.equal(Object.keys(document.sessions).length, 10);
  assert.ok(blob.reads.every((options) => options.access === 'private' && options.useCache === false));
});

test('unchanged or oversized document mutations preserve persisted auth and consume no write', async () => {
  const blob = memoryBlob(), store = createCloudStore({ blob });
  await store.update((doc) => { doc.initialized = true; });
  const writes = blob.writes;
  await store.update(() => ({ rejected: true }));
  assert.equal(blob.writes, writes);
  await assert.rejects(store.update((doc) => { doc.jobs.large = 'x'.repeat(12_000_000); }), (error) => error.code === 'cloud_space_full');
  assert.equal(blob.writes, writes);
  assert.equal((await store.read()).document.initialized, true);
  assert.deepEqual((await store.read()).document.jobs, {});
});

test('cloud session requires bootstrap, protects private data, and rejects bootstrap replay', async (t) => {
  const { request, cookie, bootstrap, store } = await appFixture(t);
  assert.equal((await request('/state')).status, 401);
  assert.equal((await request('/bootstrap', { method: 'POST', json: { token: bootstrap } })).status, 401);
  const session = await (await request('/session', { cookie })).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.fileTransport, 'chunks');
  assert.equal(session.localBootstrapAvailable, false);
  assert.equal((await request('/state', { cookie, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/state', { cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const { document } = await store.read();
  assert.ok(!JSON.stringify(document).includes(cookie.split('=')[1]));
  assert.ok(!JSON.stringify(document).includes(bootstrap));
});

test('cloud state accepts one competing revision and returns the winning snapshot to the other', async (t) => {
  const { request, cookie } = await appFixture(t);
  const results = await Promise.all(['phone', 'ipad'].map((device) => request('/state', { method: 'PUT', cookie, json: { revision: 0, state: { version: 1, device } } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const bodies = await Promise.all(results.map((r) => r.json()));
  assert.equal(bodies[0].revision, 1);
  assert.equal(bodies[1].revision, 1);
  assert.equal(bodies[0].state.device, bodies[1].state.device);
});

test('pairing codes are atomic one-use credentials, expire, and session logout revokes access', async (t) => {
  const { request, cookie, advance } = await appFixture(t);
  const { code } = await (await request('/pairing', { method: 'POST', cookie, json: {} })).json();
  const claims = await Promise.all([0, 1].map(() => request('/pairing/claim', { method: 'POST', json: { code } })));
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 401]);
  const pairedCookie = claims.find((r) => r.status === 200).headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/state', { cookie: pairedCookie })).status, 200);
  const { code: expiredCode } = await (await request('/pairing', { method: 'POST', cookie, json: {} })).json();
  advance(10 * 60 * 1000 + 1);
  assert.equal((await request('/pairing/claim', { method: 'POST', json: { code: expiredCode } })).status, 401);
  assert.equal((await request('/logout', { method: 'POST', cookie: pairedCookie, json: {} })).status, 200);
  assert.equal((await request('/state', { cookie: pairedCookie })).status, 401);
});

test('large private files survive chunk upload/download, reject partial or mismatched bytes', async (t) => {
  const { request, cookie } = await appFixture(t);
  const bytes = Buffer.alloc(CHUNK_BYTES + 513, 7), id = 'test-private-file', mimeType = 'application/pdf';
  const manifest = { mimeType, name: 'private.pdf', size: bytes.length, totalChunks: 2, contentHash: digest(bytes) };
  const upload = (index, body) => request(`/files/${id}/chunks/${index}`, { method: 'POST', cookie, headers: { 'content-type': mimeType }, body });
  assert.equal((await upload(0, bytes.subarray(0, CHUNK_BYTES))).status, 201);
  assert.equal((await upload(0, bytes.subarray(0, CHUNK_BYTES))).status, 201);
  assert.equal((await upload(0, Buffer.from('conflict'))).status, 409);
  assert.equal((await request(`/files/${id}/complete`, { method: 'POST', cookie, json: manifest })).status, 400);
  assert.equal((await upload(1, bytes.subarray(CHUNK_BYTES))).status, 201);
  assert.equal((await request(`/files/${id}/complete`, { method: 'POST', cookie, json: { ...manifest, contentHash: '0'.repeat(64) } })).status, 400);
  assert.equal((await request(`/files/${id}/complete`, { method: 'POST', cookie, json: manifest })).status, 201);
  assert.equal((await request(`/files/${id}/meta`)).status, 401);
  assert.equal((await request(`/files/${id}/chunks/0`)).status, 401);
  const metadata = await (await request(`/files/${id}/meta`, { cookie })).json();
  assert.equal(metadata.contentHash, manifest.contentHash);
  const chunks = await Promise.all([0, 1].map(async (index) => Buffer.from(await (await request(`/files/${id}/chunks/${index}`, { cookie })).arrayBuffer())));
  assert.equal(digest(Buffer.concat(chunks)), manifest.contentHash);
  assert.equal((await request(`/files/${id}`, { cookie })).status, 413);
});

test('JSON attachments stay binary and unavailable AI jobs deduplicate without claiming completion', async (t) => {
  const { request, cookie } = await appFixture(t);
  const body = Buffer.from('{"private":true}');
  const uploaded = await request('/files/json-file-123', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body });
  assert.equal(uploaded.status, 201);
  assert.equal(await (await request('/files/json-file-123', { cookie })).text(), body.toString());
  assert.equal((await request('/files/__proto__', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body })).status, 400);
  const input = { kind: 'review', prompt: 'Review my work', context: { questionCount: 2 } };
  const first = await (await request('/ai/jobs', { method: 'POST', cookie, json: input })).json();
  const second = await (await request('/ai/jobs', { method: 'POST', cookie, json: { ...input, prompt: 'Different wording' } })).json();
  assert.equal(first.job.status, 'unavailable');
  assert.equal(first.worker.enabled, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.job.id, second.job.id);
  assert.equal('input' in first.job, false);
});

test('cloud pairing guessing limits are persisted and rejected attempts do not spend more writes', async (t) => {
  const { request, store, blob } = await appFixture(t);
  for (let i = 0; i < 10; i += 1) assert.equal((await request('/pairing/claim', { method: 'POST', json: { code: 'AAAAAAAAAA' } })).status, 401);
  const writes = blob.writes;
  assert.equal((await request('/pairing/claim', { method: 'POST', json: { code: 'AAAAAAAAAA' } })).status, 429);
  assert.equal(blob.writes, writes);
  assert.ok(Object.values((await store.read()).document.attempts).some((bucket) => bucket.count === 10));
});
