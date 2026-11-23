// Small native diagnostic only. No Go handler, interrupted row-transfer test,
// real owner, remote service, malformed TEXT, exact-size or cursor test.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compareShadowEventIds } from './shadow-id-compare.mjs';

const db=new DatabaseSync(':memory:');
let maxPart=0, partCount=0;
const storage={sql:{exec(query,...args) {
  const statement=db.prepare(query);
  const result=statement.all(...args);
  if(query.includes('substr(')) for(const row of result) { maxPart=Math.max(maxPart,row.part.byteLength); partCount++; }
  return {toArray:()=>result};
}}};
const data=[
  {id:'-9223372036854775808',value:'alpha'},
  {id:'2',value:'é'},
  {id:'3',value:new Uint8Array(Buffer.from('alpha'))},
  {id:'4',value:'x'.repeat(70000)+'a'},
  {id:'5',value:'x'.repeat(70000)+'b'},
  {id:'9223372036854775807',value:'x'.repeat(70000)},
];
try {
  db.exec('CREATE TABLE event_rows (source_rowid INTEGER PRIMARY KEY, project_id TEXT NOT NULL, id TEXT NOT NULL)');
  db.exec('CREATE VIEW mapi_shadow_snapshot AS SELECT source_rowid, project_id, id FROM event_rows');
  const insert=db.prepare('INSERT INTO event_rows VALUES (?, ?, ?)'); insert.setReadBigInts(true);
  for(const row of data) insert.run(BigInt(row.id),'p',row.value);
  insert.run(6n,'foreign','alpha');
  db.exec('BEGIN');
  for(const a of data) for(const b of data) {
    const expected=Math.sign(Buffer.compare(Buffer.from(a.value),Buffer.from(b.value)));
    assert.equal(compareShadowEventIds(storage,'p',a.id,b.id),expected,`${a.id} ${b.id}`);
  }
  assert.throws(()=>compareShadowEventIds(storage,'p','6','2'),/Invalid shadow event ID/);
  for(const bad of ['01','+1','-0','9223372036854775808','1.0']) assert.throws(()=>compareShadowEventIds(storage,'p',bad,'2'),/Invalid event row identifier/);
  db.exec('COMMIT');
  assert.ok(partCount>0); assert.ok(maxPart<=32768,`unexpected fragment length ${maxPart}`);
  console.log(`Native shadow ID comparisons passed; max fragment ${maxPart} bytes`);
} finally { db.close(); }
