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
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(done=>s.close(done));return p;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-release-variables-parity-'));let native,server,db,logs='';
try {
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'Release parity'});
 const user=await native.seedUser(),foreign=await bootstrapProject({baseUrl:native.handle.baseUrl,projectName:'Foreign release project'});
 const nf={...native.handle,user,otherProjectId:foreign.projectId,otherProjectSecret:foreign.projectSecret};
 const wf=JSON.parse(await readFile('.mapi/fixture.json','utf8'));
 db=new DatabaseSync(resolve(dir,'native/.zitadel/local/nextgen-data/zitadel.db'));
 const p=await port(),inspector=await port();
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/release-variables-test.wrangler.jsonc','--env-file',resolve('.dev.vars.poc'),'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 server.stderr.on('data',c=>logs=(logs+c).slice(-8000));const worker=`http://127.0.0.1:${p}`;
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await fetch(worker+'/livez');break;}catch{await setTimeout(200);}}
 async function run(base,f,workerSide){
  const api=client(base,f),session=api.session(await api.exchange(await api.mint())),origin=new URL(base).origin,out={};
  async function req(method,path,{token,cookie,body,headers={}}={}){const h={accept:'application/json',...headers};if(token)h.authorization=`Bearer ${token}`;if(cookie)h.cookie=cookie;if(body!==undefined)h['content-type']='application/json';const r=await fetch(base+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=text?JSON.parse(text):null;}catch{data=text;}return{status:r.status,data};}
  const record=(key,r)=>{out[key]={status:r.status,code:r.data?.code??null};return r};
  const qp=`?project_id=${encodeURIComponent(f.projectId)}`, releases='/releases'+qp, deployments='/deployments'+qp;
  const initial=await req('GET',releases,{token:f.projectSecret});assert.equal(initial.status,200,JSON.stringify(initial.data));assert.ok(initial.data.releases.length);const oldID=initial.data.releases[0].id;
  const old=await req('GET',`/releases/${oldID}${qp}`,{token:f.projectSecret});assert.equal(old.status,200);const pointers=old.data.pointers.map(({kind,revision_id})=>({kind,revision_id}));
  const primary=await req('GET',deployments,{token:f.projectSecret});assert.equal(primary.status,200,JSON.stringify(primary.data));assert.ok(primary.data.deployments.length);const firstDeploy=primary.data.deployments[0].id;
  const audit=async(type)=>{if(workerSide){const r=await(await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'events'})})).json();return r.events.find(e=>e.event_type===type)?.count??0;}return db.prepare('SELECT count(*) AS n FROM events WHERE project_id=? AND event_type=?').get(f.projectId,type).n;};
  const variablePath='/variables'+qp+'&kind=primary';
  const missing=record('missing credential',await req('GET',variablePath));assert.equal(missing.status,401);
  const foreignCred=record('foreign credential',await req('GET',variablePath,{token:f.otherProjectSecret}));assert.ok(foreignCred.status>=400&&foreignCred.status<500);
  const csrf=await req('GET',`/sessions/me/csrf${qp}`,{cookie:session.cookie});assert.equal(csrf.status,200);
  const unpriv=record('session unprivileged',await req('PATCH',variablePath,{cookie:session.cookie,headers:{origin,'x-zitadel-csrf':csrf.data.csrf_token},body:{MAPI_VALUE:'no'}}));assert.ok([401,403,404].includes(unpriv.status));
  const before=await audit('variable.set'),secret='synthetic-variable-value-not-for-display';
  const empty=record('empty patch',await req('PATCH',variablePath,{token:f.projectSecret,body:{}}));assert.equal(empty.status,400);assert.equal(await audit('variable.set'),before);
  if(workerSide){await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('PATCH',variablePath,{token:f.projectSecret,body:{MAPI_VALUE:'not-committed',MAPI_SECRET:{value:secret,secret:true}}});assert.equal(failed.status,500);assert.equal(await audit('variable.set'),before);const after=await req('GET',variablePath,{token:f.projectSecret});assert.ok(!JSON.stringify(after.data).includes('not-committed'));assert.ok(!JSON.stringify(after.data).includes(secret));}
  const set=record('set variables',await req('PATCH',variablePath,{token:f.projectSecret,body:{MAPI_VALUE:'first',MAPI_SECRET:{value:secret,secret:true}}}));assert.equal(set.status,200,JSON.stringify(set.data));assert.ok(!JSON.stringify(set.data).includes(secret));assert.equal(await audit('variable.set'),before+2);
  const lookup=record('get variable',await req('GET',`/variables/MAPI_VALUE${qp}&kind=primary`,{token:f.projectSecret}));assert.equal(lookup.status,200);assert.equal(lookup.data.primary,'first');
  const secretRead=await req('GET',`/variables/MAPI_SECRET${qp}&kind=primary`,{token:f.projectSecret});assert.equal(secretRead.status,200);assert.ok(!JSON.stringify(secretRead.data).includes(secret));
  const schemaPointers=pointers.filter(x=>x.kind==='schema');const release=await req('POST',releases,{token:f.projectSecret,body:{pointers:schemaPointers}});assert.equal(release.status,201,JSON.stringify(release.data));
  const deploy=record('deploy',await req('POST',deployments,{token:f.projectSecret,body:{release_id:release.data.id,targets:'primary'}}));assert.equal(deploy.status,201);const first=deploy.data.id;
  const vars=await req('GET',`/deployments/${first}/variables${qp}`,{token:f.projectSecret});assert.equal(vars.status,200);assert.equal(vars.data.MAPI_VALUE,'first');assert.ok(!JSON.stringify(vars.data).includes(secret));
  if(workerSide){const proof=await(await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'variable_storage_proof',id:secret})})).json();assert.deepEqual(proof,{encrypted:true,setsRedacted:true,auditRedacted:true});}
  else{const row=db.prepare("SELECT value,is_secret FROM variables WHERE project_id=? AND name='MAPI_SECRET'").get(f.projectId);assert.equal(row.is_secret,1);assert.ok(!row.value.includes(secret));const sets=db.prepare('SELECT entries FROM variable_sets WHERE project_id=?').all(f.projectId);assert.ok(sets.length&&sets.every(x=>!x.entries.includes(secret)));const events=db.prepare("SELECT payload FROM events WHERE project_id=? AND event_type IN ('variable.set','variable.removed')").all(f.projectId);assert.ok(events.length&&events.every(x=>!x.payload.includes(secret)));}
  const changed=record('change variables',await req('PATCH',variablePath,{token:f.projectSecret,body:{MAPI_VALUE:'second'}}));assert.equal(changed.status,200);assert.equal(await audit('variable.set'),before+3);
  const frozen=await req('GET',`/deployments/${first}/variables${qp}`,{token:f.projectSecret});assert.equal(frozen.status,200);assert.equal(frozen.data.MAPI_VALUE,'first');assert.ok(!JSON.stringify(frozen.data).includes(secret));
  const redeploy=record('deploy changed variables',await req('POST',deployments,{token:f.projectSecret,body:{release_id:release.data.id,targets:'primary'}}));assert.equal(redeploy.status,201);assert.notEqual(redeploy.data.id,first);const second=await req('GET',`/deployments/${redeploy.data.id}/variables${qp}`,{token:f.projectSecret});assert.equal(second.data.MAPI_VALUE,'second');
  const rollback=record('rollback frozen variables',await req('POST',`/deployments/${first}/rollback${qp}`,{token:f.projectSecret,body:{expected_deployment_id:redeploy.data.id}}));assert.equal(rollback.status,201);const restored=await req('GET',`/deployments/${rollback.data.id}/variables${qp}`,{token:f.projectSecret});assert.equal(restored.status,200);assert.equal(restored.data.MAPI_VALUE,'first');assert.ok(!JSON.stringify(restored.data).includes(secret));
  const removedBefore=await audit('variable.removed');const remove=record('remove variable',await req('DELETE',`/variables/MAPI_VALUE${qp}&kind=primary`,{token:f.projectSecret}));assert.equal(remove.status,204);assert.equal(await audit('variable.removed'),removedBefore+1);
  const absent=record('removed variable missing',await req('GET',`/variables/MAPI_VALUE${qp}&kind=primary`,{token:f.projectSecret}));assert.equal(absent.status,404);
  assert.equal((await req('GET',`/deployments/${first}/variables${qp}`,{token:f.projectSecret})).data.MAPI_VALUE,'first');
  if(workerSide){const evicted=await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'evict'})});assert.equal(evicted.status,500);const after=await req('GET',`/deployments/${rollback.data.id}/variables${qp}`,{token:f.projectSecret});assert.equal(after.status,200);assert.equal(after.data.MAPI_VALUE,'first');assert.ok(!JSON.stringify(after.data).includes(secret));}
  return out;
 }
 const a=await run(nf.baseUrl,nf,false),b=await run(worker,wf,true);console.log(JSON.stringify({native:a,worker:b},null,2));for(const key of Object.keys(a)){if(key==='foreign credential')continue;assert.deepEqual(b[key],a[key],key);}console.log('Native/workerd variable encryption, frozen deployment snapshots and rollback compared; foreign credential status reported.');
}catch(e){if(logs)console.error(logs);throw e;}finally{if(db)db.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}if(native)await native.stop();await rm(dir,{recursive:true,force:true});}
