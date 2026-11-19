import assert from 'node:assert/strict';
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

async function port() { const s=createServer().listen(0,'127.0.0.1'); await once(s,'listening'); const p=s.address().port; await new Promise(done=>s.close(done)); return p; }
const dir=await mkdtemp(resolve(tmpdir(),'mapi-branding-parity-')); let native,server,db,logs='';
try {
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'Branding parity'});
 const user=await native.seedUser(), foreign=await bootstrapProject({baseUrl:native.handle.baseUrl,projectName:'Foreign branding project'});
 const nf={...native.handle,user,otherProjectId:foreign.projectId,otherProjectSecret:foreign.projectSecret};
 const wf=JSON.parse(await readFile('.mapi/fixture.json','utf8'));
 db=new DatabaseSync(resolve(dir,'native/.zitadel/local/nextgen-data/zitadel.db'));
 const p=await port(),inspector=await port();
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/branding-test.wrangler.jsonc','--env-file',resolve('.dev.vars.poc'),'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 server.stderr.on('data',c=>logs=(logs+c).slice(-8000)); const worker=`http://127.0.0.1:${p}`;
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await fetch(worker+'/livez');break;}catch{await setTimeout(200);}}
 async function run(base,f,workerSide) {
  const api=client(base,f),session=api.session(await api.exchange(await api.mint())),origin=new URL(base).origin,out={};
  async function req(method,path,{token,cookie,body,headers={}}={}){const h={accept:'application/json',...headers};if(token)h.authorization=`Bearer ${token}`;if(cookie)h.cookie=cookie;if(body!==undefined)h['content-type']='application/json';const r=await fetch(base+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=text?JSON.parse(text):null;}catch{data=text;}return{status:r.status,data};}
  const record=(key,r)=>{out[key]={status:r.status,code:r.data?.code??null};return r};
  const path=`/branding?project_id=${encodeURIComponent(f.projectId)}`;
  const audit=async()=>{if(workerSide){const r=await(await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'events'})})).json();return r.events.find(e=>e.event_type==='branding.created')?.count??0;}return db.prepare("SELECT count(*) AS n FROM events WHERE project_id=? AND event_type='branding.created'").get(f.projectId).n;};
  const payloads=async()=>{if(workerSide)return (await(await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'branding_payloads'})})).json());return db.prepare("SELECT payload FROM events WHERE project_id=? AND event_type='branding.created'").all(f.projectId).map(x=>x.payload);};
  const no=record('publish missing auth',await req('POST',path,{body:{layout:'centered'}}));assert.equal(no.status,401);
  const foreignResult=record('publish foreign credential',await req('POST',path,{token:f.otherProjectSecret,body:{layout:'centered'}}));assert.ok(foreignResult.status>=400&&foreignResult.status<500);
  const foreignControl=await req('POST','/auth_attempts',{token:f.otherProjectSecret,body:{project_id:f.otherProjectId}});out.foreignControl={status:foreignControl.status,code:foreignControl.data?.code??null};assert.equal(foreignControl.status,workerSide?403:201);
  const csrf=await req('GET',`/sessions/me/csrf?project_id=${encodeURIComponent(f.projectId)}`,{cookie:session.cookie});assert.equal(csrf.status,200);
  const missing=record('publish missing csrf',await req('POST',path,{cookie:session.cookie,headers:{origin},body:{layout:'centered'}}));assert.equal(missing.status,401);
  const unprivileged=record('publish unprivileged',await req('POST',path,{cookie:session.cookie,headers:{origin,'x-zitadel-csrf':csrf.data.csrf_token},body:{layout:'centered'}}));assert.equal(unprivileged.status,401);
  const cross=record('publish cross origin',await req('POST',path,{cookie:session.cookie,headers:{origin:'https://evil.example','x-zitadel-csrf':csrf.data.csrf_token},body:{layout:'centered'}}));assert.equal(cross.status,401);
  const before=await audit();
  const invalid=record('reject script template',await req('POST',path,{token:f.projectSecret,body:{liquid_template:'<script>alert(1)</script>'}}));assert.equal(invalid.status,400);assert.equal(await audit(),before);
  const invalidLayout=record('reject layout',await req('POST',path,{token:f.projectSecret,body:{layout:'other'}}));assert.equal(invalidLayout.status,400);assert.equal(await audit(),before);
  if(workerSide){const listBefore=await req('GET',path+'&limit=100',{token:f.projectSecret});assert.equal(listBefore.status,200);await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('POST',path,{token:f.projectSecret,body:{liquid_template:'<div>rollback-marker</div>'}});assert.equal(failed.status,500);assert.equal(await audit(),before);const listAfter=await req('GET',path+'&limit=100',{token:f.projectSecret});assert.deepEqual(listAfter.data,listBefore.data,'failed publication persisted a revision');}
  const template='<div>template-private-marker {{ step.name }}</div>';
  const made=record('publish',await req('POST',path,{token:f.projectSecret,body:{layout:'split',liquid_template:template,logo_url:'https://assets.example.test/logo.svg'}}));assert.equal(made.status,201);assert.equal(made.data.branding.liquid_template,template);assert.equal(await audit(),before+1);
  const id=made.data.id;assert.ok(id);
  const read=record('read',await req('GET',`/api/v1/branding/${id}`,{token:f.projectSecret}));assert.equal(read.status,200);assert.equal(read.data.branding.liquid_template,template);assert.equal(read.data.branding.layout,'split');
  const sessionRead=record('read unprivileged session',await req('GET',`/branding/${id}`,{cookie:session.cookie}));assert.ok([403,404].includes(sessionRead.status));
  const readMissing=record('read missing',await req('GET','/branding/brnd_00000000000000000000000000',{token:f.projectSecret}));assert.equal(readMissing.status,404);
  const duplicate=await Promise.all([1,2].map(()=>req('POST',path,{token:f.projectSecret,body:{layout:'centered'}})));assert.deepEqual(duplicate.map(x=>x.status),[201,201]);assert.notEqual(duplicate[0].data.id,duplicate[1].data.id);assert.equal(await audit(),before+3);
  let next='',pages=0;const seen=new Set();do{const u=path+'&limit=1'+(next?'&page_token='+encodeURIComponent(next):'');const page=await req('GET',u,{token:f.projectSecret});assert.equal(page.status,200);assert.ok(page.data.branding.length<=1);for(const b of page.data.branding){assert.ok(!seen.has(b.id));seen.add(b.id);}next=page.data.next_page_token??'';if(++pages>30)throw Error('branding pagination loop');}while(next);
  for(const item of [id,...duplicate.map(x=>x.data.id)])assert.ok(seen.has(item));assert.ok(pages>=3);out.createdAndPaged=3;
  const badCursor=record('invalid cursor',await req('GET',path+'&limit=1&page_token=invalid',{token:f.projectSecret}));assert.equal(badCursor.status,400);
  const noAuth=record('list missing auth',await req('GET',path));assert.equal(noAuth.status,401);
  const sessionList=record('list unprivileged session',await req('GET',path,{cookie:session.cookie}));assert.ok([403,404].includes(sessionList.status));
  for(const payload of await payloads()){assert.ok(!payload.includes('template-private-marker'),'audit leaked template');assert.ok(!payload.includes('rollback-marker'),'failed audit persisted');}
  if(workerSide){const evicted=await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'evict'})});assert.equal(evicted.status,500);const after=await req('GET',`/branding/${id}`,{token:f.projectSecret});assert.equal(after.status,200);assert.equal(after.data.branding.liquid_template,template);assert.equal(await audit(),before+3);}
  return out;
 }
 const a=await run(nf.baseUrl,nf,false),b=await run(worker,wf,true);console.log(JSON.stringify({native:a,worker:b},null,2));
 for(const key of Object.keys(a)){if(key==='foreignControl'||key==='publish foreign credential')continue;assert.deepEqual(b[key],a[key],key);}
 console.log('Native/workerd branding revisions, pagination, authorization, audit rollback and template redaction compared; foreign status reported.');
}catch(e){if(logs)console.error(logs);throw e;}finally{if(db)db.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}if(native)await native.stop();await rm(dir,{recursive:true,force:true});}
