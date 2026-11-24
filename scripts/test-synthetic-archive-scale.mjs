// Disposable archive-only scale test. No Nextgen owner, registry, Woven or AWS.
// The R2-like store, checkpoint authority, KMS and target below are local test
// doubles; none enforces independent custody, write closure or cloud limits.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, link, unlink, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import {
  archiveSyntheticChunk, beginSyntheticSealing, advanceSyntheticSealing,
  beginSyntheticVerification, advanceSyntheticVerification, restoreSyntheticArchive,
} from '../worker/synthetic-relocation-archive.js';

const keyArn = 'arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const runId = 'mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const chunks = 1024, chunkBytes = 128 * 1024;
const encoder = new TextEncoder();
const sha = value => createHash('sha256').update(value).digest('hex');
const signal = () => new AbortController().signal;
const root = await mkdtemp(path.join(tmpdir(), 'mapi-synthetic-archive-scale-'));
const metrics = { objects: 0, objectBytes: 0, maxObjectBytes: 0, reads: 0, readBytes: 0, selectedReads: new Map() };
const start = performance.now(), startCPU = process.cpuUsage();
let peakRSS = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRSS = Math.max(peakRSS, process.memoryUsage().rss); }, 25);

class Bucket {
  failAttempt = false;
  path(key) {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes('..')) throw Error('invalid synthetic object key');
    return path.join(root, 'objects', key);
  }
  async put(key, content, options) {
    assert.equal(options.onlyIf.get('If-None-Match'), '*');
    if (this.failAttempt && key.includes('/attempt/')) { this.failAttempt = false; throw Error('injected archive upload failure'); }
    const data = Buffer.from(content), destination = this.path(key), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    assert(data.length <= 128 * 1024, 'archive object exceeds 128 KiB');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(temporary, data, { flag: 'wx' });
    try { await link(temporary, destination); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    finally { await unlink(temporary); }
    metrics.objects++; metrics.objectBytes += data.length; metrics.maxObjectBytes = Math.max(metrics.maxObjectBytes, data.length);
    return { key };
  }
  async get(key) {
    let data;
    try { data = await readFile(this.path(key)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    metrics.reads++; metrics.readBytes += data.length;
    if (key.includes('/chunk-selector/')) metrics.selectedReads.set(key, (metrics.selectedReads.get(key) ?? 0) + 1);
    return { size: data.length, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(data)); controller.close(); } }) };
  }
  async list({ prefix, limit, cursor }) {
    let names;
    try { names = await readdir(this.path(prefix)); }
    catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
    names.sort();
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('invalid synthetic cursor');
    const objects = names.slice(offset, offset + limit).map(name => ({ key: prefix + name }));
    const next = offset + objects.length;
    return { objects, truncated: next < names.length, ...(next < names.length ? { cursor: String(next) } : {}) };
  }
}

class KMS {
  keys = new Map();
  async generateDataKey(request) {
    assert.equal(request.KeyId, keyArn);
    const plaintext = crypto.getRandomValues(new Uint8Array(32)), wrapped = crypto.getRandomValues(new Uint8Array(32));
    this.keys.set(wrapped.toBase64(), new Uint8Array(plaintext));
    return { KeyId: keyArn, Plaintext: plaintext, CiphertextBlob: wrapped };
  }
  async decrypt(request) {
    const key = this.keys.get(request.CiphertextBlob.toBase64());
    if (!key) throw Error('synthetic key unavailable');
    return { KeyId: keyArn, Plaintext: new Uint8Array(key) };
  }
}

// This authority persists only inside the disposable fixture. It is not an
// independently administered, authenticated or rollback-resistant authority.
class Authority {
  constructor() {
    this.db = new DatabaseSync(path.join(root, 'authority.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, head TEXT NOT NULL)');
    this.failAfterCommit = false;
    this.failRead = false;
  }
  close() { this.db.close(); }
  async read(id) {
    if (this.failRead) { this.failRead = false; throw Error('injected authority read failure'); }
    const row = this.db.prepare('SELECT head FROM jobs WHERE id=?').get(id);
    return row ? JSON.parse(row.head) : null;
  }
  async create(id, head) {
    assert.equal(head.revision, 0); assert.equal(head.parentDigest, '');
    this.db.prepare('INSERT INTO jobs VALUES (?,?)').run(id, JSON.stringify(head));
  }
  async compareAndSwap(id, prior, next) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      assert.deepEqual(await this.read(id), prior);
      assert.equal(next.revision, prior.revision + 1);
      assert.equal(next.parentDigest, sha(JSON.stringify(prior)));
      assert.notEqual(prior.terminal, true);
      this.db.prepare('UPDATE jobs SET head=? WHERE id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (this.failAfterCommit) { this.failAfterCommit = false; this.failRead = true; throw Error('injected lost authority acknowledgement'); }
  }
}

function sourceChunk(index, previous) {
  const value = {
    projectId: 'synthetic-archive-only', generation: 1, moveId: 'synthetic-archive-scale-move',
    index, prev: previous, table: 'synthetic_payloads', columns: ['id', 'payload'], offset: index,
    rows: [[`record-${index}`, '']], last: index === chunks - 1, done: index === chunks - 1, cursor: null,
  };
  const overhead = Buffer.byteLength(JSON.stringify(value));
  value.rows[0][1] = 'x'.repeat(chunkBytes - overhead);
  const content = JSON.stringify(value);
  assert.equal(Buffer.byteLength(content), chunkBytes);
  return content;
}

let authority, staged;
try {
  const sourceDigest = createHash('sha256');
  let previous = '';
  for (let i = 0; i < chunks; i++) {
    const content = sourceChunk(i, previous);
    sourceDigest.update(content); previous = sha(content);
  }
  const aggregateDigest = sourceDigest.digest('hex');
  const manifestDigest = sha(JSON.stringify({ projectId: 'synthetic-archive-only', table: 'synthetic_payloads', chunks }));
  const scope = { keyArn, runId, archiveId: randomBytes(16).toString('hex'), manifestDigest };
  const commitment = { projectId: 'synthetic-archive-only', origin: 'https://synthetic-archive.invalid', objectName: 'synthetic-source', generation: 1, moveId: 'synthetic-archive-scale-move', manifestDigest, tables: ['synthetic_payloads'], chunkCount: chunks, finalDigest: previous };
  let bucket = new Bucket();
  const kms = new KMS();
  const envelope = (await mintSyntheticArchiveKey(bucket, kms, scope, signal())).provisionalEnvelopeDigest;
  previous = '';
  const writeStarted = performance.now();
  for (let i = 0; i < chunks; i++) {
    const content = sourceChunk(i, previous);
    if (i === 10) {
      bucket.failAttempt = true;
      await assert.rejects(() => archiveSyntheticChunk(bucket, kms, scope, commitment, envelope, i, content, signal()));
      bucket = new Bucket();
    }
    await archiveSyntheticChunk(bucket, kms, scope, commitment, envelope, i, content, signal());
    previous = sha(content);
  }
  assert.equal(previous, commitment.finalDigest);
  const writeMs = performance.now() - writeStarted;
  authority = new Authority();
  const sealingJob = randomBytes(16).toString('hex');
  let sealHead = await beginSyntheticSealing(bucket, kms, scope, commitment, envelope, signal(), authority, sealingJob);
  const sealStarted = performance.now();
  let sealed, sealingSteps = 0, sealingResumeRevision = null, publicationFault = false;
  while (!sealed?.complete) {
    if (sealingSteps === 24) {
      const old = sealHead;
      authority.failAfterCommit = true;
      await assert.rejects(() => advanceSyntheticSealing(bucket, kms, scope, commitment, envelope, signal(), authority, sealingJob, old, 8));
      authority.close(); authority = new Authority(); bucket = new Bucket();
      sealHead = await authority.read(sealingJob);
      assert.equal(sealHead.revision, old.revision + 1);
      sealingResumeRevision = sealHead.revision;
    }
    if (sealed?.readyToPublish && !publicationFault) {
      bucket.failAttempt = true;
      await assert.rejects(() => advanceSyntheticSealing(bucket, kms, scope, commitment, envelope, signal(), authority, sealingJob, sealHead, 8));
      bucket = new Bucket(); publicationFault = true;
    }
    sealed = await advanceSyntheticSealing(bucket, kms, scope, commitment, envelope, signal(), authority, sealingJob, sealHead, 8);
    sealHead = sealed.head; sealingSteps++;
  }
  const sealMs = performance.now() - sealStarted;
  // The current archive format requires the published terminal sealing head
  // throughout verification and restore. This local authority is a test
  // double and does not establish independent custody or nonrollback storage.
  const sealing = { authority, jobId: sealingJob, head: sealHead };
  const verificationJob = randomBytes(16).toString('hex');
  let head = await beginSyntheticVerification(bucket, kms, scope, commitment, envelope, signal(), authority, verificationJob, sealing);
  const verifyStarted = performance.now();
  let verified, verificationSteps = 0, verificationResumeRevision = null;
  while (!verified?.complete) {
    if (verificationSteps === 32) {
      const old = head;
      authority.failAfterCommit = true;
      await assert.rejects(() => advanceSyntheticVerification(bucket, kms, scope, commitment, envelope, signal(), authority, verificationJob, old, 8, sealing));
      authority.close(); authority = new Authority(); bucket = new Bucket();
      sealing.authority = authority;
      head = await authority.read(verificationJob);
      assert.equal(head.revision, old.revision + 1);
      verificationResumeRevision = head.revision;
    }
    verified = await advanceSyntheticVerification(bucket, kms, scope, commitment, envelope, signal(), authority, verificationJob, head, 8, sealing);
    head = verified.head; verificationSteps++;
  }
  assert.equal(verified.inventoryDigest, sealed.inventoryDigest);
  const verifyMs = performance.now() - verifyStarted;

  function openStage() {
    const db = new DatabaseSync(path.join(root, 'target.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS chunks (idx INTEGER PRIMARY KEY, content TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoint (singleton INTEGER PRIMARY KEY, state TEXT NOT NULL)');
    return db;
  }
  staged = openStage();
  let rollbackFault = true, lostCommitAck = true, injectedFault = null;
  const target = {
    async load() { const row = staged.prepare('SELECT state FROM checkpoint WHERE singleton=1').get(); return row ? JSON.parse(row.state) : null; },
    async begin(cp) {
      staged.exec('BEGIN IMMEDIATE');
      try {
        assert.equal(staged.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0);
        staged.prepare('INSERT INTO checkpoint VALUES(1,?)').run(JSON.stringify(cp)); staged.exec('COMMIT');
      } catch (error) { staged.exec('ROLLBACK'); throw error; }
    },
    async apply({ expected, next, content, index, digest }) {
      assert.equal(sha(content), digest);
      staged.exec('BEGIN IMMEDIATE');
      try {
        assert.deepEqual(await this.load(), expected); assert.equal(index, expected.next);
        staged.prepare('INSERT INTO chunks VALUES (?,?,?)').run(index, content, digest);
        if (index === 384 && rollbackFault) { rollbackFault = false; injectedFault = { index, committed: false }; throw Error('injected restore rollback'); }
        staged.prepare('UPDATE checkpoint SET state=? WHERE singleton=1').run(JSON.stringify(next)); staged.exec('COMMIT');
      } catch (error) { staged.exec('ROLLBACK'); throw error; }
      if (index === 768 && lostCommitAck) { lostCommitAck = false; injectedFault = { index, committed: true }; throw Error('injected lost restore acknowledgement'); }
    },
    async finish(cp) {
      staged.exec('BEGIN IMMEDIATE');
      try { assert.deepEqual(await this.load(), cp); staged.prepare('UPDATE checkpoint SET state=? WHERE singleton=1').run(JSON.stringify({ ...cp, complete: true })); staged.exec('COMMIT'); }
      catch (error) { staged.exec('ROLLBACK'); throw error; }
    },
  };
  const options = { authority, jobId: verificationJob, head, maxChunks: 8, sealing };
  const restoreStarted = performance.now();
  let restored, restoreCalls = 0, resumedCursors = [], firstSelectorAfterRestart = 0;
  while (!restored?.complete) {
    try { restored = await restoreSyntheticArchive(bucket, kms, scope, commitment, envelope, signal(), target, options); }
    catch (error) {
      // The driver deliberately redacts destination errors and treats them as
      // uncertain. Accept only our recorded injected fault, then resolve the
      // outcome by reopening the durable checkpoint rather than the error.
      if (!injectedFault || error.message !== 'Archive destination outcome uncertain; reconciliation required') throw error;
      staged.close(); staged = openStage(); bucket = new Bucket();
      const checkpoint = await target.load();
      assert.equal(checkpoint.next, injectedFault.index + Number(injectedFault.committed));
      injectedFault = null; resumedCursors.push(checkpoint.next);
      if (resumedCursors.length === 1) {
        const firstKey = `mapi-p1-synthetic-archive-v1/${runId}/${scope.archiveId}/chunk-selector/${'0'.repeat(16)}`;
        firstSelectorAfterRestart = metrics.selectedReads.get(firstKey) ?? 0;
      }
      continue;
    }
    restoreCalls++;
  }
  assert.deepEqual(resumedCursors, [384, 769]);
  const firstKey = `mapi-p1-synthetic-archive-v1/${runId}/${scope.archiveId}/chunk-selector/${'0'.repeat(16)}`;
  assert.equal(metrics.selectedReads.get(firstKey) ?? 0, firstSelectorAfterRestart);
  const restoreMs = performance.now() - restoreStarted;
  const targetDigest = createHash('sha256'); let rows = 0, targetBytes = 0, chain = '';
  for (const row of staged.prepare('SELECT idx,content,digest FROM chunks ORDER BY idx').iterate()) {
    assert.equal(row.idx, rows); assert.equal(row.digest, sha(row.content));
    assert.equal(JSON.parse(row.content).prev, chain); chain = row.digest;
    targetDigest.update(row.content); targetBytes += Buffer.byteLength(row.content); rows++;
  }
  assert.equal(rows, chunks); assert.equal(targetBytes, chunks * chunkBytes); assert.equal(chain, commitment.finalDigest);
  assert.equal(targetDigest.digest('hex'), aggregateDigest);
  assert.equal((await target.load()).complete, true);
  const cpu = process.cpuUsage(startCPU);
  const targetStorageBytes = (await stat(path.join(root, 'target.sqlite'))).size;
  console.log(JSON.stringify({ outcome: 'passed', fixture: 'synthetic archive-only, not Nextgen', chunks, sourceBytes: chunks * chunkBytes,
    destinationRows: rows, destinationBytes: targetBytes, maxSourceChunkBytes: chunkBytes, maxEncryptedObjectBytes: metrics.maxObjectBytes,
    objectCount: metrics.objects, objectBytes: metrics.objectBytes, targetStorageBytes, reads: metrics.reads, readBytes: metrics.readBytes,
    sealingSteps, verificationSteps, restoreCalls, sealingResumeRevision, verificationResumeRevision, resumedCursors,
    writeMs: Math.round(writeMs), sealMs: Math.round(sealMs), verifyMs: Math.round(verifyMs), restoreMs: Math.round(restoreMs),
    writeBytesPerSecond: Math.round(chunks * chunkBytes * 1000 / writeMs), restoreBytesPerSecond: Math.round(chunks * chunkBytes * 1000 / restoreMs),
    elapsedMs: Math.round(performance.now() - start), cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000), sampledPeakProcessRSS: peakRSS,
    caveat: 'local filesystem, SQLite and fake KMS/authority; no hosted or independent recovery evidence' }));
} finally {
  clearInterval(sampler);
  try { staged?.close(); } catch {}
  try { authority?.close(); } catch {}
  await rm(root, { recursive: true, force: true });
}
