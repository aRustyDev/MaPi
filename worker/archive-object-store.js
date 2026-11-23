// A bounded, opaque object primitive. It does not encrypt, authorize access,
// enforce retention, or establish that a complete archive exists.
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_EMPTY_CHUNKS = 1024;

function wellFormed(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validate(bucket, key, value, maxBytes, signal) {
  if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function' ||
      typeof key !== 'string' || !key || key.length > 1024 || !wellFormed(key) || new TextEncoder().encode(key).length > 1024 ||
      !(value instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      maxBytes > MAX_OBJECT_BYTES || value.byteLength > maxBytes || !signal ||
      typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') {
    throw new Error('Invalid archive object');
  }
}

class ArchiveCanceled extends Error {
  constructor() { super('Archive operation canceled'); }
}

// Stopping the wait cannot revoke an already-dispatched R2 put. Any later
// retry must use the same key and exact ciphertext, and still read it back.
function waitFor(action, signal, onLateValue) {
  if (signal.aborted) return Promise.reject(new ArchiveCanceled());
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new ArchiveCanceled());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new ArchiveCanceled();
      return action();
    }).then(value => {
      if (finished) {
        try { onLateValue?.(value); } catch {}
      } else finish(resolve, value);
    }, error => finish(reject, error));
    if (signal.aborted) onAbort();
  });
}

function cancelWithoutWaiting(value) {
  try { if (value && typeof value.cancel === 'function') Promise.resolve(value.cancel()).catch(() => {}); } catch {}
}

// Do not allocate from an existing object's declared length. Compare against
// a bounded snapshot while streaming, including exact end-of-stream coverage.
async function verify(bucket, key, expected, signal) {
  const object = await waitFor(() => bucket.get(key), signal, late => {
    try { cancelWithoutWaiting(late?.body); } catch {}
  });
  if (object === null) return false;
  if (!object || object.size !== expected.length) {
    try { cancelWithoutWaiting(object?.body); } catch {}
    throw new Error('Archive object conflicts');
  }
  if (!object.body || typeof object.body.getReader !== 'function') throw new Error('Archive object conflicts');
  const reader = object.body.getReader();
  let offset = 0, empty = 0, complete = false;
  try {
    while (true) {
      const { value, done } = await waitFor(() => reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw new Error('Invalid archive object stream');
      if (!value.length) {
        if (++empty > MAX_EMPTY_CHUNKS) throw new Error('Invalid archive object stream');
        continue;
      }
      if (value.length > expected.length - offset) throw new Error('Archive object conflicts');
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== expected[offset + i]) throw new Error('Archive object conflicts');
      }
      offset += value.length;
    }
    if (offset !== expected.length) throw new Error('Archive object conflicts');
    return true;
  } finally {
    if (!complete) {
      cancelWithoutWaiting(reader);
    }
    try { reader.releaseLock(); } catch {}
  }
}

// Creates an object only if absent. If a write acknowledgment is lost, the
// caller may proceed only after an exact read-back. A pre-existing different
// object is never overwritten. Bucket IAM and retention must prevent later
// deletion or unconditional replacement; this helper cannot enforce either.
export async function putArchiveObject(bucket, key, value, maxBytes, signal) {
  validate(bucket, key, value, maxBytes, signal);
  if (signal.aborted) throw new ArchiveCanceled();
  const expected = new Uint8Array(value);
  let created = false;
  try {
    const result = await waitFor(() => bucket.put(key, expected, { onlyIf: new Headers({ 'If-None-Match': '*' }) }), signal);
    created = result !== null && typeof result === 'object';
  } catch (error) { if (error instanceof ArchiveCanceled) throw error; }
  // Neither upstream exceptions nor object names or bytes belong in errors.
  try { if (!await verify(bucket, key, expected, signal)) throw new Error(); }
  catch (error) { if (error instanceof ArchiveCanceled) throw error; throw new Error('Archive object verification failed'); }
  return { created };
}
