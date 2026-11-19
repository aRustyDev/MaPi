import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(done=>s.close(done));return p;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-account-parity-'));let native,server,logs='';
try{
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'Account parity'});const user=await native.seedUser();const foreign=await bootstrapProject({baseUrl:native.handle.baseUrl,projectName:'Other account parity project'});
 const wf=JSON.parse(await readFile('.mapi/fixture.json','utf8'));const nf={...native.handle,user,otherProjectId:foreign.projectId,otherProjectSecret:foreign.projectSecret};
 const p=await port(),inspector=await port();server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/account-test.wrangler.jsonc','--env-file',resolve('.dev.vars.poc'),'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});server.stderr.on('data',c=>{logs=(logs+c).slice(-8000)});
 const worker=`http://127.0.0.1:${p}`;for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await fetch(worker+'/livez');break;}catch{await setTimeout(200);}}
 const email=`account-${randomUUID()}@example.test`;
 const nativeDB=new DatabaseSync(resolve(dir,'native/.zitadel/local/nextgen-data/zitadel.db'),{readOnly:true});
 async function run(base,f,workerSide){
  const api=client(base,f);const session=api.session(await api.exchange(await api.mint()));const origin=new URL(base).origin;
  async function req(method,path,{token,cookie,body,headers={}}={}){const h={accept:'application/json',...headers};if(token)h.authorization=`Bearer ${token}`;if(cookie)h.cookie=cookie;if(body!==undefined)h['content-type']='application/json';const res=await fetch(base+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const text=await res.text();let data;try{data=text?JSON.parse(text):null;}catch{data=text;}return{status:res.status,data,headers:res.headers};}
  const self=`/users/me?project_id=${encodeURIComponent(f.projectId)}`,myPassword=`/users/me/password?project_id=${encodeURIComponent(f.projectId)}`,userPath=`/users/${f.user.id}`,passwordPath=userPath+'/password';
  const values={};const record=async(label,promise)=>{const v=await promise;values[label]={status:v.status,code:v.data?.code??null};return v;};
  const countAudit=async(type)=>{if(workerSide){const r=await (await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'events'})})).json();return r.events.find(e=>e.event_type===type)?.count??0;}return nativeDB.prepare('SELECT count(*) AS n FROM events WHERE project_id=? AND event_type=?').get(f.projectId,type).n;};
  await record('self unauthorized',req('GET',self));await record('self bearer only',req('GET',self,{token:f.projectSecret}));await record('self read',req('GET',self,{cookie:session.cookie}));await record('self wrong project',req('GET',`/users/me?project_id=${f.otherProjectId}`,{cookie:session.cookie}));
  await record('self password state',req('GET',myPassword,{cookie:session.cookie}));await record('admin password state',req('GET',passwordPath,{token:f.projectSecret}));
  await record('foreign admin read',req('GET',userPath,{token:f.otherProjectSecret}));
  const csrf=await req('GET',`/sessions/me/csrf?project_id=${f.projectId}`,{cookie:session.cookie});assert.equal(csrf.status,200);assert.ok(csrf.data.csrf_token);
  const patch={attributes:{email}},updateEvents=await countAudit('user.updated');
  await record('self update missing csrf',req('PATCH',self,{cookie:session.cookie,body:patch,headers:{origin}}));
  await record('self update cross origin',req('PATCH',self,{cookie:session.cookie,body:patch,headers:{origin:'https://evil.example','x-zitadel-csrf':csrf.data.csrf_token}}));
  await record('self update bad csrf',req('PATCH',self,{cookie:session.cookie,body:patch,headers:{origin,'x-zitadel-csrf':'invalid'}}));
  assert.equal(await countAudit('user.updated'),updateEvents,'rejected self updates wrote mutation audit');
  const patched=await record('self update',req('PATCH',self,{cookie:session.cookie,body:patch,headers:{origin,'x-zitadel-csrf':csrf.data.csrf_token}}));
  assert.equal(patched.status,200);assert.equal(patched.data.attributes.email,email);assert.equal(await countAudit('user.updated'),updateEvents+1,'self update audit missing');f.user.email=email;
  await record('invalid admin patch',req('PATCH',userPath,{token:f.projectSecret,body:{attributes:{email:'invalid'}}}));
  const updated=await record('admin update',req('PATCH',userPath,{token:f.projectSecret,body:{attributes:{email}}}));assert.equal(updated.status,200);
  await record('password session only',req('PUT',passwordPath,{cookie:session.cookie,body:{password:'New-Strong-Password-2026!'},headers:{origin,'x-zitadel-csrf':csrf.data.csrf_token}}));
  await record('password unauthorized',req('PUT',passwordPath,{body:{password:'New-Strong-Password-2026!'}}));
  await record('password wrong token',req('PUT',passwordPath,{token:'invalid',body:{password:'New-Strong-Password-2026!'}}));
  await record('password foreign token',req('PUT',passwordPath,{token:f.otherProjectSecret,body:{password:'New-Strong-Password-2026!'}}));
  await record('password short',req('PUT',passwordPath,{token:f.projectSecret,body:{password:'x'}}));
  if(workerSide){const auditBefore=await countAudit('user.updated');await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('PATCH',userPath,{token:f.projectSecret,body:{attributes:{email:`rollback-${randomUUID()}@example.test`}}});assert.equal(failed.status,500);const read=await req('GET',userPath,{token:f.projectSecret});assert.equal(read.data.attributes.email,email,'failed audit retained user update');assert.equal(await countAudit('user.updated'),auditBefore,'failed user audit persisted');}
  const pass1='First-Strong-Passphrase-2026!',pass2='Second-Strong-Passphrase-2026!';
  if(workerSide){const before=await (await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'events'})})).json();await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('PUT',passwordPath,{token:f.projectSecret,body:{password:pass1}});assert.equal(failed.status,500);const after=await(await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'events'})})).json();assert.deepEqual(after.events,before.events,'failed audit changed events');const unchanged=await api.attempt('x');assert.equal(unchanged.passwordResult.status,200,'audit rollback changed password');}
  const beforePasswordAudit=await countAudit('auth.factor.password.set');
  const changes=await Promise.all([pass1,pass2].map(password=>req('PUT',passwordPath,{token:f.projectSecret,body:{password}})));values.concurrent=changes.map(v=>({status:v.status,code:v.data?.code??null})).sort((a,b)=>a.status-b.status);assert.ok(changes.some(x=>x.status===204),'no password write succeeded');assert.equal((await countAudit('auth.factor.password.set'))-beforePasswordAudit,changes.filter(x=>x.status===204).length,'password audit count differs from committed changes');
  values.sessionAfterPassword={status:(await api.read(session)).status};
  const old=await api.attempt(f.user.password);values.oldPassword={status:old.passwordResult.status,code:old.passwordResult.data?.code??null};assert.equal(values.oldPassword.status,409);
  const attempts=[];for(const pass of [pass1,pass2]){const a=await api.attempt(pass);attempts.push(a.passwordResult.status);}
  values.newPasswordSuccesses=attempts.filter(status=>status<300).length;assert.equal(values.newPasswordSuccesses,1);
  assert.equal((await api.revoke(session)).status,204);values.revokedSelf={status:(await req('GET',self,{cookie:session.cookie})).status};values.revokedPasswordState={status:(await req('GET',myPassword,{cookie:session.cookie})).status};assert.equal(values.revokedSelf.status,401);assert.equal(values.revokedPasswordState.status,401);
  for(const label of ['self update missing csrf','self update cross origin','self update bad csrf'])assert.equal(values[label].status,403,label);
  for(const label of ['self unauthorized','self bearer only','password session only','password unauthorized','password wrong token'])assert.equal(values[label].status,401,label);
  return values;
 }
 const a=await run(nf.baseUrl,nf,false),b=await run(worker,wf,true);console.log(JSON.stringify({native:a,worker:b},null,2));
 for(const label of Object.keys(a)){if(label==='concurrent'||label==='foreign admin read'||label==='password foreign token')continue;assert.deepEqual(b[label],a[label],label);}
 for(const label of ['foreign admin read','password foreign token']){assert.ok(a[label].status>=400&&a[label].status<500);assert.ok(b[label].status>=400&&b[label].status<500);console.log(`${label}: native ${a[label].status}, worker ${b[label].status}; object project fence`);}
 nativeDB.close();
 assert.deepEqual(b.concurrent,a.concurrent,'concurrent password results');console.log('Native and isolated workerd account comparisons passed, with foreign-credential status differences noted.');
}catch(error){if(logs)console.error(logs);throw error;}finally{if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}if(native)await native.stop();await rm(dir,{recursive:true,force:true});}
