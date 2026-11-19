import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {startLocalZitadel,bootstrapProject} from '@zitadel/testing';
import {client} from './parity.mjs';
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-userdelete-parity-'));let native,server,db,logs='';
try{
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'User deletion parity'});const user=await native.seedUser();const other=await bootstrapProject({baseUrl:native.handle.baseUrl,projectName:'Other deletion project'});const nf={...native.handle,user,otherProjectId:other.projectId,otherProjectSecret:other.projectSecret};const wf=JSON.parse(await readFile('.mapi/fixture.json','utf8'));
 db=new DatabaseSync(resolve(dir,'native/.zitadel/local/nextgen-data/zitadel.db'));db.exec('PRAGMA foreign_keys=ON');
 const p=await port(),inspector=await port();server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/userdelete-test.wrangler.jsonc','--env-file',resolve('.dev.vars.poc'),'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});server.stderr.on('data',c=>logs=(logs+c).slice(-8000));const worker=`http://127.0.0.1:${p}`;for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await fetch(worker+'/livez');break;}catch{await setTimeout(200);}}
 async function run(base,f,workerSide){
  const api=client(base,f),session=api.session(await api.exchange(await api.mint())),origin=new URL(base).origin,out={};
  async function req(method,path,{token,cookie,headers={}}={}){const h={accept:'application/json',...headers};if(token)h.authorization=`Bearer ${token}`;if(cookie)h.cookie=cookie;const r=await fetch(base+path,{method,headers:h});const text=await r.text();let data;try{data=text?JSON.parse(text):null;}catch{data=text;}return{status:r.status,data};}
  const record=(key,r)=>{out[key]={status:r.status,code:r.data?.code??null};return r};
  async function fixture(action){
   if(workerSide){const r=await fetch(base+'/__mapi/delete-fixture',{method:'POST',body:JSON.stringify({user:f.user.id,foreignProject:f.otherProjectId,action})});assert.equal(r.status,200);return r.json();}
   const project=f.projectId,foreignProject=f.otherProjectId,user=f.user.id;
   if(action==='seed'){
    const schema=db.prepare('SELECT schema_url FROM users WHERE project_id=? AND id=?').get(project,user).schema_url;db.exec('BEGIN');try{
     db.prepare('INSERT INTO teams(project_id,id,name,created_at,updated_at) VALUES(?,?,?,1800000000000000000,1800000000000000000)').run(project,'team_delete_test','Delete Test Team');
     db.prepare('INSERT INTO resource_scope_index(resource_id,resource_kind,project_id,team_id,created_at,updated_at) VALUES(?,?,?,NULL,1800000000000000000,1800000000000000000)').run('team_delete_test','team',project);
     db.prepare("INSERT INTO team_memberships(project_id,team_id,user_id,status,created_at,updated_at) VALUES(?,?,?,'active',1800000000000000000,1800000000000000000)").run(project,'team_delete_test',user);
     db.prepare("INSERT INTO authz_membership_edges(project_id,member_type,member_id,set_type,set_id,created_at) VALUES(?,'user',?,'team',?,1800000000000000000)").run(project,user,'team_delete_test');
     db.prepare("INSERT INTO users(project_id,id,schema_url,status,created_at,updated_at) VALUES(?,?,?,'active',1800000000000000000,1800000000000000000)").run(project,'user_delete_decoy',schema);
     const statement=db.prepare("INSERT INTO authz_assignments(id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES(?,?,'cat_sys_1',?,?,'project',?,'project',1800000000000000000,1800000000000000000)");for(const [id,principal,relation,type] of [['assignment_user_delete',user,'viewer','user'],['assignment_user_decoy','user_delete_decoy','viewer','user'],['assignment_user_owner','team_delete_test','team','team']])statement.run(id,foreignProject,type,principal,relation);
     db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
   }
   if(action==='release')db.prepare("UPDATE authz_assignments SET revoked_at=1800000000000000001 WHERE project_id=? AND id='assignment_user_owner'").run(foreignProject);
   const count=(q,...args)=>db.prepare(q).get(...args).n;
   return{user:count('SELECT COUNT(*) AS n FROM users WHERE project_id=? AND id=?',project,user),membership:count('SELECT COUNT(*) AS n FROM team_memberships WHERE project_id=? AND user_id=?',project,user),grant:count("SELECT COUNT(*) AS n FROM authz_assignments WHERE project_id=? AND id='assignment_user_delete' AND revoked_at IS NULL",foreignProject),decoy:count("SELECT COUNT(*) AS n FROM authz_assignments WHERE project_id=? AND id='assignment_user_decoy' AND revoked_at IS NULL",foreignProject),deleted:count("SELECT COUNT(*) AS n FROM events WHERE project_id=? AND event_type='user.deleted'",project),revoked:count("SELECT COUNT(*) AS n FROM events WHERE project_id=? AND event_type='authz.revoked'",foreignProject)};
  }
  const path=`/users/${f.user.id}`;assert.equal((await record('no auth',await req('DELETE',path))).status,401);assert.equal((await record('bad credential',await req('DELETE',path,{token:'invalid'}))).status,401);
  const csrf=await req('GET',`/sessions/me/csrf?project_id=${f.projectId}`,{cookie:session.cookie});assert.equal(csrf.status,200);assert.equal((await record('session missing csrf',await req('DELETE',path,{cookie:session.cookie,headers:{origin}}))).status,403);const noRole=record('session no role',await req('DELETE',path,{cookie:session.cookie,headers:{origin,'x-zitadel-csrf':csrf.data.csrf_token}}));assert.ok(noRole.status>=400&&noRole.status<500);
  const control=await api.send('POST','/auth_attempts',{token:f.otherProjectSecret,body:{project_id:f.otherProjectId}});out.foreignCredentialControl={status:control.status,code:control.data?.code??null};assert.equal(control.status,workerSide?403:201);
  const foreign=record('foreign credential',await req('DELETE',path,{token:f.otherProjectSecret}));assert.ok(foreign.status>=400&&foreign.status<500,`foreign credential status ${foreign.status} ${foreign.data?.code}`);
  const before=await fixture('seed');assert.equal(before.user,1);assert.equal(before.membership,1);assert.equal(before.grant,1);assert.equal(before.decoy,1);
  const blocked=record('last owner',await req('DELETE',path,{token:f.projectSecret}));assert.equal(blocked.status,409);assert.equal(blocked.data.code,'proj.last_owner');assert.deepEqual(await fixture('read'),before);assert.equal((await api.read(session)).status,200);
  await fixture('release');const beforeDelete=await fixture('read');
  if(workerSide){await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('DELETE',path,{token:f.projectSecret});assert.equal(failed.status,500);assert.deepEqual(await fixture('read'),beforeDelete,'failed audit left partial cascade');assert.equal((await api.read(session)).status,200);}
  const responses=await Promise.all([req('DELETE',path,{token:f.projectSecret}),req('DELETE',path,{token:f.projectSecret})]);out.concurrent=responses.map(r=>({status:r.status,code:r.data?.code??null})).sort((a,b)=>a.status-b.status);assert.deepEqual(out.concurrent.map(r=>r.status),[204,204]);
  const after=await fixture('read');assert.deepEqual({user:after.user,membership:after.membership,grant:after.grant,decoy:after.decoy},{user:0,membership:0,grant:0,decoy:1});assert.equal(after.deleted-beforeDelete.deleted,1);assert.equal(after.revoked-beforeDelete.revoked,1);
  const replay=record('delete again',await req('DELETE',path,{token:f.projectSecret}));assert.equal(replay.status,204);assert.deepEqual(await fixture('read'),after);
  const gone=record('get deleted',await req('GET',path,{token:f.projectSecret}));assert.equal(gone.status,404);out.revokedSession={status:(await api.read(session)).status};assert.equal(out.revokedSession.status,401);return out;
 }
 const a=await run(nf.baseUrl,nf,false),b=await run(worker,wf,true);console.log(JSON.stringify({native:a,worker:b},null,2));for(const key of Object.keys(a)){if(key==='foreign credential'||key==='foreignCredentialControl')continue;assert.deepEqual(b[key],a[key],key);}console.log('Native/workerd single-object user deletion comparison passed; foreign and cross-object limitations reported.');
}catch(e){if(logs)console.error(logs);throw e;}finally{if(db)db.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}if(native)await native.stop();await rm(dir,{recursive:true,force:true});}
