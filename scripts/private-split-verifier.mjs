// Local split experiment only. The caller must retain the password and hash in
// its own invocation and must not expose this binding or its secret publicly.
const responseLimit = 1024, requestLimit = 4096, passwordLimit = 1024, hashLimit = 512;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

// Check the UTF-8 byte length before constructing a request body. A UTF-16
// string has at most as many code units as UTF-8 bytes, so the first check
// avoids encoding an unbounded value. Clear the short-lived byte buffer.
function withinUtf8Limit(value, limit) {
  if (value.length > limit) return false;
  const encoded = encoder.encode(value);
  const ok = encoded.byteLength <= limit;
  encoded.fill(0);
  return ok;
}

// JSON.parse accepts duplicate object names and keeps the last one. The
// protocol accepts a flat object of scalar fields; scan its names separately
// so duplicates and escaped aliases are rejected before a proof is accepted.
function hasUniqueScalarNames(text) {
  let index = 0;
  const skip = () => { while (index < text.length && ' \t\r\n'.includes(text[index])) index++; };
  const string = () => {
    if (text[index] !== '"') throw new Error('Expected string');
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index++] === '"') return JSON.parse(text.slice(start, index));
    }
    throw new Error('Unterminated string');
  };
  try {
    const names = new Set();
    skip(); if (text[index++] !== '{') return false;
    skip();
    if (text[index] === '}') { index++; skip(); return index === text.length; }
    for (;;) {
      skip(); const name = string();
      if (names.has(name)) return false;
      names.add(name);
      skip(); if (text[index++] !== ':') return false;
      skip();
      if (text[index] === '"') string();
      else {
        const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
        if (!scalar) return false;
        index += scalar[0].length;
      }
      skip();
      if (text[index] === '}') { index++; skip(); return index === text.length; }
      if (text[index++] !== ',') return false;
    }
  } catch { return false; }
}

export async function verifyPrivatePassword(binding, secret, { password, hash, signal }) {
  if (!binding || typeof binding.fetch !== 'function' || typeof secret !== 'string' || secret.length < 32 ||
      typeof password !== 'string' || !password || !withinUtf8Limit(password, passwordLimit) ||
      typeof hash !== 'string' || !hash || !withinUtf8Limit(hash, hashLimit) || signal?.aborted) {
    throw new Error('Private verifier unavailable');
  }
  const body = JSON.stringify({ password, hash });
  if (!withinUtf8Limit(body, requestLimit)) throw new Error('Private verifier unavailable');
  let response;
  try {
    response = await binding.fetch('https://argon.internal/verify', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body,
      signal,
    });
  } catch {
    throw new Error('Private verifier unavailable');
  }
  if (!response || typeof response !== 'object' || !response.headers || typeof response.headers.get !== 'function') {
    throw new Error('Private verifier unavailable');
  }
  let reader;
  try { reader = response.body?.getReader(); }
  catch { throw new Error('Private verifier unavailable'); }
  if (!reader) throw new Error('Private verifier unavailable');
  // A malformed binding/reader can throw synchronously as well as return a
  // rejected promise. Cleanup must never replace the result or expose error
  // details, including from the abort event listener.
  const cancel = () => { try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Best-effort cleanup. */ } };
  const canceled = Symbol('verifier aborted');
  let resolveAbort;
  const abortSignal = signal ? new Promise(resolve => { resolveAbort = resolve; }) : null;
  const abort = () => { cancel(); resolveAbort?.(canceled); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const chunks = [];
  let bytes;
  try {
    const length = response.headers.get('content-length');
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > responseLimit))) {
      throw new Error('Private verifier unavailable');
    }
    let total = 0;
    for (;;) {
      if (signal?.aborted) throw new Error('Private verifier unavailable');
      const read = reader.read();
      const result = await (abortSignal ? Promise.race([read, abortSignal]) : read);
      if (result === canceled) throw new Error('Private verifier unavailable');
      const { done, value } = result;
      if (signal?.aborted) throw new Error('Private verifier unavailable');
      if (done) break;
      if (!(value instanceof Uint8Array) || (total += value.byteLength) > responseLimit) throw new Error('Private verifier unavailable');
      chunks.push(value);
    }
    if (length !== null && Number(length) !== total) throw new Error('Private verifier unavailable');
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = decoder.decode(bytes);
    const value = JSON.parse(text);
    if (!hasUniqueScalarNames(text)) throw new Error('Private verifier unavailable');
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.verified !== 'boolean' ||
        typeof value.rehash !== 'string' || (value.wasmBytes !== undefined && (!Number.isSafeInteger(value.wasmBytes) || value.wasmBytes < 0)) ||
        Object.keys(value).some(key => !['verified', 'rehash', 'wasmBytes'].includes(key))) throw new Error('Private verifier unavailable');
    return { verified: value.verified, rehash: value.rehash };
  } catch {
    throw new Error('Private verifier unavailable');
  } finally {
    signal?.removeEventListener('abort', abort);
    cancel();
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
