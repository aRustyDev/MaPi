import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwnerFence, freezeOwnerFence } from '../../../worker/owner-fence.js';
import { appendFrame, beginSpool, createSpoolSchema, inspectSpoolHead } from './frames.js';
import { beginHistoricalReplay, advanceHistoricalReplay } from './verified-replay.js';
import { beginAuthoritativeReplay, advanceAuthoritativeReplay } from './replay-authority.js';

const db = new DatabaseSync(':memory:');
const storage = {
  sql: { exec(sql, ...args) {
    const statement = db.prepare(sql);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } },
  transactionSync(fn) {
    db.exec('BEGIN');
    try { const value=fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const route = {projectId:'project-a',origin:'https://a.invalid',objectName:'owner-a',generation:1};
const scope = {id:'1'.repeat(32),principal:'2'.repeat(64),request:'3'.repeat(64),epoch:'era-1',route};
const authorize = () => true;
initializeOwnerFence(storage,route);
db.exec("CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
createSpoolSchema(storage);
beginSpool(storage,scope,authorize);
const input = Array.from({length:10}, (_,i) => new Uint8Array([i+1,i+2]));
for (let i=0;i<input.length;i++) await appendFrame(storage,scope,authorize,i,input[i]);
const anchor=inspectSpoolHead(storage,scope,authorize);
const key=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256',length:256},false,['sign','verify']);
const otherKey=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256',length:256},false,['sign','verify']);
const begin=(target=1,data=input[target])=>beginHistoricalReplay(storage,scope,authorize,anchor,key,target,data);
const advance=(token,n=3)=>advanceHistoricalReplay(storage,scope,authorize,anchor,key,token,n);

// A lost acknowledgement for frame 1 is reconciled after eight later frames.
// Serialize checkpoints between steps to model storage/restart by the caller.
let checkpoint=await begin();
let result=await advance(checkpoint);
assert.equal(result.complete,false);
checkpoint=JSON.parse(JSON.stringify(result.checkpoint));
const forged=structuredClone(checkpoint); forged.body[5]=9;
await assert.rejects(advance(forged),/Invalid replay checkpoint/);
await assert.rejects(advanceHistoricalReplay(storage,scope,authorize,anchor,otherKey,checkpoint,3),/Invalid replay checkpoint/);
await assert.rejects(advanceHistoricalReplay(storage,{...scope,request:'4'.repeat(64)},authorize,anchor,key,checkpoint,3),/Invalid replay checkpoint/);
await assert.rejects(advance(checkpoint,5),/Invalid replay batch/);
while (!result.complete) { result=await advance(checkpoint); checkpoint=JSON.parse(JSON.stringify(result.checkpoint)); }
assert.equal(result.index,1); assert.equal(result.replayed,true);
assert.equal((await advance(checkpoint)).complete,true);

// Authority double models monotonic read/create/CAS with committed but lost
// acknowledgements. Real independent custody and rollback protection are not
// established by this in-memory contract test.
const jobs=new Map(); let loseCreate=true, loseSwap=true;
const authority={
  async read(job) { return structuredClone(jobs.get(job) ?? null); },
  async create(job,value) {
    if (jobs.has(job)) throw Error('exists');
    jobs.set(job,structuredClone(value));
    if (loseCreate) { loseCreate=false; throw Error('lost create acknowledgement'); }
  },
  async compareAndSwap(job,expected,next) {
    if (JSON.stringify(jobs.get(job)) !== JSON.stringify(expected)) throw Error('stale');
    jobs.set(job,structuredClone(next));
    if (loseSwap) { loseSwap=false; throw Error('lost CAS acknowledgement'); }
  },
};
const job='5'.repeat(32);
const initial=await beginAuthoritativeReplay(storage,scope,authorize,anchor,key,1,input[1],authority,job);
let authorizedResult=await advanceAuthoritativeReplay(storage,scope,authorize,anchor,key,initial,3,authority,job);
await assert.rejects(()=>advanceAuthoritativeReplay(storage,scope,authorize,anchor,key,initial,3,authority,job),/authority changed/);
let mutable=structuredClone(authorizedResult.checkpoint);
const advancing=advanceAuthoritativeReplay(storage,scope,authorize,anchor,key,mutable,3,authority,job);
mutable.body[5]=0; mutable.mac='0'.repeat(64);
authorizedResult=await advancing;
while (!authorizedResult.complete) authorizedResult=await advanceAuthoritativeReplay(storage,scope,authorize,anchor,key,authorizedResult.checkpoint,3,authority,job);
assert.equal(authorizedResult.replayed,true);
assert.equal((await advanceAuthoritativeReplay(storage,scope,authorize,anchor,key,authorizedResult.checkpoint,3,authority,job)).complete,true);
const interferenceJob='6'.repeat(32);
const interfere={...authority, async compareAndSwap(job,expected,next) {
  await authority.compareAndSwap(job,expected,next);
  db.prepare('UPDATE mapi_audit_spool_head SET digest = ? WHERE snapshot_id = ?').run('a'.repeat(64),scope.id);
}};
const interleaved=await beginAuthoritativeReplay(storage,scope,authorize,anchor,key,1,input[1],interfere,interferenceJob);
await assert.rejects(()=>advanceAuthoritativeReplay(storage,scope,authorize,anchor,key,interleaved,3,interfere,interferenceJob),/head changed/);
db.prepare('UPDATE mapi_audit_spool_head SET digest = ? WHERE snapshot_id = ?').run(anchor.digest,scope.id);
const recovered=await authority.read(interferenceJob);
assert.equal((await advanceAuthoritativeReplay(storage,scope,authorize,anchor,key,recovered,3,authority,interferenceJob)).complete,false);

let bad=await begin(1,new Uint8Array([0,0]));
await assert.rejects(advance(bad),/Conflicting historical snapshot replay/);
const missing=await begin();
db.prepare('DELETE FROM mapi_audit_spool_frame WHERE snapshot_id = ? AND frame_index = ?').run(scope.id,2);
await assert.rejects(advance(missing),/missing or invalid/);
db.prepare('INSERT INTO mapi_audit_spool_frame VALUES (?, ?, ?, ?, ?)').run(scope.id,2,
  db.prepare('SELECT digest FROM mapi_audit_spool_frame WHERE snapshot_id = ? AND frame_index = 1').get(scope.id).digest,
  db.prepare('SELECT previous_digest FROM mapi_audit_spool_frame WHERE snapshot_id = ? AND frame_index = 3').get(scope.id).previous_digest,input[2]);
const changing=await begin();
db.prepare('UPDATE mapi_audit_spool_frame SET data = ? WHERE snapshot_id = ? AND frame_index = 0').run(new Uint8Array([9]),scope.id);
await assert.rejects(advance(changing),/integrity|verification changed/);
db.prepare('UPDATE mapi_audit_spool_frame SET data = ? WHERE snapshot_id = ? AND frame_index = 0').run(input[0],scope.id);

const pending=advance(await begin());
db.prepare('UPDATE mapi_audit_spool_head SET digest = ? WHERE snapshot_id = ?').run('a'.repeat(64),scope.id);
await assert.rejects(pending,/head changed|verification changed/);
db.prepare('UPDATE mapi_audit_spool_head SET digest = ? WHERE snapshot_id = ?').run(anchor.digest,scope.id);
await appendFrame(storage,scope,authorize,10,new Uint8Array([11,12]));
await assert.rejects(()=>begin(),/head changed/);

// A fresh pin is required after the append; a move fence must abort a pending
// verification even if a digest operation has already begun.
const updated=inspectSpoolHead(storage,scope,authorize);
const pinned=await beginHistoricalReplay(storage,scope,authorize,updated,key,1,input[1]);
const fenced=advanceHistoricalReplay(storage,scope,authorize,updated,key,pinned,1);
freezeOwnerFence(storage,route,'move-1');
await assert.rejects(fenced,/fenced/);
console.log('authenticated bounded historical replay diagnostic passed');
