// Unmounted synthetic key-envelope primitive. The caller must supply an
// independently trusted manifest digest and handle payload nonce allocation.
import { putArchiveObject } from './archive-object-store.js';

const LIMIT = 16384;
const EMPTY_LIMIT = 1024;
const PURPOSE = 'mapi-phase1-synthetic-archive';
const DOMAIN = 'mapi-synthetic-wrapped-key-envelope-auth-v1';
const SYNTHETIC_KEY = 'arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const SYNTHETIC_RUN = 'mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const encoder = new TextEncoder();

function valid(scope, signal) {
  if (!scope || typeof scope !== 'object' ||
      scope.keyArn !== SYNTHETIC_KEY || scope.runId !== SYNTHETIC_RUN ||
      typeof scope.archiveId !== 'string' || !/^[0-9a-f]{32}$/.test(scope.archiveId) ||
      typeof scope.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(scope.manifestDigest) ||
      !signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') throw new Error('Invalid synthetic archive key scope');
}

// Callers may retain and mutate their object while any storage or KMS call is
// suspended. Use only the validated primitive snapshot for the whole request.
function snapshotScope(scope, signal) {
  if (!scope || typeof scope !== 'object') throw new Error('Invalid synthetic archive key scope');
  const copy = { keyArn: scope.keyArn, runId: scope.runId, archiveId: scope.archiveId, manifestDigest: scope.manifestDigest };
  valid(copy, signal);
  return Object.freeze(copy);
}

function cancel(value) {
  try { if (value && typeof value.cancel === 'function') Promise.resolve(value.cancel()).catch(() => {}); } catch {}
}

function wipe(value) {
  try { if (value instanceof Uint8Array) value.fill(0); } catch {}
}

// A canceled call may still complete. Clean up any late plaintext response.
function waitFor(action, signal, late) {
  if (signal.aborted) return Promise.reject(new Error('Synthetic archive key operation canceled'));
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn, value) => { if (!finished) { finished = true; signal.removeEventListener('abort', onAbort); fn(value); } };
    const onAbort = () => finish(reject, new Error('Synthetic archive key operation canceled'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new Error('Synthetic archive key operation canceled'); return action(); })
      .then(value => { if (finished) { try { late?.(value); } catch {} } else finish(resolve, value); }, error => finish(reject, error));
    if (signal.aborted) onAbort();
  });
}

function namespace(scope) { return `mapi-p1-synthetic-key-v1/${scope.runId}/${scope.archiveId}`; }
function context(scope) { return { purpose: PURPOSE, run_id: scope.runId }; }
function identity(scope) { return [1, scope.keyArn, scope.runId, scope.archiveId, scope.manifestDigest]; }
function reservation(scope) { return encoder.encode(JSON.stringify(['mapi-key-reservation-v1', ...identity(scope)])); }
function signed(scope, wrapped) { return encoder.encode(JSON.stringify([DOMAIN, ...identity(scope), wrapped])); }

async function macKey(raw) {
  const input = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(DOMAIN), info: encoder.encode('envelope-mac') },
    input, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}

async function readEnvelope(bucket, key, signal) {
  const object = await waitFor(() => bucket.get(key), signal, late => cancel(late?.body));
  if (!object) throw new Error('Synthetic archive key envelope unavailable');
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > LIMIT || !object.body || typeof object.body.getReader !== 'function') {
    cancel(object.body); throw new Error('Invalid synthetic archive key envelope');
  }
  const reader = object.body.getReader(), result = new Uint8Array(object.size);
  let offset = 0, empty = 0, complete = false;
  try {
    while (true) {
      const { done, value } = await waitFor(() => reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array) || value.length > result.length - offset) throw new Error('Invalid synthetic archive key envelope');
      if (!value.length) { if (++empty > EMPTY_LIMIT) throw new Error('Invalid synthetic archive key envelope'); continue; }
      result.set(value, offset); offset += value.length;
    }
    if (offset !== result.length) throw new Error('Invalid synthetic archive key envelope');
    return result;
  } finally {
    if (!complete) cancel(reader);
    try { reader.releaseLock(); } catch {}
  }
}

function decodeBase64(value, max) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(max / 3) * 4) throw new Error('Invalid synthetic archive key envelope');
  let decoded;
  try { decoded = Uint8Array.fromBase64(value); } catch { throw new Error('Invalid synthetic archive key envelope'); }
  if (!decoded.length || decoded.length > max || decoded.toBase64() !== value) throw new Error('Invalid synthetic archive key envelope');
  return decoded;
}

function plaintext(response, keyArn) {
  if (!response || response.KeyId !== keyArn || !(response.Plaintext instanceof Uint8Array) || response.Plaintext.length !== 32) {
    wipe(response?.Plaintext); throw new Error('Invalid synthetic KMS key response');
  }
  const raw = new Uint8Array(response.Plaintext);
  wipe(response.Plaintext);
  return raw;
}

// Reserve before generation. A reservation for which generation is uncertain
// is never regenerated. Return only a provisional envelope digest; callers must
// bind it to an independently trusted commitment before any key can be opened.
export async function mintSyntheticArchiveKey(bucket, kms, scope, signal) {
  scope = snapshotScope(scope, signal);
  if (!bucket || typeof bucket.get !== 'function' || !kms || typeof kms.generateDataKey !== 'function') throw new Error('Invalid synthetic archive key provider');
  let raw;
  try {
    const name = namespace(scope), claim = await putArchiveObject(bucket, name + '/reservation', reservation(scope), LIMIT, signal);
    // created:false includes a lost acknowledgment; it does not prove ownership.
    if (!claim.created) throw new Error('Synthetic archive key reservation already claimed');
    const response = await waitFor(() => kms.generateDataKey({ KeyId: scope.keyArn, KeySpec: 'AES_256', EncryptionContext: context(scope) }, { signal }), signal,
      late => wipe(late?.Plaintext));
    raw = plaintext(response, scope.keyArn);
    if (!(response.CiphertextBlob instanceof Uint8Array) || !response.CiphertextBlob.length || response.CiphertextBlob.length > 6144) throw new Error('Invalid synthetic KMS key response');
    const wrapped = response.CiphertextBlob.toBase64();
    const tag = new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(raw), signed(scope, wrapped))).toBase64();
    const encoded = encoder.encode(JSON.stringify({ version: 1, keyArn: scope.keyArn, runId: scope.runId, archiveId: scope.archiveId, manifestDigest: scope.manifestDigest, wrapped, tag }));
    await putArchiveObject(bucket, name + '/wrapped', encoded, LIMIT, signal);
    if (signal.aborted) throw new Error('Synthetic archive key operation canceled');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (signal.aborted) throw new Error('Synthetic archive key operation canceled');
    return { provisionalEnvelopeDigest: digest };
  } catch { throw new Error('Synthetic archive key generation failed'); }
  finally { wipe(raw); }
}

// The expected scope must come from an independent trusted source. Envelope
// authentication does not establish the authority of that expected scope.
export async function openSyntheticArchiveKey(bucket, kms, scope, trustedEnvelopeDigest, signal) {
  scope = snapshotScope(scope, signal);
  if (!bucket || typeof bucket.get !== 'function' || !kms || typeof kms.decrypt !== 'function' ||
      typeof trustedEnvelopeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(trustedEnvelopeDigest)) throw new Error('Invalid synthetic archive key provider');
  let raw;
  try {
    const record = await readEnvelope(bucket, namespace(scope) + '/wrapped', signal);
    const actualDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', record))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (signal.aborted || actualDigest !== trustedEnvelopeDigest) throw new Error('Synthetic archive key envelope commitment differs');
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record));
    const fields = ['version','keyArn','runId','archiveId','manifestDigest','wrapped','tag'];
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== fields.length || fields.some(f => !Object.hasOwn(envelope, f)) ||
        envelope.version !== 1 || envelope.keyArn !== scope.keyArn || envelope.runId !== scope.runId || envelope.archiveId !== scope.archiveId || envelope.manifestDigest !== scope.manifestDigest) throw new Error('Invalid synthetic archive key envelope');
    const wrapped = decodeBase64(envelope.wrapped, 6144), tag = decodeBase64(envelope.tag, 32);
    if (tag.length !== 32) throw new Error('Invalid synthetic archive key envelope');
    const canonical = encoder.encode(JSON.stringify({ version: 1, keyArn: scope.keyArn, runId: scope.runId, archiveId: scope.archiveId, manifestDigest: scope.manifestDigest, wrapped: envelope.wrapped, tag: envelope.tag }));
    if (canonical.length !== record.length || canonical.some((byte, index) => byte !== record[index])) throw new Error('Noncanonical synthetic archive key envelope');
    const response = await waitFor(() => kms.decrypt({ KeyId: scope.keyArn, CiphertextBlob: wrapped, EncryptionContext: context(scope) }, { signal }), signal,
      late => wipe(late?.Plaintext));
    raw = plaintext(response, scope.keyArn);
    if (!await crypto.subtle.verify('HMAC', await macKey(raw), tag, signed(scope, envelope.wrapped)) || signal.aborted) throw new Error('Synthetic archive key envelope authentication failed');
    // Expose a non-extractable key only after the trusted digest and envelope
    // authentication checks. The temporary raw copy is wiped in finally.
    const result = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    if (signal.aborted) throw new Error('Synthetic archive key operation canceled');
    return result;
  } catch { throw new Error('Synthetic archive key recovery failed'); }
  finally { wipe(raw); }
}
