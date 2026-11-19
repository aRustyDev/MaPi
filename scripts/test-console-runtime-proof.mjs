import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {startLocalZitadel} from '@zitadel/testing';
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-console-runtime-'));let server,native,logs='';
try{
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'Native console runtime'});
 const nativeRuntime=await fetch(native.handle.baseUrl+'/console/runtime.json');assert.equal(nativeRuntime.status,200);assert.equal(nativeRuntime.headers.get('cache-control'),'no-store');const nativeMeta=await nativeRuntime.json();assert.equal(nativeMeta.mode,'standalone');assert.ok(nativeMeta.console_project_id);assert.ok(nativeMeta.publishable_key);assert.ok(nativeMeta.publishable_key!==native.handle.projectSecret,'native preview key differs from project secret');
 async function nativeQuery(token,projectId){const r=await fetch(native.handle.baseUrl+`/users/query?project_id=${projectId}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});return r.status;}
 const nativePreviewStatus=await nativeQuery(nativeMeta.publishable_key,nativeMeta.console_project_id),nativeAdminStatus=await nativeQuery(native.handle.projectSecret,native.handle.projectId);assert.ok(nativePreviewStatus>=400&&nativePreviewStatus<500);assert.equal(nativeAdminStatus,200);
 const p=await port(),inspector=await port(),origin=`http://127.0.0.1:${p}`,otherOrigin=`http://localhost:${p}`,operator=randomBytes(32).toString('base64url');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 const vars=resolve(dir,'vars');await writeFile(vars,`MAPI_APP_ORIGIN=${origin}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify({id:'master-test',pem:privateKey})).toString('base64')}\nMAPI_LOCAL_TEST=1\n`,{mode:0o600});
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/console-runtime-proof.wrangler.jsonc','--env-file',vars,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});server.stderr.on('data',c=>logs=(logs+c).slice(-8000));
 const send=(host,path,{method='GET',headers={},body}={})=>fetch(`http://${host}`+path,{method,headers:{...headers},body:body===undefined?undefined:JSON.stringify(body)});
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await send(`127.0.0.1:${p}`,'/console/runtime.json');break}catch{await setTimeout(200)}}
 const h1=`127.0.0.1:${p}`,h2=`localhost:${p}`,auth={authorization:`Bearer ${operator}`,'content-type':'application/json'};
 assert.equal((await send(h1,'/console/runtime.json')).status,503);
 assert.equal((await send(h1,'/console/runtime.json',{headers:{origin:'https://attacker.example'}})).status,403);
 const create=async(o)=>{const r=await send(h1,'/_mapi/admin/projects',{method:'POST',headers:auth,body:{name:'Console synthetic project',origin:o}});if(r.status!==200)throw Error(`project creation status ${r.status}`);return (await r.json()).projectId;};
 const p1=await create(origin),p2=await create(otherOrigin);assert.notEqual(p1,p2);
 const runtime=async(host)=>{const r=await send(host,'/console/runtime.json');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');return r.json();};
 const burst=await Promise.all(Array.from({length:8},()=>runtime(h1)));assert.ok(burst.every(m=>m.console_project_id===p1&&m.publishable_key));
 const m1=await runtime(h1),m2=await runtime(h2);assert.equal(m1.mode,nativeMeta.mode);assert.equal(m1.console_project_id,p1);assert.equal(m2.console_project_id,p2);assert.ok(m1.publishable_key&&m2.publishable_key);assert.ok(m1.publishable_key!==m2.publishable_key,'project preview keys differ');
 const again=await runtime(h1);assert.equal(again.console_project_id,p1);assert.ok(again.publishable_key,'second runtime returns a preview key');
 assert.equal((await send(h1,'/console/runtime.json',{headers:{origin:otherOrigin}})).status,403);
 const spoof=await send(h1,'/console/runtime.json',{headers:{'x-forwarded-host':h2,'x-forwarded-proto':'https'}});assert.equal(spoof.status,200);assert.equal((await spoof.json()).console_project_id,p1);
 assert.equal((await send(h1,'/console/runtime.json',{method:'POST'})).status,405);const head=await send(h1,'/console/runtime.json',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const fence=async(body)=>send(h1,'/__test/owner-fence',{method:'POST',headers:auth,body});assert.equal((await fence({projectId:p1,origin})).status,204);assert.equal((await fence({projectId:p2,origin})).status,503);assert.equal((await fence({projectId:p1,origin:otherOrigin})).status,503);
 const secret=async(host)=>{const r=await send(host,'/__test/project-token',{method:'POST',headers:auth,body:{}});assert.equal(r.status,200);return (await r.json()).token;};const s1=await secret(h1);assert.ok(s1!==m1.publishable_key,'preview key differs from project secret');
 const query=async(host,token)=>{const r=await send(host,'/__test/users/query',{method:'POST',headers:{...auth,'x-test-token':token},body:{}});return r.status;};
 const preview=await query(h1,m1.publishable_key),admin=await query(h1,s1),foreign=await query(h2,m1.publishable_key);assert.ok(preview>=400&&preview<500);assert.equal(admin,200);assert.ok(foreign>=400&&foreign<500);assert.equal(preview,nativePreviewStatus);
 assert.equal((await send(h1,'/__test/project-token',{method:'POST',headers:{authorization:'Bearer wrong'},body:{}})).status,404);
 // Restart workerd with the same isolated persistent storage and key.
 {const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/console-runtime-proof.wrangler.jsonc','--env-file',vars,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});server.stderr.on('data',c=>logs=(logs+c).slice(-8000));
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('restarted workerd not ready');try{await send(h1,'/console/runtime.json');break}catch{await setTimeout(200)}}
 const restored=await runtime(h1);assert.equal(restored.console_project_id,p1);assert.ok(restored.publishable_key);assert.equal(await query(h1,restored.publishable_key),preview);assert.equal((await runtime(h2)).console_project_id,p2);
 console.log(JSON.stringify({nativePreviewStatus,nativeAdminStatus,workerPreviewStatus:preview,workerAdminStatus:admin,crossProjectPreviewStatus:foreign,projects:2,ownerFence:'passed',originFence:'passed',restart:'passed',runtime:'passed'}));
}catch(e){if(logs)console.error(logs);throw e;}finally{if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}await native?.stop();await rm(dir,{recursive:true,force:true});}
