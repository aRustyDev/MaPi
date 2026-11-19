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
const dir=await mkdtemp(resolve(tmpdir(),'mapi-release-deployment-parity-'));let native,server,db,logs='';
try {
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'Release parity'});
 const user=await native.seedUser(),foreign=await bootstrapProject({baseUrl:native.handle.baseUrl,projectName:'Foreign release project'});
 const nf={...native.handle,user,otherProjectId:foreign.projectId,otherProjectSecret:foreign.projectSecret};
 const wf=JSON.parse(await readFile('.mapi/fixture.json','utf8'));
 db=new DatabaseSync(resolve(dir,'native/.zitadel/local/nextgen-data/zitadel.db'));
 const p=await port(),inspector=await port();
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/release-deployment-test.wrangler.jsonc','--env-file',resolve('.dev.vars.poc'),'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
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
  const no=record('release missing credential',await req('GET',releases));assert.equal(no.status,401);
  const foreignCred=record('foreign credential',await req('GET',releases,{token:f.otherProjectSecret}));assert.ok(foreignCred.status>=400&&foreignCred.status<500);
  const foreignControl=await req('POST','/auth_attempts',{token:f.otherProjectSecret,body:{project_id:f.otherProjectId}});out.foreignControl={status:foreignControl.status,code:foreignControl.data?.code??null};assert.equal(foreignControl.status,workerSide?403:201);
  const csrf=await req('GET',`/sessions/me/csrf${qp}`,{cookie:session.cookie});assert.equal(csrf.status,200);
  const noCsrf=record('session missing csrf',await req('POST',releases,{cookie:session.cookie,headers:{origin},body:{pointers}}));assert.ok([401,403].includes(noCsrf.status));
  const wrongOrigin=record('session cross origin',await req('POST',releases,{cookie:session.cookie,headers:{origin:'https://evil.example','x-zitadel-csrf':csrf.data.csrf_token},body:{pointers}}));assert.ok([401,403].includes(wrongOrigin.status));
  const unpriv=record('session unprivileged',await req('GET',releases,{cookie:session.cookie}));assert.ok([403,404].includes(unpriv.status));
  const missing=record('missing release',await req('GET',`/releases/rel_00000000000000000000000000${qp}`,{token:f.projectSecret}));assert.equal(missing.status,404);
  const noPointers=record('empty release',await req('POST',releases,{token:f.projectSecret,body:{pointers:[]}}));assert.equal(noPointers.status,400);
  const releaseBefore=await audit('release.created'),deploymentBefore=await audit('deployment.created');
  const current=record('identical release',await req('POST',releases,{token:f.projectSecret,body:{pointers,message:'different metadata'}}));assert.equal(current.status,200);assert.equal(current.data.id,oldID);assert.equal(await audit('release.created'),releaseBefore);
  const inUse=record('revoke in use',await req('POST',`/releases/${oldID}/revoke${qp}`,{token:f.projectSecret}));assert.equal(inUse.status,409);
  const schemaPointers=pointers.filter(x=>x.kind==='schema');
  assert.ok(schemaPointers.length);
  if(workerSide){const before=await req('GET',releases,{token:f.projectSecret});await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('POST',releases,{token:f.projectSecret,body:{pointers:schemaPointers}});assert.equal(failed.status,500);assert.equal(await audit('release.created'),releaseBefore);assert.deepEqual((await req('GET',releases,{token:f.projectSecret})).data,before.data,'release survived failed audit');}
  const race=await Promise.all([1,2].map(()=>req('POST',releases,{token:f.projectSecret,body:{pointers:schemaPointers,message:'isolated'}})));assert.deepEqual(race.map(x=>x.status).sort(),[200,201]);assert.equal(race[0].data.id,race[1].data.id);const other=record('create release',race.find(x=>x.status===201));const otherID=other.data.id;assert.ok(otherID);assert.equal(await audit('release.created'),releaseBefore+1);out.releaseRace='one-created';
  const same=record('same release',await req('POST',releases,{token:f.projectSecret,body:{pointers:schemaPointers,message:'ignored change'}}));assert.equal(same.status,200);assert.equal(same.data.id,otherID);assert.equal(await audit('release.created'),releaseBefore+1);
  const guard=record('deployment stale guard',await req('POST',deployments,{token:f.projectSecret,body:{release_id:otherID,targets:'primary',expected_deployment_id:'dep_00000000000000000000000000'}}));assert.equal(guard.status,409);assert.equal(await audit('deployment.created'),deploymentBefore);
  const neither=record('deployment missing release',await req('POST',deployments,{token:f.projectSecret,body:{targets:'primary'}}));assert.equal(neither.status,400);
  const both=record('deployment both release forms',await req('POST',deployments,{token:f.projectSecret,body:{release_id:otherID,content_hash:old.data.content_hash,targets:'primary'}}));assert.equal(both.status,400);
  const digest=record('deploy content hash',await req('POST',deployments,{token:f.projectSecret,body:{content_hash:old.data.content_hash,targets:'primary'}}));assert.equal(digest.status,501,'pinned content-hash lookup should be unimplemented');
  if(workerSide){const before=await req('GET',deployments,{token:f.projectSecret});await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('POST',deployments,{token:f.projectSecret,body:{release_id:otherID,targets:'primary'}});assert.equal(failed.status,500);assert.equal(await audit('deployment.created'),deploymentBefore);assert.deepEqual((await req('GET',deployments,{token:f.projectSecret})).data,before.data,'deployment survived failed audit');}
  const deployed=record('deploy primary',await req('POST',deployments,{token:f.projectSecret,body:{release_id:otherID,targets:'primary',expected_deployment_id:firstDeploy}}));assert.equal(deployed.status,201,JSON.stringify(deployed.data));const secondDeploy=deployed.data.id;assert.equal(await audit('deployment.created'),deploymentBefore+1);
  const redeploy=record('idempotent deployment',await req('POST',deployments,{token:f.projectSecret,body:{release_id:otherID,targets:'primary'}}));assert.equal(redeploy.status,200);assert.equal(redeploy.data.id,secondDeploy);assert.equal(await audit('deployment.created'),deploymentBefore+1);
  const read=record('deployment read',await req('GET',`/api/v1/deployments/${secondDeploy}${qp}`,{token:f.projectSecret}));assert.equal(read.status,200);assert.equal(read.data.release_id,otherID);
  const variables=record('deployment variables',await req('GET',`/deployments/${secondDeploy}/variables${qp}`,{token:f.projectSecret}));assert.equal(variables.status,200);
  const badRollback=record('rollback stale guard',await req('POST',`/deployments/${firstDeploy}/rollback${qp}`,{token:f.projectSecret,body:{expected_deployment_id:firstDeploy}}));assert.equal(badRollback.status,409);assert.equal(await audit('deployment.created'),deploymentBefore+1);
  if(workerSide){const before=await req('GET',deployments,{token:f.projectSecret});await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('POST',`/deployments/${firstDeploy}/rollback${qp}`,{token:f.projectSecret,body:{expected_deployment_id:secondDeploy}});assert.equal(failed.status,500);assert.equal(await audit('deployment.created'),deploymentBefore+1);assert.deepEqual((await req('GET',deployments,{token:f.projectSecret})).data,before.data,'rollback survived failed audit');}
  const rollback=record('rollback',await req('POST',`/deployments/${firstDeploy}/rollback${qp}`,{token:f.projectSecret,body:{expected_deployment_id:secondDeploy}}));assert.equal(rollback.status,201,JSON.stringify(rollback.data));assert.equal(rollback.data.release_id,oldID);assert.equal(await audit('deployment.created'),deploymentBefore+2);
  const revokeBefore=await audit('release.revoked');
  if(workerSide){await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'fail_audit'})});const failed=await req('POST',`/releases/${otherID}/revoke${qp}`,{token:f.projectSecret});assert.equal(failed.status,500);assert.equal(await audit('release.revoked'),revokeBefore);assert.equal((await req('GET',`/releases/${otherID}${qp}`,{token:f.projectSecret})).data.revoked_at,null);}
  const revoked=record('revoke inactive',await req('POST',`/releases/${otherID}/revoke${qp}`,{token:f.projectSecret}));assert.equal(revoked.status,200);assert.ok(revoked.data.revoked_at);assert.equal(await audit('release.revoked'),revokeBefore+1);
  const denied=record('deploy revoked',await req('POST',deployments,{token:f.projectSecret,body:{release_id:otherID,targets:'primary'}}));assert.equal(denied.status,409);assert.equal(await audit('deployment.created'),deploymentBefore+2);
  let token='',pages=0,seen=new Set();do{const page=await req('GET',releases+'&limit=1'+(token?'&page_token='+encodeURIComponent(token):''),{token:f.projectSecret});assert.equal(page.status,200);for(const item of page.data.releases){assert.ok(!seen.has(item.id));seen.add(item.id)}token=page.data.next_page_token??'';if(++pages>30)throw Error('pagination loop')}while(token);assert.ok(seen.has(oldID)&&seen.has(otherID));out.paged=2;
  const allDeploy=await req('GET',deployments+'&limit=100&expand=release',{token:f.projectSecret});assert.equal(allDeploy.status,200);assert.ok(allDeploy.data.deployments.length>=3);assert.ok(allDeploy.data.deployments.every(x=>x.release?.id===x.release_id));out.expandedDeployments=true;
  const digestFilter=await req('GET',releases+'&content_hash='+encodeURIComponent('sha256:'+'0'.repeat(64)),{token:f.projectSecret});assert.equal(digestFilter.status,200);assert.ok(digestFilter.data.releases.length>=2,'pinned filter behavior changed');out.ignoredDigestFilter=true;
  const badCursor=record('invalid cursor',await req('GET',releases+'&page_token=invalid',{token:f.projectSecret}));assert.equal(badCursor.status,400);
  if(workerSide){const evicted=await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'evict'})});assert.equal(evicted.status,500);const after=await req('GET',`/deployments/${rollback.data.id}${qp}`,{token:f.projectSecret});assert.equal(after.status,200);assert.equal(after.data.release_id,oldID);assert.ok((await req('GET',`/releases/${otherID}${qp}`,{token:f.projectSecret})).data.revoked_at);}
  return out;
 }
 const a=await run(nf.baseUrl,nf,false),b=await run(worker,wf,true);console.log(JSON.stringify({native:a,worker:b},null,2));for(const key of Object.keys(a)){if(key==='foreign credential'||key==='foreignControl')continue;assert.deepEqual(b[key],a[key],key);}console.log('Native/workerd release and deployment parity passed; foreign credential status reported.');
}catch(e){if(logs)console.error(logs);throw e;}finally{if(db)db.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}if(native)await native.stop();await rm(dir,{recursive:true,force:true});}
