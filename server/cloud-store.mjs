import { createHash } from 'node:crypto';

export const CHUNK_BYTES = 3_000_000;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_STATE_BYTES = 3_500_000;
export const MAX_DOCUMENT_BYTES = 12_000_000;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const own = (record, key) => Object.hasOwn(record, key) ? record[key] : undefined;

export function emptyCloudDocument() {
  return {
    format: 1, initialized: false,
    snapshot: { state: {}, revision: 0, updatedAt: new Date(0).toISOString() },
    sessions: {}, pairing: {}, files: {}, jobs: {}, attempts: {},
  };
}

function validDocument(doc) {
  return doc?.format === 1 && typeof doc.initialized === 'boolean'
    && doc.snapshot && Number.isSafeInteger(doc.snapshot.revision)
    && ['sessions', 'pairing', 'files', 'jobs', 'attempts'].every((key) => doc[key] && typeof doc[key] === 'object' && !Array.isArray(doc[key]));
}

function isConflict(error) {
  return ['BlobPreconditionFailedError', 'BlobAlreadyExistsError'].includes(error?.constructor?.name)
    || ['BlobPreconditionFailedError', 'BlobAlreadyExistsError'].includes(error?.name)
    || [409, 412].includes(error?.statusCode);
}

/** A single user's private document. Every mutation is a read/compare/write.
 * SDK get(useCache:false) is essential: cached auth/state may lag by a minute.
 * Never replace conditional writes with an in-process lock on serverless hosts.
 */
export function createCloudStore({ blob, pathname = 'study77/private-space.json', retries = 8 } = {}) {
  if (!blob?.get || !blob?.put) throw new Error('A private Blob adapter is required.');
  const blobRead = (key) => blob.get(key, { access: 'private', useCache: false });
  async function read() {
    const object = await blobRead(pathname);
    if (!object) return { document: emptyCloudDocument(), etag: null };
    if (object.statusCode !== 200 || !object.stream || !object.blob?.etag) throw new Error('Invalid private storage response.');
    const document = await new Response(object.stream).json();
    if (!validDocument(document)) throw new Error('Unsupported private storage format.');
    return { document, etag: object.blob.etag };
  }
  async function update(mutate) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const { document, etag } = await read();
      const before = JSON.stringify(document);
      // The callback must be pure apart from the document it receives: a conflict
      // retries it against the winning document before any HTTP result is sent.
      const result = await mutate(document);
      const serialized = JSON.stringify(document);
      // Rejected/replayed operations must not spend a Blob write or change ETags.
      if (serialized === before) return result;
      if (Buffer.byteLength(serialized) > MAX_DOCUMENT_BYTES) {
        throw Object.assign(new Error('Private storage document is full.'), { status: 413, code: 'cloud_space_full' });
      }
      try {
        await blob.put(pathname, serialized, {
          access: 'private', addRandomSuffix: false, allowOverwrite: !!etag,
          ...(etag ? { ifMatch: etag } : {}), contentType: 'application/json', cacheControlMaxAge: 60,
        });
        return result;
      } catch (error) {
        if (isConflict(error)) continue;
        // Blob's duplicate-create error is currently a generic BlobError. A
        // competing creation (or lost successful response) is verified by read.
        if (!etag && (await read()).etag) continue;
        throw error;
      }
    }
    throw Object.assign(new Error('Private storage is busy.'), { status: 503, code: 'storage_busy' });
  }
  const chunkPath = (id, index) => `study77/files/${id}/${index}`;
  async function getChunk(id, index) {
    const object = await blobRead(chunkPath(id, index));
    if (!object) return null;
    if (object.statusCode !== 200 || !object.stream) throw new Error('Invalid file response.');
    return { bytes: Buffer.from(await new Response(object.stream).arrayBuffer()), mimeType: object.blob.contentType };
  }
  async function putChunk(id, index, bytes, mimeType) {
    try {
      await blob.put(chunkPath(id, index), bytes, {
        access: 'private', addRandomSuffix: false, allowOverwrite: false,
        contentType: mimeType, cacheControlMaxAge: 60,
      });
    } catch (error) {
      const old = await getChunk(id, index);
      if (!old) throw error;
      if (old.mimeType !== mimeType || digest(old.bytes) !== digest(bytes)) {
        throw Object.assign(new Error('File id conflict.'), { status: 409, code: 'file_id_conflict' });
      }
    }
  }
  return { read, update, getChunk, putChunk, pathname };
}
