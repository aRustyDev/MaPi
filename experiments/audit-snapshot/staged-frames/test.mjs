import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwnerFence, freezeOwnerFence } from '../../../worker/owner-fence.js';
import { appendFrame, beginSpool, createSpoolSchema, initialDigest, maxFrameBytes, readSealedFrame, sealSpool } from './frames.js';

const db = new DatabaseSync(':memory:');
const storage = {
  sql: { exec(sql, ...args) {
    const stmt = db.prepare(sql);
    const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } },
  transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const route = { projectId: 'project-a', origin: 'https://a.invalid', objectName: 'owner-a', generation: 1 };
const scope = { id: 'a'.repeat(32), principal: 'b'.repeat(64), request: 'c'.repeat(64), epoch: 'era-1', route };
const allow = () => true;
initializeOwnerFence(storage, route);
db.exec("CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
createSpoolSchema(storage);
assert.throws(() => createSpoolSchema(storage));
beginSpool(storage, scope, allow);
beginSpool(storage, scope, allow);
db.prepare('UPDATE mapi_audit_spool_head SET total_bytes = 1 WHERE snapshot_id = ?').run(scope.id);
assert.throws(() => sealSpool(storage, scope, allow, 0, initialDigest), /Invalid snapshot head/);
db.prepare('UPDATE mapi_audit_spool_head SET total_bytes = 0 WHERE snapshot_id = ?').run(scope.id);
assert.throws(() => beginSpool(storage, { ...scope, principal: 'd'.repeat(64) }, allow), /scope mismatch/);
assert.throws(() => beginSpool(storage, scope, () => false), /denied/);
assert.throws(() => beginSpool(storage, scope, () => Promise.resolve(true)), /synchronous/);
const other = { ...scope, id: 'f'.repeat(32) };
let authorized = true;
const checkAuthorization = () => authorized;
beginSpool(storage, other, checkAuthorization);
const revokedInFlight = appendFrame(storage, other, checkAuthorization, 0, new Uint8Array([4]));
authorized = false;
await assert.rejects(revokedInFlight, /denied/);
assert.equal(db.prepare('SELECT count(*) AS count FROM mapi_audit_spool_frame WHERE snapshot_id = ?').get(other.id).count, 0);
authorized = true;
await appendFrame(storage, other, checkAuthorization, 0, new Uint8Array([4]));
await assert.rejects(appendFrame(storage, scope, allow, 1, new Uint8Array([1])), /out of order/);
await assert.rejects(appendFrame(storage, scope, allow, 0, new Uint8Array(maxFrameBytes + 1)), /Invalid/);
const firstData = new Uint8Array([1, 2, 3]);
const first = await appendFrame(storage, scope, allow, 0, firstData);
assert.equal(first.replayed, false);
const retry = await appendFrame(storage, scope, allow, 0, firstData);
assert.equal(retry.replayed, true);
assert.equal(retry.digest, first.digest);
await assert.rejects(appendFrame(storage, scope, allow, 0, new Uint8Array([1, 2, 4])), /Conflicting/);
const large = new Uint8Array(maxFrameBytes).fill(9);
const mutableScope = structuredClone(scope);
const checkCopiedScope = current => Object.isFrozen(current) && Object.isFrozen(current.route) && current.id === scope.id && current.route.projectId === scope.route.projectId;
const pending = appendFrame(storage, mutableScope, checkCopiedScope, 1, large);
mutableScope.id = 'e'.repeat(32);
mutableScope.route.projectId = 'other-project';
large.fill(0); // The asynchronous digest cannot observe caller mutation.
const second = await pending;
await assert.rejects(appendFrame(storage, scope, allow, 0, firstData), /Historical snapshot replay/);
const manifest = sealSpool(storage, scope, allow, 2, second.digest);
assert.deepEqual(manifest, { count: 2, bytes: maxFrameBytes + 3, digest: second.digest });
assert.deepEqual(sealSpool(storage, scope, allow, 2, second.digest), manifest);
assert.throws(() => sealSpool(storage, scope, allow, 2, first.digest), /mismatch/);
await assert.rejects(appendFrame(storage, scope, allow, 2, new Uint8Array([1])), /out of order/);
const r0 = await readSealedFrame(storage, scope, allow, 0, initialDigest);
const r1 = await readSealedFrame(storage, scope, allow, 1, r0.digest);
assert.deepEqual([...r0.data], [1, 2, 3]);
assert.equal(r1.data.length, maxFrameBytes);
assert.ok(r1.data.every(v => v === 9));
assert.equal(r1.digest, manifest.digest);
await assert.rejects(readSealedFrame(storage, scope, allow, 1, initialDigest), /chain mismatch/);
await assert.rejects(readSealedFrame(storage, { ...scope, request: 'd'.repeat(64) }, allow, 0, initialDigest), /scope mismatch/);
db.prepare('UPDATE mapi_audit_spool_frame SET data = ? WHERE snapshot_id = ? AND frame_index = 0').run(new Uint8Array([1, 2, 4]), scope.id);
await assert.rejects(readSealedFrame(storage, scope, allow, 0, initialDigest), /integrity mismatch/);
db.prepare('UPDATE mapi_audit_spool_frame SET data = ? WHERE snapshot_id = ? AND frame_index = 0').run(firstData, scope.id);
db.prepare('UPDATE mapi_audit_spool_head SET frame_count = ? WHERE snapshot_id = ?').run('x'.repeat(100000), scope.id);
await assert.rejects(readSealedFrame(storage, scope, allow, 0, initialDigest), /Invalid snapshot head/);
db.prepare('UPDATE mapi_audit_spool_head SET frame_count = 2 WHERE snapshot_id = ?').run(scope.id);
db.prepare('UPDATE mapi_audit_spool_frame SET digest = ? WHERE snapshot_id = ? AND frame_index = 1').run('d'.repeat(64), scope.id);
await assert.rejects(readSealedFrame(storage, scope, allow, 1, r0.digest), /chain mismatch/);
await assert.rejects(appendFrame(storage, scope, allow, 1, new Uint8Array(maxFrameBytes).fill(9)), /Conflicting snapshot replay/);
db.prepare('UPDATE mapi_audit_spool_frame SET digest = ? WHERE snapshot_id = ? AND frame_index = 1').run(second.digest, scope.id);
db.exec("UPDATE mapi_recovery_epoch SET epoch = 'era-2'");
await assert.rejects(readSealedFrame(storage, scope, allow, 0, initialDigest), /era changed/);
db.exec("UPDATE mapi_recovery_epoch SET epoch = 'era-1'");
const inFlight = readSealedFrame(storage, scope, allow, 0, initialDigest);
freezeOwnerFence(storage, route, 'move-1');
await assert.rejects(inFlight, /fenced/);
await assert.rejects(readSealedFrame(storage, scope, allow, 0, initialDigest), /fenced/);
console.log('isolated native SQLite staged-frame checks passed');
