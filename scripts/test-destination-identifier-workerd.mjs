// Distinct local Workerd/SQLite reservation test. No registry, real owner,
// cutover, history integration, hosted deployment, or external service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const source=await readFile('worker/owner-fence.js','utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const worker=`import { DurableObject } from 'cloudflare:workers';
import { reserveMoveDestination } from './owner-fence.js';
const route={projectId:'p',origin:'https://p.invalid',objectName:'destination',generation:2};
const reservation='CREATE TABLE MAPI_DESTINATION_RESERVATION ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), project_id TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL, move_id TEXT NOT NULL )';
export class Probe extends DurableObject {
  run(kind) {
    const s=this.ctx.storage, q=s.sql;
    const setups={
      projects:"CREATE TABLE PROJECTS(id TEXT); INSERT INTO PROJECTS VALUES ('existing')",
      metadata:"CREATE TABLE Mapi_Project(project_id TEXT); INSERT INTO Mapi_Project VALUES ('existing')",
      origin:"CREATE TABLE Mapi_Project_Origin(origin TEXT); INSERT INTO Mapi_Project_Origin VALUES ('existing')",
      pending:'CREATE TABLE MAPI_PENDING_OWNER(id TEXT)',
      fence:'CREATE TABLE MAPI_OWNER_FENCE(id TEXT)',
      relocation:'CREATE TABLE MAPI_RELOCATION_PROJECT(id TEXT)',
      view:'CREATE VIEW PROJECTS AS SELECT 1 AS id',
      index:'CREATE TABLE other(id TEXT); CREATE INDEX PROJECTS ON other(id)',
      empty:'CREATE TABLE PROJECTS(id TEXT)',
      existing:reservation,
      trigger:reservation+'; CREATE TABLE business(v INTEGER); INSERT INTO business VALUES(0); CREATE TRIGGER reservation_side_effect AFTER INSERT ON MAPI_DESTINATION_RESERVATION BEGIN UPDATE business SET v=1; END',
    };
    q.exec(setups[kind]);
    const before=q.exec("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").toArray();
    const expectSuccess=kind==='empty'||kind==='existing';
    let error;
    try { reserveMoveDestination(s,route,'move'); } catch(e) { error=String(e); }
    if (!expectSuccess) {
      if (!error || !error.includes(kind==='trigger'?'Invalid destination reservation':'Destination is not fresh')) throw Error('Expected rejection: '+kind);
      if (JSON.stringify(q.exec("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").toArray())!==JSON.stringify(before)) throw Error('Schema changed: '+kind);
      if (kind==='projects' && q.exec('SELECT count(*) AS n FROM PROJECTS').one().n!==1) throw Error('Project changed');
      if (kind==='trigger' && q.exec('SELECT v FROM business').one().v!==0) throw Error('Trigger ran');
      return true;
    }
    if (error) throw Error('Expected success: '+kind+' '+error);
    if (kind==='existing') { q.exec('CREATE TABLE PROJECTS(id TEXT)'); q.exec("INSERT INTO PROJECTS VALUES ('staged')"); }
    reserveMoveDestination(s,route,'move');
    if (q.exec('SELECT count(*) AS n FROM mapi_destination_reservation').one().n!==1) throw Error('Retry changed reservation');
    return true;
  }
}
export default {async fetch(req,env) {
  for (const kind of ['projects','metadata','origin','pending','fence','relocation','view','index','empty','existing','trigger']) {
    if (!await env.PROBE.getByName(kind).run(kind)) throw Error('failed '+kind);
  }
  return new Response('ok');
}};`;
let mf;
try {
  const options=convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'destination-identifier',compatibilityDate:'2026-11-18',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},modules:[
      {type:'ESModule',path:'worker.mjs',contents:worker},
      {type:'ESModule',path:'owner-fence.js',contents:source},
    ],
  }]});
  mf=new Miniflare(options);
  const response=await mf.dispatchFetch('http://localhost/');
  assert.equal(response.status,200); assert.equal(await response.text(),'ok');
  assert.equal(hash(await readFile('worker/owner-fence.js','utf8')),hash(source));
  console.log('Destination SQLite identifier Workerd checks passed');
  console.log(JSON.stringify({ownerFence:hash(source),worker:hash(worker)}));
} finally { if(mf)await mf.dispose(); }
