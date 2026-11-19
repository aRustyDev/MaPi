import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel, bootstrapProject } from '@zitadel/testing';
import { client } from './parity.mjs';

async function port() { const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(done=>s.close(done));return p; }
const dir=await mkdtemp(resolve(tmpdir(),'mapi-schemas-parity-'));let native,server,db,logs='';
try {
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'Schema parity'});
 const user=await native.seedUser(),foreign=await bootstrapProject({baseUrl:native.handle.baseUrl,projectName:'Foreign schema project'});
 const nf={...native.handle,user,otherProjectId:foreign.projectId,otherProjectSecret:foreign.projectSecret};
 const wf=JSON.parse(await readFile('.mapi/fixture.json','utf8'));
 db=new DatabaseSync(resolve(dir,'native/.zitadel/local/nextgen-data/zitadel.db'));
 const p=await port(),inspector=await port();
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/schemas-test.wrangler.jsonc','--env-file',resolve('.dev.vars.poc'),'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 server.stderr.on('data',c=>logs=(logs+c).slice(-8000));const worker=`http://127.0.0.1:${p}`;
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await fetch(worker+'/livez');break;}catch{await setTimeout(200);}}
 const suffix=randomUUID().replaceAll('-','');
 const schema=(revision)=>({title:'Synthetic schema', '$schema':'https://json-schema.org/draft/2020-12/schema', '$id':`https://example.test/${suffix}/${revision}`,objectType:`test-${suffix}`,metaSchema:'https://zitadel.com/schemas/v1/user-schema.json',kind:'user-schema',type:'object','x-identifier':'email','x-auth-methods':{password:{enabled:true}},properties:{email:{type:'string',format:'email','x-unique':'project'}}});
 async function run(base,f,workerSide) {
  const api=client(base,f),session=api.session(await api.exchange(await api.mint())),origin=new URL(base).origin,out={};
  async function req(method,path,{token,cookie,body,headers={}}={}){const h={accept:'application/json',...headers};if(token)h.authorization=`Bearer ${token}`;if(cookie)h.cookie=cookie;if(body!==undefined)h['content-type']='application/json';const r=await fetch(base+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=text?JSON.parse(text):null;}catch{data=text;}return{status:r.status,data};}
  const record=(name,r)=>{out[name]={status:r.status,code:r.data?.code??null};return r};
  const path=`/schemas?project_id=${encodeURIComponent(f.projectId)}`;
  const audit=async()=>{if(workerSide){const r=await(await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'events'})})).json();return r.events.find(e=>e.event_type==='schema.created')?.count??0;}return db.prepare("SELECT count(*) AS n FROM events WHERE project_id=? AND event_type='schema.created'").get(f.projectId).n;};
  const missing=record('publish missing auth',await req('POST',path,{body:schema('missing')}));assert.equal(missing.status,401);
  const foreignResult=record('publish foreign credential',await req('POST',path,{token:f.otherProjectSecret,body:schema('foreign')}));assert.ok(foreignResult.status>=400&&foreignResult.status<500);
  const foreignControl=await req('POST','/auth_attempts',{token:f.otherProjectSecret,body:{project_id:f.otherProjectId}});out.foreignControl={status:foreignControl.status,code:foreignControl.data?.code??null};assert.equal(foreignControl.status,workerSide?403:201);
  const csrf=await req('GET',`/sessions/me/csrf?project_id=${encodeURIComponent(f.projectId)}`,{cookie:session.cookie});assert.equal(csrf.status,200);
  const noCsrf=record('publish session missing csrf',await req('POST',path,{cookie:session.cookie,headers:{origin},body:schema('no-csrf')}));assert.ok([401,403].includes(noCsrf.status));
  const wrongOrigin=record('publish cross origin',await req('POST',path,{cookie:session.cookie,headers:{origin:'https://evil.example','x-zitadel-csrf':csrf.data.csrf_token},body:schema('cross-origin')}));assert.ok([401,403].includes(wrongOrigin.status));
  const unprivileged=record('publish unprivileged',await req('POST',path,{cookie:session.cookie,headers:{origin,'x-zitadel-csrf':csrf.data.csrf_token},body:schema('unprivileged')}));assert.ok([401,403,404].includes(unprivileged.status));
  const before=await audit();
  const bad=record('invalid schema',await req('POST',path,{token:f.projectSecret,body:{...schema('invalid'),'x-identifier':'not-a-field'}}));assert.equal(bad.status,400);assert.equal(await audit(),before);
  if(workerSide){const listBefore=await req('GET',path+'&limit=100',{token:f.projectSecret});assert.equal(listBefore.status,200);await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failure=await req('POST',path,{token:f.projectSecret,body:schema('rollback')});assert.equal(failure.status,500);assert.equal(await audit(),before);const listAfter=await req('GET',path+'&limit=100',{token:f.projectSecret});assert.deepEqual(listAfter.data,listBefore.data,'failed schema publication persisted');}
  const made=record('publish',await req('POST',path,{token:f.projectSecret,body:schema('one')}));assert.equal(made.status,201,JSON.stringify(made.data));assert.equal(made.data.id,schema('one').$id);assert.equal(await audit(),before+1);
  const duplicate=record('duplicate id',await req('POST',path,{token:f.projectSecret,body:schema('one')}));assert.equal(duplicate.status,409);assert.equal(await audit(),before+1);
  const later=record('revision',await req('POST',path,{token:f.projectSecret,body:schema('two')}));assert.equal(later.status,201,JSON.stringify(later.data));assert.equal(await audit(),before+2);
  const race=await Promise.all([1,2].map(()=>req('POST',path,{token:f.projectSecret,body:schema('race')})));assert.deepEqual(race.map(x=>x.status).sort(),[201,409]);assert.equal(await audit(),before+3);out.race=1;
  const read=record('read',await req('GET',`/api/v1/schemas/${encodeURIComponent(schema('one').$id)}?project_id=${encodeURIComponent(f.projectId)}`,{token:f.projectSecret}));assert.equal(read.status,200,JSON.stringify(read.data));assert.equal(read.data.id,schema('one').$id);assert.deepEqual(read.data.schema,made.data.schema,'published revision changed after later writes');
  let next='',pages=0;const seen=new Set();do{const u=path+'&limit=1'+(next?'&page_token='+encodeURIComponent(next):'');const page=await req('GET',u,{token:f.projectSecret});assert.equal(page.status,200);for(const item of page.data.schemas){assert.ok(!seen.has(item.id));seen.add(item.id);}next=page.data.next_page_token??'';if(++pages>30)throw Error('schema pagination loop');}while(next);
  assert.ok(seen.has(schema('one').$id)&&seen.has(schema('two').$id)&&seen.has(schema('race').$id));out.createdAndPaged=3;
  const filtered=path+'&object_type='+encodeURIComponent(`test-${suffix}`)+'&kind=user-schema';
  const all=await req('GET',filtered+'&limit=1',{token:f.projectSecret});assert.equal(all.status,200);assert.equal(all.data.schemas.length,1);assert.ok(all.data.next_page_token);
  const mismatchedCursor=record('revision cursor mismatch',await req('GET',filtered+'&revisions=latest&limit=1&page_token='+encodeURIComponent(all.data.next_page_token),{token:f.projectSecret}));assert.equal(mismatchedCursor.status,400);
  const latest=await req('GET',filtered+'&revisions=latest',{token:f.projectSecret});assert.equal(latest.status,200);assert.equal(latest.data.schemas.length,1);assert.ok([schema('one').$id,schema('two').$id,schema('race').$id].includes(latest.data.schemas[0].id));out.latestCount=1;
  const invalidCursor=record('invalid cursor',await req('GET',path+'&limit=1&page_token=invalid',{token:f.projectSecret}));assert.equal(invalidCursor.status,400);
  const listMissing=record('list missing auth',await req('GET',path));assert.equal(listMissing.status,401);
  const listUser=record('list unprivileged session',await req('GET',path,{cookie:session.cookie}));assert.ok([403,404].includes(listUser.status));
  if(workerSide){const evicted=await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'evict'})});assert.equal(evicted.status,500);const after=await req('GET',`/schemas/${encodeURIComponent(schema('one').$id)}?project_id=${encodeURIComponent(f.projectId)}`,{token:f.projectSecret});assert.equal(after.status,200);assert.equal(await audit(),before+3);}
  return out;
 }
 const a=await run(nf.baseUrl,nf,false),b=await run(worker,wf,true);console.log(JSON.stringify({native:a,worker:b},null,2));
 for(const key of Object.keys(a)){if(key==='foreignControl'||key==='publish foreign credential')continue;assert.deepEqual(b[key],a[key],key);}
 console.log('Native/workerd schema publish/read/list, revisions, audit rollback and pagination compared; foreign status reported.');
}catch(e){if(logs)console.error(logs);throw e;}finally{if(db)db.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}if(native)await native.stop();await rm(dir,{recursive:true,force:true});}
