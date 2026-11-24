// Local-only synthetic archive protocol. Never mounts a route or deletes source
// data. Correct nonce safety depends on the archive store enforcing permanent
// create-only nonce reservations for the lifetime of its independently held key.
import { putArchiveObject } from './archive-object-store.js';
import { openSyntheticArchiveKey } from './synthetic-archive-key-provider.js';

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const MAX_CHUNK = 128 * 1024, MAX_RECORD = 128 * 1024, PART_BYTES = 80 * 1024, MAX_EMPTY = 1024;
const typedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get;
const hex = b => [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
const sha = async b => hex(await crypto.subtle.digest('SHA-256', b));
const bytes = s => enc.encode(s);
const isDigest = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
function wellFormed(x) {
  for (let i=0;i<x.length;i++) {
    const unit=x.charCodeAt(i);
    if (unit>=0xd800 && unit<=0xdbff) { const next=x.charCodeAt(++i); if (!(next>=0xdc00 && next<=0xdfff)) return false; }
    else if (unit>=0xdc00 && unit<=0xdfff) return false;
  }
  return true;
}
const isText = x => typeof x === 'string' && x.length > 0 && x.length <= 1024 && wellFormed(x);
const equal = (a,b) => a.length === b.length && a.every((v,i) => v === b[i]);
function checkSignal(signal) {
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') throw Error('Invalid archive signal');
  if (signal.aborted) throw Error('Archive operation canceled');
}
function wait(action, signal, late) {
  checkSignal(signal);
  return new Promise((resolve,reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; signal.removeEventListener('abort', abort); fn(v); } };
    const abort = () => finish(reject, Error('Archive operation canceled'));
    signal.addEventListener('abort', abort, { once:true });
    Promise.resolve().then(() => { checkSignal(signal); return action(); }).then(v => { if (done) { try { late?.(v); } catch {} } else finish(resolve,v); }, () => finish(reject,Error(signal.aborted ? 'Archive operation canceled' : 'Archive storage unavailable')));
    if (signal.aborted) abort();
  });
}
function cancel(value) { try { Promise.resolve(value?.cancel?.()).catch(() => {}); } catch {} }
async function read(bucket, name, signal, optional = false) {
  const o = await wait(() => bucket.get(name), signal, v => cancel(v?.body));
  if (o === null && optional) return null;
  let size, body, getReader;
  try { size=o?.size; body=o?.body; getReader=body?.getReader; }
  catch { throw Error('Archive storage unavailable'); }
  if (!o || !Number.isSafeInteger(size) || size < 1 || size > MAX_RECORD || typeof getReader!=='function') { cancel(body); throw Error('Archive record unavailable'); }
  let reader;
  try { reader=getReader.call(body); }
  catch { throw Error('Archive storage unavailable'); }
  const out = new Uint8Array(size);
  let pos = 0, empty = 0, done = false;
  try {
    for (;;) {
      const r = await wait(() => reader.read(), signal);
      // Result accessors supplied by a storage adapter can throw arbitrary
      // errors. Do not pass their messages or causes to an archive caller.
      let ended, value, length, typed=false;
      try { ended=r.done; if (ended===false) { value=r.value; typed=value instanceof Uint8Array; if (typed) length=typedArrayLength.call(value); } }
      catch { throw Error('Archive storage unavailable'); }
      if (ended === true) { done = true; break; }
      if (ended !== false || !typed || !Number.isSafeInteger(length) || length < 0 || length > out.length - pos) throw Error('Invalid archive record');
      if (!length) { if (++empty > MAX_EMPTY) throw Error('Invalid archive record'); continue; }
      try { out.set(value, pos); } catch { throw Error('Archive storage unavailable'); }
      pos += length;
    }
    if (pos !== out.length) throw Error('Invalid archive record');
    return out;
  } finally { if (!done) cancel(reader); try { reader.releaseLock(); } catch {} }
}
// Snapshot a single bounded listing page, reading every external property
// once. Adapter exceptions may contain sensitive data and cannot escape.
function inventoryPage(page) {
  let objects, truncated, cursor, length, keys;
  try {
    objects=page?.objects; truncated=page?.truncated;
    if (!Array.isArray(objects) || typeof truncated !== 'boolean') throw Error();
    length=objects.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > 1000) throw Error();
    keys=new Array(length);
    for (let i=0;i<length;i++) keys[i]=objects[i]?.key;
    if (truncated) cursor=page.cursor;
  } catch { throw Error('Invalid archive inventory'); }
  return { keys, truncated, cursor };
}
// Selectors use one fixed-width decimal suffix. Check the full key length
// before slicing so an adapter cannot make us copy an arbitrarily large key.
function selectorSuffix(key, base) {
  if (typeof key !== 'string' || key.length !== base.length + 16 || !key.startsWith(base)) throw Error('Unexpected archive selector');
  return key.slice(base.length);
}
function b64(s, limit) {
  if (typeof s !== 'string' || !s || s.length > Math.ceil(limit / 3) * 4) throw Error('Invalid archive record');
  let v; try { v = Uint8Array.fromBase64(s); } catch { throw Error('Invalid archive record'); }
  if (!v.length || v.length > limit || v.toBase64() !== s) throw Error('Invalid archive record');
  return v;
}
function parseCanonical(data) {
  let text, value;
  // JSON.parse errors may quote source bytes. Archive metadata and plaintext
  // can contain private project data, so never expose parser exceptions.
  try { text = dec.decode(data); value = JSON.parse(text); }
  catch { throw Error('Invalid archive record'); }
  if (JSON.stringify(value) !== text) throw Error('Invalid archive record');
  return value;
}
// The caller must obtain this expected commitment independently from archive
// objects and the source's rewindable database. This validator cannot do that.
function expected(scope, commitment, envelopeDigest, signal) {
  checkSignal(signal);
  const s = JSON.parse(JSON.stringify(scope)), c = JSON.parse(JSON.stringify(commitment));
  const fields = ['projectId','origin','objectName','generation','moveId','manifestDigest','tables','chunkCount','finalDigest'];
  if (!s || !isDigest(s.manifestDigest) || !/^[0-9a-f]{32}$/.test(s.archiveId) || !isDigest(envelopeDigest) || !c ||
      Object.keys(c).length !== fields.length || fields.some(k => !Object.hasOwn(c,k)) ||
      !isText(c.projectId) || !isText(c.origin) || !isText(c.objectName) || !isText(c.moveId) ||
      !Number.isSafeInteger(c.generation) || c.generation < 1 || c.generation === Number.MAX_SAFE_INTEGER ||
      !isDigest(c.manifestDigest) || c.manifestDigest !== s.manifestDigest || !isDigest(c.finalDigest) ||
      !Number.isSafeInteger(c.chunkCount) || c.chunkCount < 1 || c.chunkCount > 1000000 ||
      !Array.isArray(c.tables) || !c.tables.length || c.tables.length > 256 || c.tables.some(t => !isText(t)) || new Set(c.tables).size !== c.tables.length) throw Error('Invalid archive commitment');
  const result = { scope: s, commitment: c, envelopeDigest };
  if (bytes(JSON.stringify(identity(result))).length > 32 * 1024) throw Error('Archive identity exceeds limit');
  return result;
}
function identity(e) { const c = e.commitment; return [1, e.scope.runId, e.scope.archiveId, e.envelopeDigest, c.projectId, c.origin, c.objectName, c.generation, c.moveId, c.manifestDigest, c.tables, c.chunkCount, c.finalDigest]; }
function prefix(e) { return `mapi-p1-synthetic-archive-v1/${e.scope.runId}/${e.scope.archiveId}`; }
function name(e, role, i) { return `${prefix(e)}/${role}/${String(i).padStart(16,'0')}`; }
function sealingMode(e) { return bytes(JSON.stringify(['mapi-synthetic-authority-required-v1',...identity(e)])); }
async function requireLegacyMode(bucket,e,signal) {
  if (await read(bucket,name(e,'sealing-mode',0),signal,true)!==null) throw Error('Archive requires sealing authority');
}
async function requireSealingMode(bucket,e,signal) {
  const mode=await read(bucket,name(e,'sealing-mode',0),signal);
  if (!equal(mode,sealingMode(e))) throw Error('Archive sealing mode differs');
}
function aad(e, role, i, digest, nonce) { return bytes(JSON.stringify(['mapi-synthetic-archive-v1', ...identity(e), role, i, digest, nonce])); }
function reservation(e, role, i, digest) { return bytes(JSON.stringify(['mapi-archive-content-reservation-v1', ...identity(e), role, i, digest])); }
function nonceName(e, nonce) { return `${prefix(e)}/nonce/${nonce}`; }
function attemptName(e, nonce) { return `${prefix(e)}/attempt/${nonce}`; }
function nonceReservation(e, role, i, digest, nonce) { return bytes(JSON.stringify(['mapi-archive-nonce-reservation-v1', ...identity(e), role, i, digest, nonce])); }
function nonceBytes(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{24}$/.test(value)) throw Error('Invalid archive nonce');
  return Uint8Array.from(value.match(/../g), h => Number.parseInt(h,16));
}
async function key(bucket,kms,e,signal) { return openSyntheticArchiveKey(bucket,kms,e.scope,e.envelopeDigest,signal); }
async function readRecord(bucket,k,e,role,i,signal,optional = false) {
  const selector = await read(bucket,name(e,role+'-selector',i),signal,optional);
  if (selector === null) return null;
  const s = parseCanonical(selector);
  if (!Array.isArray(s) || s.length !== 6 || s[0] !== 1 || s[1] !== role || s[2] !== i || !isDigest(s[3]) || !isDigest(s[5])) throw Error('Invalid archive selector');
  const nonce = nonceBytes(s[4]);
  const reserved = await read(bucket,name(e,role+'-reservation',i),signal);
  if (!equal(reserved,reservation(e,role,i,s[3]))) throw Error('Archive content reservation differs');
  const nonceClaim = await read(bucket,nonceName(e,s[4]),signal);
  if (!equal(nonceClaim,nonceReservation(e,role,i,s[3],s[4]))) throw Error('Archive nonce reservation differs');
  const record = await read(bucket,attemptName(e,s[4]),signal), r = parseCanonical(record);
  if (await sha(record) !== s[5] || !Array.isArray(r) || r.length !== 6 || r[0] !== 1 || r[1] !== role || r[2] !== i || r[3] !== s[3] || r[4] !== s[4]) throw Error('Invalid archive attempt');
  const ciphertext = b64(r[5],MAX_RECORD);
  let plaintext; try { plaintext = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:aad(e,role,i,s[3],s[4]),tagLength:128},k,ciphertext)); }
  catch { throw Error('Archive authentication failed'); }
  if (await sha(plaintext) !== s[3]) throw Error('Archive content differs');
  checkSignal(signal);
  return { plaintext, digest:s[3], recordDigest:s[5], selectorDigest:await sha(selector) };
}
async function writeRecord(bucket, k, e, role, i, plaintext, signal) {
  const digest = await sha(plaintext); checkSignal(signal);
  await putArchiveObject(bucket, name(e,role+'-reservation',i), reservation(e,role,i,digest), MAX_RECORD, signal);
  const existing = await readRecord(bucket,k,e,role,i,signal,true);
  if (existing) {
    if (existing.digest !== digest || !equal(existing.plaintext,plaintext)) throw Error('Archive record conflicts');
    return { digest, recordDigest:existing.recordDigest };
  }
  // A unique, random 96-bit attempt nonce is claimed create-only. A collision,
  // uncertain acknowledgement, cancellation or crash burns it without reuse.
  // This requires that this namespace cannot be deleted or rolled back during
  // the entire lifetime of the data key. Never encrypt on an ambiguous claim.
  let nonce, claim;
  for (let attempt=0; attempt<16; attempt++) {
    nonce = hex(crypto.getRandomValues(new Uint8Array(12)));
    try { claim = await putArchiveObject(bucket,nonceName(e,nonce),nonceReservation(e,role,i,digest,nonce),MAX_RECORD,signal); }
    catch { checkSignal(signal); continue; }
    if (claim.created) break;
  }
  if (!claim?.created) throw Error('Unable to reserve archive nonce');
  checkSignal(signal);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv:nonceBytes(nonce), additionalData:aad(e,role,i,digest,nonce), tagLength:128 }, k, plaintext));
  checkSignal(signal);
  const record = bytes(JSON.stringify([1,role,i,digest,nonce,ciphertext.toBase64()]));
  await putArchiveObject(bucket,attemptName(e,nonce),record,MAX_RECORD,signal);
  const recordDigest = await sha(record);
  const selector = bytes(JSON.stringify([1,role,i,digest,nonce,recordDigest]));
  try { await putArchiveObject(bucket,name(e,role+'-selector',i),selector,MAX_RECORD,signal); }
  catch { checkSignal(signal); }
  const chosen = await readRecord(bucket,k,e,role,i,signal);
  if (chosen.digest !== digest || !equal(chosen.plaintext,plaintext)) throw Error('Archive record conflicts');
  return { digest, recordDigest:chosen.recordDigest };
}
// Exactly two parts per chunk make the committed inventory unambiguous even
// when a chunk's second part is empty. Hashes in the encrypted descriptor
// bind the reconstructed original bytes to the frozen-source commitment.
async function readChunk(bucket,k,e,i,signal) {
  const descriptor = await readRecord(bucket,k,e,'chunk',i,signal);
  const d = parseCanonical(descriptor.plaintext);
  if (!Array.isArray(d) || d.length !== 5 || d[0] !== 1 || !isDigest(d[1]) || !Number.isSafeInteger(d[2]) || d[2] < 1 || d[2] > MAX_CHUNK || !isDigest(d[3]) || !isDigest(d[4])) throw Error('Invalid archive chunk descriptor');
  const binding = await read(bucket,name(e,'chunk-content-reservation',i),signal);
  if (!equal(binding,reservation(e,'chunk-content',i,d[1]))) throw Error('Archive chunk reservation differs');
  const first = await readRecord(bucket,k,e,'part',i*2,signal), second = await readRecord(bucket,k,e,'part',i*2+1,signal);
  if (first.digest !== d[3] || second.digest !== d[4] || first.plaintext.length !== Math.min(d[2],PART_BYTES) || second.plaintext.length !== Math.max(0,d[2]-PART_BYTES)) throw Error('Archive chunk parts differ');
  const plaintext = new Uint8Array(d[2]); plaintext.set(first.plaintext); plaintext.set(second.plaintext,first.plaintext.length);
  if (await sha(plaintext) !== d[1]) throw Error('Archive chunk digest differs');
  return {plaintext,digest:d[1],selectorDigest:await sha(bytes(JSON.stringify(['mapi-chunk-selectors-v1',descriptor.selectorDigest,first.selectorDigest,second.selectorDigest]))),recordDigest:await sha(bytes(JSON.stringify(['mapi-chunk-records-v1',descriptor.recordDigest,first.recordDigest,second.recordDigest])))};
}
function sourceChunk(data,e,i) {
  if (data.length > MAX_CHUNK) throw Error('Archive source chunk exceeds limit');
  let p;
  try { p = JSON.parse(dec.decode(data)); }
  catch { throw Error('Invalid archive source chunk'); }
  const c = e.commitment;
  if (!p || p.projectId !== c.projectId || p.generation !== c.generation || p.moveId !== c.moveId || p.index !== i ||
      typeof p.prev !== 'string' || !Array.isArray(p.rows) || p.rows.length > 64 || typeof p.last !== 'boolean' || typeof p.done !== 'boolean' || !isText(p.table)) throw Error('Archive source identity differs');
  return p;
}
export async function archiveSyntheticChunk(bucket,kms,scope,commitment,envelopeDigest,index,content,signal) {
  const e = expected(scope,commitment,envelopeDigest,signal);
  await requireLegacyMode(bucket,e,signal);
  if (!Number.isSafeInteger(index) || index < 0 || index >= e.commitment.chunkCount || typeof content !== 'string' || content.length > MAX_CHUNK || !wellFormed(content)) throw Error('Invalid archive chunk');
  const plain = bytes(content), p = sourceChunk(plain,e,index), k = await key(bucket,kms,e,signal);
  if (index === 0 ? p.prev !== '' : p.prev !== (await readChunk(bucket,k,e,index-1,signal)).digest) throw Error('Archive source chain differs');
  if (p.done !== (index === e.commitment.chunkCount - 1)) throw Error('Archive source completion differs');
  const digest = await sha(plain);
  await requireLegacyMode(bucket,e,signal);
  await putArchiveObject(bucket,name(e,'chunk-content-reservation',index),reservation(e,'chunk-content',index,digest),MAX_RECORD,signal);
  await requireLegacyMode(bucket,e,signal);
  const first = await writeRecord(bucket,k,e,'part',index*2,plain.subarray(0,PART_BYTES),signal);
  await requireLegacyMode(bucket,e,signal);
  const second = await writeRecord(bucket,k,e,'part',index*2+1,plain.subarray(PART_BYTES),signal);
  const descriptor = bytes(JSON.stringify([1,digest,plain.length,first.digest,second.digest]));
  await requireLegacyMode(bucket,e,signal);
  await writeRecord(bucket,k,e,'chunk',index,descriptor,signal);
  const verified = await readChunk(bucket,k,e,index,signal);
  if (!equal(verified.plaintext,plain)) throw Error('Archive chunk differs');
  await requireLegacyMode(bucket,e,signal);
  return {digest,recordDigest:verified.recordDigest};
}
// Selectors are the committed inventory. Orphan nonce claims and attempts
// from interrupted writes are deliberately ignored and never deleted here.
async function selectors(bucket,e,role,count,signal) {
  if (!bucket || typeof bucket.list !== 'function') throw Error('Archive inventory unavailable');
  const base = `${prefix(e)}/${role}-selector/`; let cursor, seen = 0, pages = 0;
  do {
    const page = inventoryPage(await wait(() => bucket.list({ prefix:base, limit:1000, ...(cursor ? { cursor } : {}) }),signal));
    if (++pages > Math.min(count + 1,4096)) throw Error('Invalid archive inventory');
    for (const key of page.keys) {
      const suffix = selectorSuffix(key, base);
      if (!/^\d{16}$/.test(suffix)) throw Error('Unexpected archive selector');
      const index = Number(suffix);
      if (!Number.isSafeInteger(index) || index !== seen || index >= count || String(index).padStart(16,'0') !== suffix) throw Error('Unexpected archive selector');
      seen++;
    }
    if (!page.truncated) { cursor = undefined; break; }
    if (typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 2048 || page.cursor === cursor) throw Error('Invalid archive inventory cursor');
    cursor = page.cursor;
  } while (cursor);
  if (seen !== count) throw Error('Archive inventory incomplete');
}
// Each iteration consumes one bounded record. The complete scan is deliberately
// required before a seal or any restore callback; it may need a durable, trusted
// verification checkpoint before use on a platform with invocation limits.
async function scan(bucket,k,e,signal,consume) {
  const c = e.commitment; let previous = '', inventory = '', table = 0;
  for (let i=0;i<c.chunkCount;i++) {
    const r = await readChunk(bucket,k,e,i,signal), p = sourceChunk(r.plaintext,e,i);
    if (p.prev !== previous || p.table !== c.tables[table] || p.done !== (i === c.chunkCount-1) || (p.done && !p.last)) throw Error('Archive chain differs');
    if (p.last) table++;
    if (table > c.tables.length || (i < c.chunkCount-1 && table >= c.tables.length)) throw Error('Archive table order differs');
    previous = r.digest; inventory = await sha(bytes(JSON.stringify(['mapi-archive-inventory-v1',inventory,i,r.selectorDigest,r.recordDigest])));
    if (consume) await consume(dec.decode(r.plaintext),i);
  }
  if (previous !== c.finalDigest || table !== c.tables.length) throw Error('Archive commitment differs');
  return inventory;
}
export async function sealSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal) {
  const e = expected(scope,commitment,envelopeDigest,signal), k = await key(bucket,kms,e,signal);
  await requireLegacyMode(bucket,e,signal);
  const inventory = await scan(bucket,k,e,signal);
  await selectors(bucket,e,'chunk',e.commitment.chunkCount,signal);
  await selectors(bucket,e,'part',e.commitment.chunkCount*2,signal);
  const seal = bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(e),inventory]));
  await requireLegacyMode(bucket,e,signal);
  const result=await writeRecord(bucket,k,e,'seal',0,seal,signal);
  await requireLegacyMode(bucket,e,signal);
  return result;
}
async function verifyArchiveCore(bucket,k,e,signal) {
  const seal = await readRecord(bucket,k,e,'seal',0,signal), inventory = await scan(bucket,k,e,signal);
  await selectors(bucket,e,'chunk',e.commitment.chunkCount,signal);
  await selectors(bucket,e,'part',e.commitment.chunkCount*2,signal);
  await selectors(bucket,e,'seal',1,signal);
  const expectedSeal = bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(e),inventory]));
  if (!equal(seal.plaintext,expectedSeal)) throw Error('Archive seal differs');
  return { chunkCount:e.commitment.chunkCount, finalDigest:e.commitment.finalDigest, inventoryDigest:inventory };
}
export async function verifySyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal) {
  const e = expected(scope,commitment,envelopeDigest,signal), k = await key(bucket,kms,e,signal);
  await requireLegacyMode(bucket,e,signal);
  const result=await verifyArchiveCore(bucket,k,e,signal);
  await requireLegacyMode(bucket,e,signal);
  return result;
}
// Destination callbacks receive authenticated private data and may include it
// in their own errors. A failed mutation can have committed before its error
// or lost acknowledgement; never infer rollback, and do not attach its cause.
async function destinationRead(target, signal) {
  // A stalled checkpoint read must not prevent cancellation. The already
  // dispatched read is not revoked; any late result is discarded. Mutations
  // are still awaited and their durable outcome must be reconciled on retry.
  // A service RPC returns detached values, but a same-isolate adapter can
  // otherwise retain and mutate the object after load resolves. Keep the
  // driver's checkpoint independent of all destination-owned references.
  try {
    const value = await wait(() => target.load(), signal);
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    const fields=['identityDigest','sealDigest','inventoryDigest','next','previous','inventory','table','complete'];
    const keys=Object.keys(value);
    if (keys.length === fields.length+1 && Object.hasOwn(value,'verificationHeadDigest')) fields.push('verificationHeadDigest');
    if (keys.length!==fields.length || fields.some(name=>!Object.hasOwn(value,name)) || keys.some(name=>!fields.includes(name))) throw Error();
    const copy={};
    for (const name of fields) {
      const item=value[name];
      if (name==='next' || name==='table') { if (!Number.isSafeInteger(item)) throw Error(); }
      else if (name==='complete') { if (typeof item!=='boolean') throw Error(); }
      else if (typeof item!=='string' || item.length>64) throw Error();
      copy[name]=item;
    }
    return copy;
  }
  catch { throw Error(signal.aborted ? 'Archive operation canceled' : 'Archive destination unavailable'); }
}
async function destinationWrite(operation) {
  try { return await operation(); }
  catch { throw Error('Archive destination outcome uncertain; reconciliation required'); }
}
// The destination implementation must enforce freshness and inaccessibility,
// atomically apply each row group with this checkpoint, and remain closed on
// failure. No route activation is provided here. Resuming a verified prefix
// requires independently enforced nonrollback/no-delete archive retention.
export async function restoreSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal,target,verification = null) {
  let selected = null;
  if (verification !== null) {
    if (!verification || typeof verification !== 'object') throw Error('Invalid verification input');
    checkReadAuthority(verification.authority);
    if (typeof verification.jobId !== 'string' || !/^[0-9a-f]{32}$/.test(verification.jobId)) throw Error('Invalid verification job');
    const maxChunks=verification.maxChunks===undefined?4:verification.maxChunks;
    if (!Number.isSafeInteger(maxChunks) || maxChunks<1 || maxChunks>8) throw Error('Invalid restore step limit');
    selected = {authority:verification.authority,jobId:verification.jobId,head:JSON.parse(JSON.stringify(verification.head)),maxChunks,sealing:snapshotSealing(verification.sealing)};
  }
  if (!target || typeof target.load !== 'function' || typeof target.begin !== 'function' || typeof target.apply !== 'function' || typeof target.finish !== 'function') throw Error('Invalid archive destination');
  const e = expected(scope,commitment,envelopeDigest,signal), k = await key(bucket,kms,e,signal);
  const protection=await verifyProtection(bucket,{e,k},signal,selected?.sealing??null);
  const protectionContext={e,k,...(protection?{sealingHeadDigest:protection.sealingHeadDigest}:{})};
  async function ensureProtection() { return verifyProtection(bucket,protectionContext,signal,selected?.sealing??null); }
  const seal = await readRecord(bucket,k,e,'seal',0,signal);
  const identityDigest = await sha(bytes(JSON.stringify(['mapi-archive-restore-identity-v1',...identity(e)])));
  const sealDigest = await sha(seal.plaintext);
  let verificationHeadDigest = null, verifiedInventory = null;
  async function ensureAuthority() {
    if (!selected) return;
    const current = await authorityRead(selected.authority,selected.jobId,signal); checkSignal(signal);
    if (!sameJson(current,selected.head)) throw Error('Verification authority head changed; destination requires reconciliation');
  }
  if (selected) {
    const parsed=parseCanonical(seal.plaintext), prefixSeal=['mapi-archive-seal-v1',...identity(e)];
    if (!Array.isArray(parsed) || parsed.length!==prefixSeal.length+1 || !sameJson(parsed.slice(0,-1),prefixSeal) || !isDigest(parsed.at(-1))) throw Error('Invalid archive seal');
    const context={...protectionContext,identityDigest,sealDigest,inventoryDigest:parsed.at(-1)};
    if (protection && (protection.sealDigest!==sealDigest || protection.inventoryDigest!==context.inventoryDigest)) throw Error('Sealing authorization differs');
    const state=await loadVerification(bucket,context,selected.authority,selected.jobId,selected.head,signal);
    if (state.phase!=='complete') throw Error('Verification is incomplete');
    verificationHeadDigest=await sha(bytes(JSON.stringify(selected.head))); verifiedInventory=state.inventoryDigest;
  }
  let cp = await destinationRead(target,signal); checkSignal(signal);
  if (cp === null) {
    let inventoryDigest = verifiedInventory;
    if (!selected) {
      inventoryDigest = await scan(bucket,k,e,signal);
      await selectors(bucket,e,'chunk',e.commitment.chunkCount,signal);
      await selectors(bucket,e,'part',e.commitment.chunkCount*2,signal);
      await selectors(bucket,e,'seal',1,signal);
      if (!equal(seal.plaintext,bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(e),inventoryDigest])))) throw Error('Archive seal differs');
    }
    cp = {identityDigest,sealDigest,inventoryDigest,next:0,previous:'',inventory:'',table:0,complete:false,...(selected?{verificationHeadDigest}:{})};
    checkSignal(signal); await ensureProtection(); await ensureAuthority(); await destinationWrite(() => target.begin({...cp})); await ensureAuthority(); await ensureProtection(); checkSignal(signal);
    cp = await destinationRead(target,signal); checkSignal(signal);
  }
  const c = e.commitment;
  function checkCheckpoint(value) {
    if (!value || (selected ? value.verificationHeadDigest !== verificationHeadDigest : Object.hasOwn(value,'verificationHeadDigest')) || value.identityDigest !== identityDigest || value.sealDigest !== sealDigest || !isDigest(value.inventoryDigest) ||
        !Number.isSafeInteger(value.next) || value.next < 0 || value.next > c.chunkCount ||
        !Number.isSafeInteger(value.table) || value.table < 0 || value.table > c.tables.length || typeof value.complete !== 'boolean' ||
        (value.next === 0 ? value.previous !== '' || value.inventory !== '' || value.table !== 0 : !isDigest(value.previous) || !isDigest(value.inventory)) ||
        (value.complete && value.next !== c.chunkCount) ||
        !equal(seal.plaintext,bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(e),value.inventoryDigest])))) throw Error('Invalid archive restore checkpoint');
  }
  checkCheckpoint(cp);
  let applied=0;
  while (cp.next < c.chunkCount) {
    if (selected && applied>=selected.maxChunks) { await ensureAuthority(); await ensureProtection(); await ensureAuthority(); return {complete:false,next:cp.next,chunkCount:c.chunkCount}; }
    if (cp.complete || cp.table >= c.tables.length) throw Error('Invalid archive restore checkpoint');
    const i = cp.next, r = await readChunk(bucket,k,e,i,signal), p = sourceChunk(r.plaintext,e,i);
    if (p.prev !== cp.previous || p.table !== c.tables[cp.table] || p.done !== (i === c.chunkCount-1) || (p.done && !p.last)) throw Error('Archive chain differs');
    const table = cp.table + (p.last ? 1 : 0);
    if (table > c.tables.length || (i < c.chunkCount-1 && table >= c.tables.length)) throw Error('Archive table order differs');
    const inventory = await sha(bytes(JSON.stringify(['mapi-archive-inventory-v1',cp.inventory,i,r.selectorDigest,r.recordDigest])));
    const next = {...cp,next:i+1,previous:r.digest,inventory,table};
    // Do not race cancellation against an in-flight destination transaction.
    checkSignal(signal); await ensureProtection(); await ensureAuthority(); await destinationWrite(() => target.apply({expected:{...cp},next:{...next},content:dec.decode(r.plaintext),index:i,digest:r.digest,selectorDigest:r.selectorDigest,recordDigest:r.recordDigest}));
    await ensureAuthority(); await ensureProtection(); checkSignal(signal); const actual = await destinationRead(target,signal); checkSignal(signal);
    if (JSON.stringify(actual) !== JSON.stringify(next)) throw Error('Archive restore checkpoint differs');
    cp = actual; applied++;
  }
  if (cp.previous !== c.finalDigest || cp.table !== c.tables.length || cp.inventory !== cp.inventoryDigest) throw Error('Archive restore commitment differs');
  // Listing is not an atomic snapshot: a separately enforced write closure is
  // still required before this staged result can be trusted operationally.
  if (!selected) {
    await selectors(bucket,e,'chunk',c.chunkCount,signal);
    await selectors(bucket,e,'part',c.chunkCount*2,signal);
    await selectors(bucket,e,'seal',1,signal);
  }
  if (!cp.complete) {
    checkSignal(signal); await ensureProtection(); await ensureAuthority(); await destinationWrite(() => target.finish({...cp})); await ensureAuthority(); await ensureProtection(); checkSignal(signal);
    const actual = await destinationRead(target,signal); checkSignal(signal);
    if (JSON.stringify(actual) !== JSON.stringify({...cp,complete:true})) throw Error('Archive restore completion differs');
    cp = actual;
  }
  await ensureAuthority();
  await ensureProtection();
  await ensureAuthority();
  return {...(selected?{complete:true}:{}),chunkCount:c.chunkCount,finalDigest:c.finalDigest,inventoryDigest:cp.inventoryDigest};
}

// Incremental archive-only verification. `authority` is a required external,
// authenticated, linearizable and nonrollback head store, independent of the
// archive and destination. Passing an untrusted or rewindable implementation
// cannot establish freshness. The caller must retain the returned head in a
// separate trusted operator/control record and supply it on every advance.
// These methods do not provide a production authority or activate a route.
function verificationHead(jobId,identityDigest,sealDigest,revision,parentDigest,role,result,sealingHeadDigest,terminal=false) {
  return {version:2,jobId,identityDigest,sealDigest,revision,parentDigest,terminal,role,digest:result.digest,recordDigest:result.recordDigest,...(sealingHeadDigest?{sealingHeadDigest}:{})};
}
function checkAuthority(a) {
  if (!a || typeof a.read !== 'function' || typeof a.create !== 'function' || typeof a.compareAndSwap !== 'function') throw Error('Independent verification authority required');
}
function checkReadAuthority(a) {
  if (!a || typeof a.read !== 'function') throw Error('Independent verification authority required');
}
function checkHead(head,jobId,identityDigest,sealDigest,sealingHeadDigest) {
  const keys=['version','jobId','identityDigest','sealDigest','revision','parentDigest','terminal','role','digest','recordDigest'];
  if (sealingHeadDigest) keys.push('sealingHeadDigest');
  if (!head || typeof head !== 'object' || Array.isArray(head) || Object.keys(head).length!==keys.length || keys.some(k=>!Object.hasOwn(head,k)) ||
      head.version!==2 || head.jobId!==jobId || head.identityDigest!==identityDigest || head.sealDigest!==sealDigest || typeof head.terminal!=='boolean' || (sealingHeadDigest && head.sealingHeadDigest!==sealingHeadDigest) ||
      !Number.isSafeInteger(head.revision) || head.revision<0 || (head.revision===0 ? head.parentDigest!=='' || head.terminal : !isDigest(head.parentDigest)) || !isDigest(head.digest) || !isDigest(head.recordDigest) ||
      typeof head.role!=='string' || !new RegExp(`^verify-${jobId}-[0-9a-f]{32}$`).test(head.role)) throw Error('Invalid verification authority head');
}
function sameJson(a,b) { return JSON.stringify(a)===JSON.stringify(b); }
function snapshotSealing(sealing) {
  if (sealing===null || sealing===undefined) return null;
  if (!sealing || typeof sealing!=='object' || typeof sealing.jobId!=='string' || !/^[0-9a-f]{32}$/.test(sealing.jobId)) throw Error('Invalid sealing authorization');
  checkReadAuthority(sealing.authority);
  return {authority:sealing.authority,jobId:sealing.jobId,head:JSON.parse(JSON.stringify(sealing.head))};
}
async function verifyProtection(bucket,context,signal,sealing) {
  if (!sealing) {await requireLegacyMode(bucket,context.e,signal);return null;}
  await requireSealingMode(bucket,context.e,signal);
  const identityDigest=await sha(bytes(JSON.stringify(['mapi-archive-sealing-identity-v1',...identity(context.e)])));
  const sealed=await loadSealing(bucket,{e:context.e,k:context.k,identityDigest},sealing.authority,sealing.jobId,sealing.head,signal);
  if (sealed.phase!=='complete' || !sealing.head.terminal) throw Error('Sealing authorization incomplete');
  const record=await readRecord(bucket,context.k,context.e,'seal',0,signal), expectedSeal=bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(context.e),sealed.inventory]));
  if (!equal(record.plaintext,expectedSeal) || record.digest!==sealed.sealDigest || !sameJson(await authorityRead(sealing.authority,sealing.jobId,signal),sealing.head)) throw Error('Sealing authorization differs');
  await requireSealingMode(bucket,context.e,signal); checkSignal(signal);
  const sealingHeadDigest=await sha(bytes(JSON.stringify(sealing.head)));
  if (context.sealingHeadDigest && context.sealingHeadDigest!==sealingHeadDigest) throw Error('Sealing authorization differs');
  // Mode I/O and digesting yield after the preceding sealing-head read. A
  // failure here requires reconciliation; it does not prove atomicity with
  // a subsequent read of a separate verification authority.
  await requireCurrentHead(sealing.authority,sealing.jobId,sealing.head,signal);
  return {sealingHeadDigest,sealDigest:sealed.sealDigest,inventoryDigest:sealed.inventory};
}
async function verificationContext(bucket,kms,scope,commitment,envelopeDigest,signal,sealing=null) {
  const e=expected(scope,commitment,envelopeDigest,signal), k=await key(bucket,kms,e,signal);
  const protection=await verifyProtection(bucket,{e,k},signal,sealing);
  const seal=await readRecord(bucket,k,e,'seal',0,signal);
  const parsed=parseCanonical(seal.plaintext), prefix=['mapi-archive-seal-v1',...identity(e)];
  if (!Array.isArray(parsed) || parsed.length!==prefix.length+1 || !sameJson(parsed.slice(0,-1),prefix) || !isDigest(parsed.at(-1))) throw Error('Invalid archive seal');
  const context={e,k,sealDigest:await sha(seal.plaintext),identityDigest:await sha(bytes(JSON.stringify(['mapi-archive-restore-identity-v1',...identity(e)]))),inventoryDigest:parsed.at(-1),...(protection?{sealingHeadDigest:protection.sealingHeadDigest}:{})};
  if (protection && (protection.sealDigest!==context.sealDigest || protection.inventoryDigest!==context.inventoryDigest)) throw Error('Sealing authorization differs');
  return context;
}
async function verificationRecord(bucket,context,jobId,state,signal) {
  const role=`verify-${jobId}-${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const result=await writeRecord(bucket,context.k,context.e,role,0,bytes(JSON.stringify(state)),signal);
  return {role,result};
}
async function authorityRead(authority,jobId,signal) {
  // A read can be abandoned on cancellation, but this does not cancel the RPC.
  // Mutating authority calls are deliberately awaited separately: a timed-out
  // create or compare-and-swap may still commit and must be reconciled.
  try { return await wait(() => authority.read(jobId), signal); }
  catch { throw Error(signal.aborted ? 'Archive operation canceled' : 'Archive authority unavailable'); }
}
// A successful CAS may already have committed when this check fails. Callers
// must reread the authoritative head and reconcile; do not infer rollback.
async function requireCurrentHead(authority,jobId,expected,signal) {
  let observed;
  try { observed=await authorityRead(authority,jobId,signal); }
  catch { throw Error('Archive authority outcome uncertain; reconciliation required'); }
  if (signal.aborted || !sameJson(observed,expected)) throw Error('Archive authority outcome uncertain; reconciliation required');
}
async function acceptAuthorityWrite(authority,jobId,write,intended,signal) {
  let error;
  try { await write(); } catch (e) { error=e; }
  // Resolve a lost acknowledgment only through the authority's current head.
  let observed;
  try { observed=await authorityRead(authority,jobId,signal); } catch { throw Error('Verification authority outcome uncertain'); }
  if (signal.aborted) throw Error('Verification authority outcome uncertain');
  if (!sameJson(observed,intended)) throw Error(error ? 'Verification authority outcome uncertain' : 'Verification authority head conflicts');
  return intended;
}
export async function beginSyntheticVerification(bucket,kms,scope,commitment,envelopeDigest,signal,authority,jobId,sealing=null) {
  checkAuthority(authority);
  if (typeof jobId!=='string' || !/^[0-9a-f]{32}$/.test(jobId)) throw Error('Invalid verification job');
  sealing=snapshotSealing(sealing);
  const context=await verificationContext(bucket,kms,scope,commitment,envelopeDigest,signal,sealing);
  if (await authorityRead(authority,jobId,signal)!==null) throw Error('Verification job already exists');
  const state={version:1,jobId,identityDigest:context.identityDigest,sealDigest:context.sealDigest,inventoryDigest:context.inventoryDigest,revision:0,parentDigest:'',phase:'chunks',next:0,previous:'',inventory:'',table:0,seen:0,cursor:null,pages:0,...(context.sealingHeadDigest?{sealingHeadDigest:context.sealingHeadDigest}:{})};
  const {role,result}=await verificationRecord(bucket,context,jobId,state,signal);
  const head=verificationHead(jobId,context.identityDigest,context.sealDigest,0,'',role,result,context.sealingHeadDigest);
  checkSignal(signal); await verifyProtection(bucket,context,signal,sealing);
  await acceptAuthorityWrite(authority,jobId,()=>authority.create(jobId,head),head,signal);
  await verifyProtection(bucket,context,signal,sealing);
  await requireCurrentHead(authority,jobId,head,signal); return head;
}
async function loadVerification(bucket,context,authority,jobId,pinnedHead,signal) {
  checkHead(pinnedHead,jobId,context.identityDigest,context.sealDigest,context.sealingHeadDigest);
  const current=await authorityRead(authority,jobId,signal); checkSignal(signal);
  if (!sameJson(current,pinnedHead)) throw Error('Verification authority head differs');
  const record=await readRecord(bucket,context.k,context.e,pinnedHead.role,0,signal), state=parseCanonical(record.plaintext);
  if (record.digest!==pinnedHead.digest || record.recordDigest!==pinnedHead.recordDigest || !state || state.version!==1 || state.jobId!==jobId ||
      state.identityDigest!==context.identityDigest || state.sealDigest!==context.sealDigest || state.inventoryDigest!==context.inventoryDigest || state.sealingHeadDigest!==context.sealingHeadDigest || state.revision!==pinnedHead.revision || state.parentDigest!==pinnedHead.parentDigest ||
      !['chunks','chunk-selectors','part-selectors','seal-selectors','complete'].includes(state.phase) || pinnedHead.terminal!==(state.phase==='complete') || !Number.isSafeInteger(state.next) || state.next<0 || state.next>context.e.commitment.chunkCount ||
      !Number.isSafeInteger(state.table) || state.table<0 || state.table>context.e.commitment.tables.length || !Number.isSafeInteger(state.seen) || state.seen<0 || !Number.isSafeInteger(state.pages) || state.pages<0 ||
      !(state.cursor===null || (typeof state.cursor==='string' && state.cursor.length>0 && state.cursor.length<=2048)) ||
      (state.next===0 ? state.previous!=='' || state.inventory!=='' || state.table!==0 : !isDigest(state.previous) || !isDigest(state.inventory))) throw Error('Invalid verification checkpoint');
  const c=context.e.commitment;
  if (state.phase==='chunks') {
    if (state.next>=c.chunkCount || state.seen!==0 || state.cursor!==null || state.pages!==0) throw Error('Invalid verification checkpoint');
  } else {
    if (state.next!==c.chunkCount || state.previous!==c.finalDigest || state.inventory!==context.inventoryDigest || state.table!==c.tables.length) throw Error('Invalid verification checkpoint');
    if (state.phase==='complete') {
      if (state.seen!==0 || state.cursor!==null || state.pages!==0) throw Error('Invalid verification checkpoint');
    } else {
      const count=state.phase==='chunk-selectors'?c.chunkCount:state.phase==='part-selectors'?c.chunkCount*2:1;
      if (state.seen>count || state.pages>count+1025 || (state.cursor===null ? state.pages!==0 || state.seen!==0 : state.pages<1)) throw Error('Invalid verification checkpoint');
    }
  }
  return state;
}
export async function advanceSyntheticVerification(bucket,kms,scope,commitment,envelopeDigest,signal,authority,jobId,pinnedHead,maxChunks=4,sealing=null) {
  checkAuthority(authority);
  if (typeof jobId!=='string' || !/^[0-9a-f]{32}$/.test(jobId) || !Number.isSafeInteger(maxChunks) || maxChunks<1 || maxChunks>8) throw Error('Invalid verification request');
  pinnedHead=JSON.parse(JSON.stringify(pinnedHead));
  sealing=snapshotSealing(sealing);
  const context=await verificationContext(bucket,kms,scope,commitment,envelopeDigest,signal,sealing), c=context.e.commitment;
  const state=await loadVerification(bucket,context,authority,jobId,pinnedHead,signal);
  if (state.phase==='complete') {await verifyProtection(bucket,context,signal,sealing);await requireCurrentHead(authority,jobId,pinnedHead,signal);return {head:pinnedHead,complete:true,inventoryDigest:state.inventoryDigest};}
  const next={...state,revision:state.revision+1,parentDigest:await sha(bytes(JSON.stringify(pinnedHead)))};
  if (!Number.isSafeInteger(next.revision)) throw Error('Verification revision exhausted');
  if (state.phase==='chunks') {
    for (let n=0;n<maxChunks && next.next<c.chunkCount;n++) {
      const i=next.next, record=await readChunk(bucket,context.k,context.e,i,signal), p=sourceChunk(record.plaintext,context.e,i);
      if (p.prev!==next.previous || p.table!==c.tables[next.table] || p.done!==(i===c.chunkCount-1) || (p.done && !p.last)) throw Error('Archive chain differs');
      next.table+=p.last?1:0;
      if (next.table>c.tables.length || (i<c.chunkCount-1 && next.table>=c.tables.length)) throw Error('Archive table order differs');
      next.previous=record.digest; next.inventory=await sha(bytes(JSON.stringify(['mapi-archive-inventory-v1',next.inventory,i,record.selectorDigest,record.recordDigest]))); next.next++;
    }
    if (next.next===c.chunkCount) {
      if (next.previous!==c.finalDigest || next.table!==c.tables.length || next.inventory!==context.inventoryDigest) throw Error('Archive commitment differs');
      next.phase='chunk-selectors'; next.seen=0; next.cursor=null; next.pages=0;
    }
  } else {
    const role=state.phase==='chunk-selectors'?'chunk':state.phase==='part-selectors'?'part':'seal';
    const count=role==='chunk'?c.chunkCount:role==='part'?c.chunkCount*2:1;
    const base=`${prefix(context.e)}/${role}-selector/`;
    const page=inventoryPage(await wait(()=>bucket.list({prefix:base,limit:1000,...(state.cursor?{cursor:state.cursor}:{})}),signal));
    if (state.pages>count+1024) throw Error('Invalid archive inventory');
    for (const key of page.keys) {
      const suffix=selectorSuffix(key,base);
      if (!/^\d{16}$/.test(suffix) || suffix!==String(next.seen).padStart(16,'0') || next.seen>=count) throw Error('Unexpected archive selector');
      next.seen++;
    }
    next.pages++;
    if (page.truncated) {
      if (typeof page.cursor!=='string' || !page.cursor || page.cursor.length>2048 || page.cursor===state.cursor) throw Error('Invalid archive inventory cursor');
      next.cursor=page.cursor;
    } else {
      if (next.seen!==count) throw Error('Archive inventory incomplete');
      next.phase=role==='chunk'?'part-selectors':role==='part'?'seal-selectors':'complete'; next.cursor=null; next.seen=0; next.pages=0;
    }
  }
  checkSignal(signal);
  const {role,result}=await verificationRecord(bucket,context,jobId,next,signal);
  const head=verificationHead(jobId,context.identityDigest,context.sealDigest,next.revision,next.parentDigest,role,result,context.sealingHeadDigest,next.phase==='complete');
  checkSignal(signal); await verifyProtection(bucket,context,signal,sealing);
  await acceptAuthorityWrite(authority,jobId,()=>authority.compareAndSwap(jobId,pinnedHead,head),head,signal);
  await verifyProtection(bucket,context,signal,sealing);
  await requireCurrentHead(authority,jobId,head,signal);
  return {head,complete:next.phase==='complete',inventoryDigest:next.inventoryDigest};
}

// Synthetic-only bounded sealing. The source commitment and current head must
// be authenticated outside this archive. Before beginning, an independent
// authority must close all chunk/part writers and prevent deletion or rollback;
// it must enforce one active sealing job per archive, monotonic predecessor-
// bound heads and terminal completion. These APIs cannot establish those facts.
// The seal uses exactly the legacy wire format. A committed seal on its own is
// not proof that the independent authority accepted the completed head.
function sealingHead(jobId,identityDigest,revision,parentDigest,terminal,role,result) {
  return {version:1,jobId,identityDigest,revision,parentDigest,terminal,role,digest:result.digest,recordDigest:result.recordDigest};
}
function checkSealingHead(head,jobId,identityDigest) {
  const fields=['version','jobId','identityDigest','revision','parentDigest','terminal','role','digest','recordDigest'];
  if (!head || typeof head!=='object' || Array.isArray(head) || Object.keys(head).length!==fields.length || fields.some(k=>!Object.hasOwn(head,k)) ||
      head.version!==1 || head.jobId!==jobId || head.identityDigest!==identityDigest || !Number.isSafeInteger(head.revision) || head.revision<0 ||
      (head.revision===0 ? head.parentDigest!=='' || head.terminal : !isDigest(head.parentDigest)) || typeof head.terminal!=='boolean' || !isDigest(head.digest) || !isDigest(head.recordDigest) ||
      typeof head.role!=='string' || !new RegExp(`^sealing-${jobId}-[0-9a-f]{32}$`).test(head.role)) throw Error('Invalid sealing authority head');
}
async function sealingContext(bucket,kms,scope,commitment,envelopeDigest,signal) {
  const e=expected(scope,commitment,envelopeDigest,signal), k=await key(bucket,kms,e,signal);
  return {e,k,identityDigest:await sha(bytes(JSON.stringify(['mapi-archive-sealing-identity-v1',...identity(e)])))};
}
async function sealingRecord(bucket,context,jobId,state,signal) {
  const role=`sealing-${jobId}-${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const result=await writeRecord(bucket,context.k,context.e,role,0,bytes(JSON.stringify(state)),signal);
  return {role,result};
}
async function loadSealing(bucket,context,authority,jobId,pinnedHead,signal) {
  checkSealingHead(pinnedHead,jobId,context.identityDigest);
  const current=await authorityRead(authority,jobId,signal); checkSignal(signal);
  if (!sameJson(current,pinnedHead)) throw Error('Sealing authority head differs');
  const record=await readRecord(bucket,context.k,context.e,pinnedHead.role,0,signal), state=parseCanonical(record.plaintext);
  const c=context.e.commitment, fields=['version','jobId','identityDigest','revision','parentDigest','phase','next','previous','inventory','table','seen','cursor','pages','sealDigest','sealRecordDigest'];
  if (record.digest!==pinnedHead.digest || record.recordDigest!==pinnedHead.recordDigest || !state || typeof state!=='object' || Array.isArray(state) ||
      Object.keys(state).length!==fields.length || fields.some(k=>!Object.hasOwn(state,k)) || state.version!==1 || state.jobId!==jobId || state.identityDigest!==context.identityDigest ||
      state.revision!==pinnedHead.revision || state.parentDigest!==pinnedHead.parentDigest || !['chunks','chunk-selectors','part-selectors','ready','complete'].includes(state.phase) ||
      pinnedHead.terminal!==(state.phase==='complete') ||
      !Number.isSafeInteger(state.next) || state.next<0 || state.next>c.chunkCount || !Number.isSafeInteger(state.table) || state.table<0 || state.table>c.tables.length ||
      !Number.isSafeInteger(state.seen) || state.seen<0 || !Number.isSafeInteger(state.pages) || state.pages<0 ||
      !(state.cursor===null || (typeof state.cursor==='string' && state.cursor.length>0 && state.cursor.length<=2048)) ||
      (state.next===0 ? state.previous!=='' || state.inventory!=='' || state.table!==0 : !isDigest(state.previous) || !isDigest(state.inventory)) ||
      (state.phase==='complete' ? !isDigest(state.sealDigest) : state.sealDigest!=='') || state.sealRecordDigest!=='') throw Error('Invalid sealing checkpoint');
  if (state.phase==='chunks') {
    if (state.next>=c.chunkCount || state.seen!==0 || state.cursor!==null || state.pages!==0) throw Error('Invalid sealing checkpoint');
  } else {
    if (state.next!==c.chunkCount || state.previous!==c.finalDigest || state.table!==c.tables.length) throw Error('Invalid sealing checkpoint');
    if (state.phase==='ready' || state.phase==='complete') {
      if (state.seen!==0 || state.cursor!==null || state.pages!==0) throw Error('Invalid sealing checkpoint');
    } else {
      const count=state.phase==='chunk-selectors'?c.chunkCount:c.chunkCount*2;
      if (state.seen>count || state.pages>count+1025 || (state.cursor===null ? state.pages!==0 || state.seen!==0 : state.pages<1)) throw Error('Invalid sealing checkpoint');
    }
  }
  if (state.phase==='complete' && state.sealDigest!==await sha(bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(context.e),state.inventory])))) throw Error('Invalid sealing checkpoint');
  return state;
}
export async function beginSyntheticSealing(bucket,kms,scope,commitment,envelopeDigest,signal,authority,jobId) {
  checkAuthority(authority);
  if (typeof jobId!=='string' || !/^[0-9a-f]{32}$/.test(jobId)) throw Error('Invalid sealing job');
  const context=await sealingContext(bucket,kms,scope,commitment,envelopeDigest,signal);
  if (await authorityRead(authority,jobId,signal)!==null) throw Error('Sealing job already exists');
  if (await readRecord(bucket,context.k,context.e,'seal',0,signal,true)!==null) throw Error('Archive already has a seal');
  await selectors(bucket,context.e,'seal',0,signal);
  // Persist the authority-required mode before creating the sealing job. A
  // failed or uncertain create leaves the archive closed to legacy consumers.
  // Exclusive writer drain and nonrollback storage remain external contracts.
  await putArchiveObject(bucket,name(context.e,'sealing-mode',0),sealingMode(context.e),MAX_RECORD,signal);
  await requireSealingMode(bucket,context.e,signal);
  const state={version:1,jobId,identityDigest:context.identityDigest,revision:0,parentDigest:'',phase:'chunks',next:0,previous:'',inventory:'',table:0,seen:0,cursor:null,pages:0,sealDigest:'',sealRecordDigest:''};
  const {role,result}=await sealingRecord(bucket,context,jobId,state,signal), head=sealingHead(jobId,context.identityDigest,0,'',false,role,result);
  checkSignal(signal);
  await acceptAuthorityWrite(authority,jobId,()=>authority.create(jobId,head),head,signal);
  await requireSealingMode(bucket,context.e,signal);
  await requireCurrentHead(authority,jobId,head,signal); return head;
}
export async function advanceSyntheticSealing(bucket,kms,scope,commitment,envelopeDigest,signal,authority,jobId,pinnedHead,maxChunks=4) {
  checkAuthority(authority);
  if (typeof jobId!=='string' || !/^[0-9a-f]{32}$/.test(jobId) || !Number.isSafeInteger(maxChunks) || maxChunks<1 || maxChunks>8) throw Error('Invalid sealing request');
  pinnedHead=JSON.parse(JSON.stringify(pinnedHead));
  const context=await sealingContext(bucket,kms,scope,commitment,envelopeDigest,signal), c=context.e.commitment;
  await requireSealingMode(bucket,context.e,signal);
  const state=await loadSealing(bucket,context,authority,jobId,pinnedHead,signal);
  if (state.phase==='complete') {
    // The independent terminal head has authorized this exact seal before it
    // becomes visible to legacy readers. Publication may be interrupted or
    // committed without its acknowledgement; repeat only this exact content.
    if (!sameJson(await authorityRead(authority,jobId,signal),pinnedHead)) throw Error('Sealing authority head differs');
    checkSignal(signal);
    const content=bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(context.e),state.inventory]));
    await writeRecord(bucket,context.k,context.e,'seal',0,content,signal);
    const seal=await readRecord(bucket,context.k,context.e,'seal',0,signal);
    await selectors(bucket,context.e,'seal',1,signal);
    if (!equal(seal.plaintext,content) || seal.digest!==state.sealDigest || !sameJson(await authorityRead(authority,jobId,signal),pinnedHead)) throw Error('Sealing completion differs; outcome requires reconciliation');
    await requireSealingMode(bucket,context.e,signal); checkSignal(signal); await requireCurrentHead(authority,jobId,pinnedHead,signal); return {head:pinnedHead,complete:true,inventoryDigest:state.inventory,sealDigest:state.sealDigest};
  }
  const next={...state,revision:state.revision+1,parentDigest:await sha(bytes(JSON.stringify(pinnedHead)))};
  if (!Number.isSafeInteger(next.revision)) throw Error('Sealing revision exhausted');
  if (state.phase==='chunks') {
    for (let n=0;n<maxChunks && next.next<c.chunkCount;n++) {
      const i=next.next, record=await readChunk(bucket,context.k,context.e,i,signal), p=sourceChunk(record.plaintext,context.e,i);
      if (p.prev!==next.previous || p.table!==c.tables[next.table] || p.done!==(i===c.chunkCount-1) || (p.done && !p.last)) throw Error('Archive chain differs');
      next.table+=p.last?1:0;
      if (next.table>c.tables.length || (i<c.chunkCount-1 && next.table>=c.tables.length)) throw Error('Archive table order differs');
      next.previous=record.digest; next.inventory=await sha(bytes(JSON.stringify(['mapi-archive-inventory-v1',next.inventory,i,record.selectorDigest,record.recordDigest]))); next.next++;
    }
    if (next.next===c.chunkCount) {
      if (next.previous!==c.finalDigest || next.table!==c.tables.length) throw Error('Archive commitment differs');
      next.phase='chunk-selectors'; next.seen=0; next.cursor=null; next.pages=0;
    }
  } else if (state.phase==='chunk-selectors' || state.phase==='part-selectors') {
    const role=state.phase==='chunk-selectors'?'chunk':'part', count=role==='chunk'?c.chunkCount:c.chunkCount*2;
    const base=`${prefix(context.e)}/${role}-selector/`;
    const page=inventoryPage(await wait(()=>bucket.list({prefix:base,limit:1000,...(state.cursor?{cursor:state.cursor}:{})}),signal));
    if (state.pages>count+1024) throw Error('Invalid archive inventory');
    for (const key of page.keys) {
      const suffix=selectorSuffix(key,base);
      if (!/^\d{16}$/.test(suffix) || suffix!==String(next.seen).padStart(16,'0') || next.seen>=count) throw Error('Unexpected archive selector');
      next.seen++;
    }
    next.pages++;
    if (page.truncated) {
      if (typeof page.cursor!=='string' || !page.cursor || page.cursor.length>2048 || page.cursor===state.cursor) throw Error('Invalid archive inventory cursor');
      next.cursor=page.cursor;
    } else {
      if (next.seen!==count) throw Error('Archive inventory incomplete');
      next.phase=role==='chunk'?'part-selectors':'ready'; next.cursor=null; next.seen=0; next.pages=0;
    }
  } else {
    // Commit the terminal authority before publication. A failed or uncertain
    // CAS must never leave a normal-format seal visible to legacy readers.
    next.phase='complete'; next.sealDigest=await sha(bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(context.e),state.inventory])));
  }
  checkSignal(signal); await requireSealingMode(bucket,context.e,signal);
  const {role,result}=await sealingRecord(bucket,context,jobId,next,signal), head=sealingHead(jobId,context.identityDigest,next.revision,next.parentDigest,next.phase==='complete',role,result);
  checkSignal(signal); await requireSealingMode(bucket,context.e,signal);
  await acceptAuthorityWrite(authority,jobId,()=>authority.compareAndSwap(jobId,pinnedHead,head),head,signal);
  await requireSealingMode(bucket,context.e,signal);
  await requireCurrentHead(authority,jobId,head,signal);
  return {head,complete:false,...(next.phase==='complete'?{readyToPublish:true}:{})};
}

// Authority-gated, synthetic-only consumer for a bounded sealing job. This is
// deliberately distinct from the legacy verifier, which does not consult the
// sealing authority. The authority must authenticate and enforce a terminal,
// nonrollback head independently; the caller must pin that head independently.
// Namespace write closure and nonrollback retention remain mandatory throughout
// both checks and the full legacy scan. This wrapper is itself one-call/unbounded.
export async function verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelopeDigest,signal,authority,jobId,pinnedHead) {
  checkReadAuthority(authority);
  if (typeof jobId!=='string' || !/^[0-9a-f]{32}$/.test(jobId)) throw Error('Invalid sealing job');
  pinnedHead=JSON.parse(JSON.stringify(pinnedHead));
  async function authorize() {
    const context=await sealingContext(bucket,kms,scope,commitment,envelopeDigest,signal);
    await requireSealingMode(bucket,context.e,signal);
    const state=await loadSealing(bucket,context,authority,jobId,pinnedHead,signal);
    if (state.phase!=='complete' || !pinnedHead.terminal) throw Error('Sealing authorization incomplete');
    const seal=await readRecord(bucket,context.k,context.e,'seal',0,signal);
    const expectedSeal=bytes(JSON.stringify(['mapi-archive-seal-v1',...identity(context.e),state.inventory]));
    if (!equal(seal.plaintext,expectedSeal) || seal.digest!==state.sealDigest || !sameJson(await authorityRead(authority,jobId,signal),pinnedHead)) throw Error('Sealing authorization differs');
    await requireSealingMode(bucket,context.e,signal); checkSignal(signal);
    await requireCurrentHead(authority,jobId,pinnedHead,signal);
    return {inventoryDigest:state.inventory,sealDigest:state.sealDigest};
  }
  const before=await authorize();
  const context=await sealingContext(bucket,kms,scope,commitment,envelopeDigest,signal);
  const result=await verifyArchiveCore(bucket,context.k,context.e,signal);
  const after=await authorize();
  if (!sameJson(before,after) || result.inventoryDigest!==before.inventoryDigest) throw Error('Sealing authorization differs');
  return {...result,sealDigest:before.sealDigest};
}
