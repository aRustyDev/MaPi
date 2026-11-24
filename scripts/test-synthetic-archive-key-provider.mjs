import assert from 'node:assert/strict';
import { mintSyntheticArchiveKey, openSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';

const KEY = 'arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const RUN = 'mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const scope = { keyArn: KEY, runId: RUN, archiveId: '1'.repeat(32), manifestDigest: '2'.repeat(64) };
const signal = () => new AbortController().signal;
const ready = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

class Bucket {
  objects = new Map();
  loseReservationAck = false;
  async put(key, value, options) {
    assert.equal(options.onlyIf.get('If-None-Match'), '*');
    if (this.objects.has(key)) return null;
    this.objects.set(key, new Uint8Array(value));
    if (this.loseReservationAck && key.endsWith('/reservation')) { this.loseReservationAck = false; throw Error('lost acknowledgment'); }
    return { key };
  }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.length, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }) };
  }
}

class FakeKMS {
  generated = 0;
  decryptions = 0;
  keys = new Map();
  async generateDataKey(request) {
    assert.deepEqual(request, { KeyId: KEY, KeySpec: 'AES_256', EncryptionContext: { purpose: 'mapi-phase1-synthetic-archive', run_id: RUN } });
    const index = ++this.generated, wrapped = new Uint8Array([55, index]);
    const key = new Uint8Array(32).fill(index + 160); this.keys.set(wrapped.toBase64(), key);
    return { KeyId: KEY, Plaintext: new Uint8Array(key), CiphertextBlob: wrapped };
  }
  async decrypt(request) {
    this.decryptions++;
    assert.equal(request.KeyId, KEY);
    assert.deepEqual(request.EncryptionContext, { purpose: 'mapi-phase1-synthetic-archive', run_id: RUN });
    const key = this.keys.get(request.CiphertextBlob.toBase64());
    if (!key) throw Error('unknown wrapped key');
    return { KeyId: KEY, Plaintext: new Uint8Array(key) };
  }
}

const bucket = new Bucket(), kms = new FakeKMS();
const minted = await mintSyntheticArchiveKey(bucket, kms, scope, signal());
assert.deepEqual(Object.keys(minted), ['provisionalEnvelopeDigest']);
assert.match(minted.provisionalEnvelopeDigest, /^[0-9a-f]{64}$/);
assert.equal(kms.generated, 1);
const key = await openSyntheticArchiveKey(bucket, kms, scope, minted.provisionalEnvelopeDigest, signal());
assert.equal(key.extractable, false); assert.equal(key.algorithm.name, 'AES-GCM');
await assert.rejects(() => crypto.subtle.exportKey('raw', key));
const sample = new Uint8Array([1, 2, 3]), iv = new Uint8Array(12).fill(17);
const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, sample);
assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted)), sample);
await assert.rejects(() => openSyntheticArchiveKey(bucket, kms, scope, '0'.repeat(64), signal()));
await assert.rejects(() => openSyntheticArchiveKey(bucket, kms, { ...scope, manifestDigest: '3'.repeat(64) }, minted.provisionalEnvelopeDigest, signal()));
await assert.rejects(() => mintSyntheticArchiveKey(bucket, kms, scope, signal()));
assert.equal(kms.generated, 1);

// A different archive's intact envelope cannot be accepted as this one.
const other = { ...scope, archiveId: '4'.repeat(32) };
const otherReceipt = await mintSyntheticArchiveKey(bucket, kms, other, signal());
const names = [...bucket.objects.keys()], wrapped1 = names.find(name => name.includes(scope.archiveId) && name.endsWith('/wrapped'));
const wrapped2 = names.find(name => name.includes(other.archiveId) && name.endsWith('/wrapped'));
const original = bucket.objects.get(wrapped1); bucket.objects.set(wrapped1, bucket.objects.get(wrapped2));
await assert.rejects(() => openSyntheticArchiveKey(bucket, kms, scope, minted.provisionalEnvelopeDigest, signal()));
await assert.rejects(() => openSyntheticArchiveKey(bucket, kms, scope, otherReceipt.provisionalEnvelopeDigest, signal()));
bucket.objects.set(wrapped1, original);

// An attacker can make a different valid envelope with the same scope if it
// can use KMS, but it cannot match the independently trusted original digest.
const forgedBucket = new Bucket();
const forged = await mintSyntheticArchiveKey(forgedBucket, kms, scope, signal());
const forgedName = [...forgedBucket.objects.keys()].find(name => name.endsWith('/wrapped'));
const beforeDecrypt = kms.decryptions;
bucket.objects.set(wrapped1, forgedBucket.objects.get(forgedName));
await assert.rejects(() => openSyntheticArchiveKey(bucket, kms, scope, minted.provisionalEnvelopeDigest, signal()));
assert.equal(kms.decryptions, beforeDecrypt); assert.notEqual(forged.provisionalEnvelopeDigest, minted.provisionalEnvelopeDigest);
bucket.objects.set(wrapped1, original);

// Simultaneous exact reservations generate only once, even while KMS is held.
const waiting = ready(), started = ready(), concurrentBucket = new Bucket(), concurrentKMS = new FakeKMS();
const realGenerate = concurrentKMS.generateDataKey.bind(concurrentKMS);
concurrentKMS.generateDataKey = async request => { started.resolve(); await waiting.promise; return realGenerate(request); };
const first = mintSyntheticArchiveKey(concurrentBucket, concurrentKMS, scope, signal()); await started.promise;
await assert.rejects(() => mintSyntheticArchiveKey(concurrentBucket, concurrentKMS, scope, signal()));
waiting.resolve(); await first; assert.equal(concurrentKMS.generated, 1);

// Caller mutation across storage and KMS awaits cannot retarget a slot or its
// authenticated metadata. The original validated primitive scope is retained.
const heldPutStarted = ready(), heldPutRelease = ready(), heldBucket = new Bucket(), heldKMS = new FakeKMS();
const originalPut = heldBucket.put.bind(heldBucket);
heldBucket.put = async (name, value, options) => { if (name.endsWith('/reservation')) { heldPutStarted.resolve(); await heldPutRelease.promise; } return originalPut(name, value, options); };
const mutableScope = { ...scope }, heldMint = mintSyntheticArchiveKey(heldBucket, heldKMS, mutableScope, signal());
await heldPutStarted.promise; mutableScope.archiveId = '5'.repeat(32); mutableScope.manifestDigest = '6'.repeat(64);
heldPutRelease.resolve(); const heldReceipt = await heldMint;
assert.equal((await openSyntheticArchiveKey(heldBucket, heldKMS, scope, heldReceipt.provisionalEnvelopeDigest, signal())).extractable, false);
await assert.rejects(() => openSyntheticArchiveKey(heldBucket, heldKMS, mutableScope, heldReceipt.provisionalEnvelopeDigest, signal()));

const heldGenStarted = ready(), heldGenRelease = ready(), genBucket = new Bucket(), genKMS = new FakeKMS();
const genReal = genKMS.generateDataKey.bind(genKMS);
genKMS.generateDataKey = async request => { heldGenStarted.resolve(); await heldGenRelease.promise; return genReal(request); };
const mutableGenScope = { ...scope }, genMint = mintSyntheticArchiveKey(genBucket, genKMS, mutableGenScope, signal());
await heldGenStarted.promise; mutableGenScope.archiveId = '7'.repeat(32); mutableGenScope.manifestDigest = '8'.repeat(64);
heldGenRelease.resolve(); const genReceipt = await genMint;
assert.equal((await openSyntheticArchiveKey(genBucket, genKMS, scope, genReceipt.provisionalEnvelopeDigest, signal())).extractable, false);

const heldReadStarted = ready(), heldReadRelease = ready(), originalGet = genBucket.get.bind(genBucket);
genBucket.get = async name => { if (name.endsWith('/wrapped')) { heldReadStarted.resolve(); await heldReadRelease.promise; } return originalGet(name); };
const mutableReadScope = { ...scope }, heldOpen = openSyntheticArchiveKey(genBucket, genKMS, mutableReadScope, genReceipt.provisionalEnvelopeDigest, signal());
await heldReadStarted.promise; mutableReadScope.archiveId = '9'.repeat(32); mutableReadScope.manifestDigest = 'a'.repeat(64);
heldReadRelease.resolve(); assert.equal((await heldOpen).extractable, false);

// An uncertain reservation acknowledgment never authorizes generation.
const uncertainBucket = new Bucket(), uncertainKMS = new FakeKMS(); uncertainBucket.loseReservationAck = true;
await assert.rejects(() => mintSyntheticArchiveKey(uncertainBucket, uncertainKMS, scope, signal()));
await assert.rejects(() => mintSyntheticArchiveKey(uncertainBucket, uncertainKMS, scope, signal()));
assert.equal(uncertainKMS.generated, 0);

// An uncertain generation leaves the immutable reservation and cannot regenerate.
const failedBucket = new Bucket(), failedKMS = new FakeKMS();
failedKMS.generateDataKey = async () => { failedKMS.generated++; throw Error('unknown generation outcome'); };
await assert.rejects(() => mintSyntheticArchiveKey(failedBucket, failedKMS, scope, signal()));
await assert.rejects(() => mintSyntheticArchiveKey(failedBucket, failedKMS, scope, signal()));
assert.equal(failedKMS.generated, 1);
await assert.rejects(() => openSyntheticArchiveKey(failedBucket, failedKMS, scope, minted.provisionalEnvelopeDigest, signal()));

// A late KMS plaintext result is wiped after the caller cancels.
const lateBucket = new Bucket(), lateStarted = ready(), lateResult = ready(), controller = new AbortController();
const latePlaintext = new Uint8Array(32).fill(199); let lateCalls = 0;
const lateKMS = { generateDataKey: async () => { lateCalls++; lateStarted.resolve(); return lateResult.promise; } };
const pending = mintSyntheticArchiveKey(lateBucket, lateKMS, scope, controller.signal); await lateStarted.promise;
controller.abort(); await assert.rejects(pending); lateResult.resolve({ KeyId: KEY, Plaintext: latePlaintext, CiphertextBlob: new Uint8Array([9]) });
await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(latePlaintext.every(value => value === 0));
await assert.rejects(() => mintSyntheticArchiveKey(lateBucket, lateKMS, scope, signal())); assert.equal(lateCalls, 1);

// The same late-response cleanup applies to KMS Decrypt on recovery.
const openStarted = ready(), openResult = ready(), openController = new AbortController();
const lateOpenPlaintext = new Uint8Array(32).fill(166);
const heldDecrypt = { decrypt: async () => { openStarted.resolve(); return openResult.promise; } };
const opening = openSyntheticArchiveKey(bucket, heldDecrypt, scope, minted.provisionalEnvelopeDigest, openController.signal);
await openStarted.promise; openController.abort(); await assert.rejects(opening);
openResult.resolve({ KeyId: KEY, Plaintext: lateOpenPlaintext }); await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(lateOpenPlaintext.every(value => value === 0));

console.log('Synthetic archive key provider tests passed; no archive or independent authority is proven.');
