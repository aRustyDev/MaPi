// Distinct small native integration test. No Workerd, hosted service,
// interrupted SQL/cursor/size/normalization action or production data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { initializeOwnerFence } from '../../worker/owner-fence.js';
import { auditSourceColumns } from '../../worker/audit-source-capture.js';
import { beginShadow, acquireShadowReader, releaseShadowReader } from './shadow-lifecycle.mjs';
import { nextShadowAuditFrame, auditTransferInitialDigest } from './shadow-row-transfer.mjs';

const baseline=JSON.parse(await readFile(new URL('../../worker/generated/baseline.json',import.meta.url),'utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl);assert.equal(indexes.length,12);
const db=new DatabaseSync(':memory:');
const storage={sql:{exec(sql,...args){const stmt=db.prepare(sql);const result=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>result,one:()=>{assert.equal(result.length,1);return result[0];}};}},
  transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const reader='4'.repeat(32),use='5'.repeat(32),allow=()=>true;
const key=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
const otherKey=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
const payload='audit-☁-'.repeat(40000), metadata=new Uint8Array(150123).map((_,i)=>i%251);
try {
  initializeOwnerFence(storage,route);
  db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  db.exec(ddl); for(const index of indexes) db.exec(index);
  const insert=db.prepare(`INSERT INTO events(rowid,project_id,id,event_type,category,occurred_at,created_at,payload,metadata)
    VALUES (?,?,?,'user.created','identity',9007199254740993,?,?,?)`);
  insert.run(7,'p','evt-a',1,payload,metadata);
  insert.run(8,'q','evt-a',2,'foreign','{}');
  beginShadow(storage,scope,ddl,indexes,allow);
  acquireShadowReader(storage,scope,reader,use,allow);
  db.exec("UPDATE events SET payload='modified', metadata='{}' WHERE rowid=7");
  db.exec('DELETE FROM events WHERE rowid=7');

  await assert.rejects(()=>nextShadowAuditFrame(storage,scope,reader,use,'8',allow,key),/Selected audit row unavailable/);
  const first=await nextShadowAuditFrame(storage,scope,reader,use,'7',allow,key);
  const retry=await nextShadowAuditFrame(storage,scope,reader,use,'7',allow,key);
  assert.deepEqual(first,retry);
  await assert.rejects(()=>nextShadowAuditFrame(storage,scope,reader,use,'7',allow,otherKey,first.next),/Invalid audit transfer cursor/);
  await assert.rejects(()=>nextShadowAuditFrame(storage,{...scope,request:'a'.repeat(64)},reader,use,'7',allow,key,first.next),/Invalid audit transfer cursor/);
  const forged={...first.next,payload:first.next.payload.replace('"column":1','"column":2')};
  await assert.rejects(()=>nextShadowAuditFrame(storage,scope,reader,use,'7',allow,key,forged),/Invalid audit transfer cursor/);
  let reads=0;
  const switching={get payload(){reads++;return reads<=2?first.next.payload:forged.payload;},mac:first.next.mac};
  const fromSwitch=await nextShadowAuditFrame(storage,scope,reader,use,'7',allow,key,switching);
  assert.equal(JSON.parse(new TextDecoder().decode(fromSwitch.frame)).column,1);
  assert.equal(reads,1);

  const chunks=new Map(), kinds=new Map(), sizes=new Map();
  let current=first, previous=auditTransferInitialDigest, sequence=0, terminal;
  for(let steps=0;steps<200;steps++) {
    if(current.complete){terminal=current;break;}
    assert.ok(current.frame.length<=128*1024);
    const frame=JSON.parse(new TextDecoder().decode(current.frame));
    assert.equal(frame.previous,previous);assert.equal(frame.sequence,sequence);assert.equal(frame.rowid,'7');
    const expected=createHash('sha256').update(previous).update(current.frame).digest('hex');
    assert.equal(current.digest,expected);
    const piece=Uint8Array.fromBase64(frame.data);
    assert.equal(frame.offset,(chunks.get(frame.column)??[]).reduce((n,b)=>n+b.length,0));
    const list=chunks.get(frame.column)??[];list.push(piece);chunks.set(frame.column,list);
    if(kinds.has(frame.column))assert.equal(frame.kind,kinds.get(frame.column));else kinds.set(frame.column,frame.kind);
    if(sizes.has(frame.column))assert.equal(frame.size,sizes.get(frame.column));else sizes.set(frame.column,frame.size);
    previous=current.digest;sequence++;
    current=await nextShadowAuditFrame(storage,scope,reader,use,'7',allow,key,current.next);
  }
  assert.ok(terminal?.complete);assert.equal(terminal.digest,previous);assert.equal(terminal.sequence,sequence);
  assert.equal(chunks.size,auditSourceColumns.length);
  const merged=index=>Buffer.concat(chunks.get(index).map(x=>Buffer.from(x)));
  for(const [column,list] of chunks) assert.equal(list.reduce((n,b)=>n+b.length,0),sizes.get(column));
  const payloadIndex=auditSourceColumns.indexOf('payload'), metadataIndex=auditSourceColumns.indexOf('metadata');
  assert.ok(chunks.get(payloadIndex).length>1);assert.ok(chunks.get(metadataIndex).length>1);
  assert.equal(kinds.get(payloadIndex),'text');assert.deepEqual(merged(payloadIndex),Buffer.from(payload));
  assert.equal(kinds.get(metadataIndex),'blob');assert.deepEqual(merged(metadataIndex),Buffer.from(metadata));
  const timeIndex=auditSourceColumns.indexOf('occurred_at');assert.equal(kinds.get(timeIndex),'integer');assert.equal(merged(timeIndex).toString(),'9007199254740993');
  const nullIndex=auditSourceColumns.indexOf('team_id');assert.equal(kinds.get(nullIndex),'null');assert.equal(merged(nullIndex).length,0);
  releaseShadowReader(storage,scope,reader,use,allow);
  await assert.rejects(()=>nextShadowAuditFrame(storage,scope,reader,use,'7',allow,key,first.next),/not active/);
  console.log(`Native shadow event transfer passed: ${sequence} frames; multi-fragment text and blob preserved`);
} finally { db.close(); }
