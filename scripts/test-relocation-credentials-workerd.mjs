// Small local Workerd credential transfer test. No registry, application owner,
// real-project relocation, scale fixture, history integration, or deployment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const tables=['projects','users','user_attributes','auth_attempts','user_totp','user_passkeys'];
const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=tables.map(table=>baseline.statements.find(sql=>new RegExp(`^CREATE TABLE ${table}\\s`,'i').test(sql)));
assert.ok(ddl.every(Boolean));
const names=['relocation-chunks.js','relocation.js','relocation-values.js','foreign-keys.js','sql.js'];
const modules=await Promise.all(names.map(async name=>({type:'ESModule',path:`worker/${name}`,contents:await readFile(`worker/${name}`,'utf8')})));
const worker=`import { DurableObject } from 'cloudflare:workers';
import { initializeProjectFence,freezeProject } from './relocation.js';
import { beginChunkExport,exportChunk,beginChunkImport,importChunk,chunkExportStatus,chunkImportStatus } from './relocation-chunks.js';
const tables=${JSON.stringify(tables)}, ddl=${JSON.stringify(ddl)};
const checked=(v,message)=>{if(!v) throw Error(message)};
export class Probe extends DurableObject {
  rejectControlNames(source) {
    const s=this.ctx.storage,q=s.sql;
    q.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    if(source) { initializeProjectFence(s,'p','source'); freezeProject(s,'p',1,'move'); }
    const begin=names=>source?beginChunkExport(s,'p',1,'move',names):beginChunkImport(s,'p',1,'move','destination',names);
    for(const names of [['MAPI_CHUNK_EXPORT'],['MaPi_Relocation_Project'],['projects','PROJECTS']]) {
      let rejected=false; try { begin(names); } catch(e) { rejected=String(e).includes('Invalid chunk table list'); }
      checked(rejected,'case-varied control or duplicate name accepted');
    }
    begin(['projects']);
  }
  initialize(project, source) {
    const s=this.ctx.storage,q=s.sql; for(const sql of ddl) q.exec(sql);
    if(source) {
      const bytes=project==='p'?'0001FF80':'AA55';
      q.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES (?, ?, 1, 1)",project,project);
      q.exec("INSERT INTO users(project_id,id,schema_url,created_at,updated_at) VALUES (?, 'u', 'schema', 1, 1)",project);
      q.exec("INSERT INTO user_attributes(project_id,user_id,key,value,value_hash) VALUES (?, 'u', 'bytes', 'value', X'"+bytes+"')",project);
      q.exec("INSERT INTO user_attributes(project_id,user_id,key,value,value_hash) VALUES (?, 'u', 'empty', 'value', X''), (?, 'u', 'null', 'value', NULL)",project,project);
      q.exec("INSERT INTO auth_attempts(project_id,id,handoff_token,created_at) VALUES (?, 'bytes', X'"+bytes+"', 1), (?, 'null', NULL, 1)",project,project);
      q.exec("INSERT INTO user_totp(project_id,id,user_id,secret,created_at,updated_at) VALUES (?, 'totp', 'u', X'"+bytes+"', 1, 1)",project);
      q.exec("INSERT INTO user_passkeys(project_id,id,user_id,credential_id,public_key,aaguid,transports,created_at,updated_at) VALUES (?, 'passkey', 'u', 'credential', X'"+bytes+"', X'', '[]', 1, 1)",project);
      initializeProjectFence(s,project,'source'); freezeProject(s,project,1,'move'); beginChunkExport(s,project,1,'move',tables);
    } else beginChunkImport(s,project,1,'move','destination',tables);
  }
  exportStatus(project) {return chunkExportStatus(this.ctx.storage,project);}
  next(project,index) {return exportChunk(this.ctx.storage,project,1,'move',index);}
  async receiveControlTrigger(project,chunk) {
    const s=this.ctx.storage,q=s.sql;
    q.exec('CREATE TABLE marker(n INTEGER)');
    q.exec('CREATE TRIGGER control_fault AFTER UPDATE ON MAPI_CHUNK_IMPORT BEGIN INSERT INTO marker VALUES (1); END');
    let rejected=false; try { await importChunk(s,project,chunk); } catch(e) { rejected=String(e).includes('Import control schema is incomplete or changed'); }
    checked(rejected && q.exec('SELECT COUNT(*) AS n FROM marker').one().n===0 && q.exec('SELECT COUNT(*) AS n FROM projects').one().n===0 && chunkImportStatus(s,project).next_chunk===0,'case-varied control trigger accepted');
    q.exec('DROP TRIGGER control_fault');
    await importChunk(s,project,chunk);
    checked(q.exec('SELECT COUNT(*) AS n FROM projects').one().n===1,'normal import after trigger removal failed');
  }
  async receive(project,chunk,exercise,alias) {
    const s=this.ctx.storage,q=s.sql;
    if(alias) {
      // The source RPC has returned a detached envelope. Mutating it inside
      // this same test call reproduces the helper's caller-owned alias risk;
      // it does not establish that the real owner does this.
      const changed=JSON.parse(chunk.content), index=changed.columns.indexOf('name');
      checked(index>=0 && changed.rows.length===1,'alias fixture mismatch');
      changed.rows[0][index]='altered in local caller';
      const pending=importChunk(s,project,chunk);
      chunk.content=JSON.stringify(changed);
      await pending;
    } else if(exercise) {
      const before=JSON.stringify(chunkImportStatus(s,project)), count=q.exec('SELECT COUNT(*) AS n FROM user_attributes').one().n;
      let rejected=false; try { await importChunk(s,project,chunk,1); } catch(e) {rejected=String(e).includes('Injected chunk failure');}
      checked(rejected && JSON.stringify(chunkImportStatus(s,project))===before && q.exec('SELECT COUNT(*) AS n FROM user_attributes').one().n===count,'rollback mismatch');
      await importChunk(s,project,chunk);
      const after=JSON.stringify(chunkImportStatus(s,project)), committed=q.exec('SELECT COUNT(*) AS n FROM user_attributes').one().n;
      await importChunk(s,project,chunk);
      checked(JSON.stringify(chunkImportStatus(s,project))===after && q.exec('SELECT COUNT(*) AS n FROM user_attributes').one().n===committed,'replay mismatch');
    } else await importChunk(s,project,chunk);
  }
  snapshot(project) {
    const q=this.ctx.storage.sql, out={};
    out.projects=q.exec('SELECT id, name FROM projects ORDER BY id').toArray();
    for(const [table,id,column] of [['user_attributes','key','value_hash'],['auth_attempts','id','handoff_token'],['user_totp','id','secret'],['user_passkeys','id','public_key'],['user_passkeys','id','aaguid']]) {
      out[table+'.'+column]=q.exec('SELECT '+id+' AS id, typeof('+column+') AS storage_type, length('+column+') AS size, hex('+column+') AS hex FROM '+table+' ORDER BY '+id).toArray();
    }
    for(const table of tables) {const col=table==='projects'?'id':'project_id';checked(q.exec('SELECT COUNT(*) AS n FROM '+table+' WHERE '+col+' <> ?',project).one().n===0,'foreign project row');}
    checked(q.exec('SELECT COUNT(*) AS n FROM pragma_foreign_key_check()').one().n===0,'foreign key violation');
    return out;
  }
}
export default {async fetch(req,env) {
  await env.PROBE.getByName('source-name-check').rejectControlNames(true);
  await env.PROBE.getByName('target-name-check').rejectControlNames(false);
  const faultSource=env.PROBE.getByName('source-trigger-check'),faultTarget=env.PROBE.getByName('target-trigger-check');
  await faultSource.initialize('p',true); await faultTarget.initialize('p',false);
  await faultTarget.receiveControlTrigger('p',await faultSource.next('p',0));
  const a=env.PROBE.getByName('source-p'),b=env.PROBE.getByName('target-p'),c=env.PROBE.getByName('source-q'),d=env.PROBE.getByName('target-q');
  await a.initialize('p',true); await b.initialize('p',false); await c.initialize('q',true); await d.initialize('q',false);
  let ai=0,ci=0,exercised=false,aliased=false;
  while(!(await a.exportStatus('p')).done || !(await c.exportStatus('q')).done) {
    if(!(await a.exportStatus('p')).done) {const chunk=await a.next('p',ai++), payload=JSON.parse(chunk.content), inject=!exercised&&payload.table==='user_attributes'&&payload.rows.length>0, alias=!aliased&&payload.table==='projects'&&payload.rows.length>0;await b.receive('p',chunk,inject,alias);if(inject)exercised=true;if(alias)aliased=true;}
    if(!(await c.exportStatus('q')).done) {const chunk=await c.next('q',ci++);await d.receive('q',chunk,false);}
  }
  checked(exercised,'credential rollback was not exercised'); checked(aliased,'mutable envelope was not exercised');
  checked(JSON.stringify(await a.snapshot('p'))===JSON.stringify(await b.snapshot('p')),'project p mismatch');
  checked(JSON.stringify(await c.snapshot('q'))===JSON.stringify(await d.snapshot('q')),'project q mismatch');
  const ap=await b.snapshot('p'),cq=await d.snapshot('q');
  checked(ap['user_totp.secret'][0].hex==='0001FF80'&&cq['user_totp.secret'][0].hex==='AA55','credentials crossed projects');
  return new Response('ok');
}};`;
let mf;
try {
 mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{name:'credential-transfer-local',compatibilityDate:'2026-11-19',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},modules:[{type:'ESModule',path:'worker/credential-probe.mjs',contents:worker},...modules]}]}));
 const response=await mf.dispatchFetch('http://localhost/'); const body=await response.text();
 assert.equal(response.status,200,body); assert.equal(body,'ok');
 for(const module of modules) assert.equal(await readFile(module.path,'utf8'),module.contents);
 const hashes=Object.fromEntries(modules.map(m=>[m.path,createHash('sha256').update(m.contents).digest('hex')]));
 console.log('Small Workerd transfers passed control-name/trigger, mutable-envelope, rollback, replay, type and project-isolation checks');
 console.log(JSON.stringify(hashes));
} finally { if(mf) await mf.dispose(); }
