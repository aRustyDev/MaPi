// Native SQLite diagnostic; no Worker, hosted resource or interrupted test.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {installShadowSQL} from './shadow-sql.mjs';

const baseline=JSON.parse(await readFile(new URL('../../worker/generated/baseline.json',import.meta.url),'utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl);assert.equal(indexes.length,12);
function init() {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA recursive_triggers=OFF');db.exec(ddl);
  for(const index of indexes) db.exec(index);
  const insert=db.prepare(`INSERT INTO events(rowid,project_id,id,event_type,category,occurred_at,created_at,payload,metadata,actor_id,operation_status)
    VALUES (?,?,?,'mapi.test',?,10,?,?, '{}',?,?)`);
  for(const row of [
    [-1,'p','a','1',10,'one',null,'success'],[2,'p','b','01',11,Buffer.alloc(131073,97),'actor',null],
    [3,'p','c','2',12,'three','actor','failure'],[4,'q','a','1',10,'foreign',null,'success'],
    [5,'p','d','1',12,'five',null,'success'],[6,'p','e','1',12,'six',null,null],
  ]) insert.run(...row);
  return db;
}
function storage(db) {return {sql:{exec(q,...args){const s=db.prepare(q);const rows=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>rows};}},
  transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};}
const ref=init(), live=init(), s=storage(live);
let checks=0;
assert.throws(()=>installShadowSQL(s,ddl,indexes,()=>++checks===1),/denied/);
assert.equal(live.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'mapi_shadow_%'").get().n,0);
installShadowSQL(s,ddl,indexes,()=>true);
assert.equal(live.prepare("SELECT count(*) AS n FROM pragma_index_list('mapi_shadow_events') WHERE \"unique\"=0").get().n,12);
const filters=[
  ["e.project_id = ?",['p']],
  ["e.project_id = ? AND e.category = ?",['p',1]],
  ["e.project_id = ? AND e.created_at >= ?",['p','11']],
  ["e.project_id = ? AND e.actor_id IS NULL",['p']],
  ["e.project_id = ? AND e.operation_status = ?",['p','success']],
  ["e.project_id = ? AND e.event_type = ?",['q','mapi.test']],
];
function query(db,table,rowid,where,args) {
  return db.prepare(`SELECT e.${rowid} AS source_rowid,e.project_id,e.id,e.category,e.created_at,
    typeof(e.payload) AS payload_type,length(CAST(e.payload AS BLOB)) AS payload_bytes,e.operation_status
    FROM ${table} e WHERE ${where} ORDER BY e.created_at,e.id`).all(...args);
}
function compare() {
  for(const [where,args] of filters) assert.deepEqual(query(live,'mapi_shadow_snapshot','source_rowid',where,args),query(ref,'events','rowid',where,args),where);
}
compare();
live.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES ('p','new','mapi.test','1',1,20)");
live.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES ('p','a','mapi.test','1',1,20) ON CONFLICT(project_id,id) DO NOTHING");
for(const policy of ['FAIL','ABORT']) {
  live.exec(`UPDATE OR ${policy} events SET category='8' WHERE project_id='p' AND id='a'`);
  live.exec(`UPDATE OR ${policy} events SET category='8' WHERE project_id='p' AND id='new'`);
  compare();
}
live.exec("INSERT OR REPLACE INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES ('p','b','mapi.test','9',1,20)");compare();
live.exec("UPDATE OR REPLACE events SET id='e' WHERE project_id='p' AND id='d'");compare();
live.exec("DELETE FROM events WHERE project_id='p' AND id='c'");compare();
live.exec('BEGIN');live.exec("UPDATE events SET category='9' WHERE project_id='q' AND id='a'");live.exec('ROLLBACK');compare();
assert.equal(query(live,'mapi_shadow_snapshot','source_rowid',filters[1][0],filters[1][1]).some(x=>x.id==='b'),false);
assert.equal(live.prepare("SELECT count(*) AS n FROM mapi_shadow_snapshot WHERE project_id='q'").get().n,1);
ref.close();live.close();
console.log('Pinned-schema shadow snapshot native selection checks passed');
