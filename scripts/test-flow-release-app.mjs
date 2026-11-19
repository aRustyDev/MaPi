// Isolated real-app operator CLI and release behavior test. No deployment.
import assert from 'node:assert/strict';
import { generateKeyPairSync,randomBytes } from 'node:crypto';
import { spawn,execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import https from 'node:https';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';

const temp=await mkdtemp(resolve(tmpdir(),'mapi-flow-release-app-'));let worker;
try{
 if(process.env.MAPI_TEST_PREBUILT!=='1'){
  execFileSync('bash',['scripts/build-oidc.sh'],{stdio:'inherit'});
  execFileSync(process.execPath,['scripts/baseline.mjs'],{stdio:'inherit'});
  execFileSync(process.execPath,['scripts/build-login-assets.mjs'],{stdio:'inherit'});
 }
 const cert=resolve(temp,'cert.pem'),key=resolve(temp,'key.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});const ca=await readFile(cert);
 async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
 const p=await port(),inspector=await port(),origin=`https://127.0.0.1:${p}`,operator=randomBytes(32).toString('base64url');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 const variables=resolve(temp,'worker.env');await writeFile(variables,`MAPI_APP_ORIGIN=${origin}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify({id:'master-test',pem:privateKey})).toString('base64')}\nMAPI_LOCAL_TEST=1\n`,{mode:0o600});
 worker=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','wrangler.oidc-local.jsonc','--env-file',variables,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--local-protocol','https','--https-key-path',key,'--https-cert-path',cert,'--persist-to',resolve(temp,'storage')],{stdio:['ignore','ignore','inherit'],env:{...process.env,WRANGLER_LOG_PATH:resolve(temp,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 const request=(path,{method='GET',headers={},body=''}={})=>new Promise((done,fail)=>{const req=https.request({hostname:'127.0.0.1',port:p,path,method,ca,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>done({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on('error',fail);req.end(body);});
 let ready=false;for(let i=0;i<100;i++){if(worker.exitCode!==null)throw Error('workerd exited');try{await request('/livez');ready=true;break;}catch{await setTimeout(200);}}if(!ready)throw Error('workerd not ready');
 const admin=(path,body)=>request(path,{method:'POST',headers:{authorization:`Bearer ${operator}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const init=await admin('/_mapi/admin/init',{name:'Flow operator test'});assert.equal(init.status,200);const project=JSON.parse(init.body).projectId;
 assert.equal((await request('/_mapi/admin/oidc/flow/status',{method:'POST',headers:{authorization:'Bearer invalid','content-type':'application/json'},body:'{}'})).status,404);
 async function cli(args){const child=spawn(process.execPath,['scripts/mapi.mjs',...args],{env:{...process.env,MAPI_URL:origin,MAPI_OPERATOR_TOKEN:operator,NODE_EXTRA_CA_CERTS:cert},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);const [code]=await once(child,'exit');return {code,out,err};}
 const cmd=async(args)=>{const result=await cli(args);assert.equal(result.code,0,result.err);return JSON.parse(result.out);};
 const status=()=>cmd(['admin','oidc','flow','status']);
 const counts=async()=>{const r=await request('/_mapi/admin/test/counts',{headers:{authorization:`Bearer ${operator}`}});assert.equal(r.status,200);return JSON.parse(r.body);};
 const start=async()=>{const r=await request('/__nextgen/api/v1/flows',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({project_id:project,purpose:'login'})});assert.equal(r.status,201,r.body);return JSON.parse(r.body).step.name;};
 const initial=await status();assert.equal(initial.loginFlows.length,1);assert.equal(await start(),'identifier');
 const document=JSON.parse(await readFile('.mapi/nextgen/packages/config/defaults/default-login.json','utf8'));document.name=initial.loginFlows[0].name;document.steps[0].name='identifier_custom';document.purposes.login='identifier_custom';
 for(const step of document.steps)for(const transition of Object.values(step.transitions??{}))if(transition.target==='identifier')transition.target='identifier_custom';
 const file=resolve(temp,'flow.json');await writeFile(file,JSON.stringify(document));const invalid=resolve(temp,'invalid.json');await writeFile(invalid,JSON.stringify({name:document.name,steps:[]}));
 const snapshot=await counts();
 assert.notEqual((await cli(['admin','oidc','flow','publish','--file',invalid,'--expected-deployment',initial.deploymentId])).code,0);
 assert.notEqual((await cli(['admin','oidc','flow','publish','--file',file,'--expected-deployment','stale'])).code,0);
 assert.deepEqual(await counts(),snapshot);
 assert.equal((await admin('/_mapi/admin/test/fail-audit',{})).status,204);
 assert.notEqual((await cli(['admin','oidc','flow','publish','--file',file,'--expected-deployment',initial.deploymentId])).code,0);
 assert.deepEqual(await counts(),snapshot);assert.equal((await status()).deploymentId,initial.deploymentId);
 const published=await cmd(['admin','oidc','flow','publish','--file',file,'--expected-deployment',initial.deploymentId]);assert.notEqual(published.deploymentId,initial.deploymentId);
 const afterPublish=await counts();assert(afterPublish.events>=snapshot.events+3,'flow, release, and deployment audit events expected');
 assert.equal(await start(),'identifier_custom');
 const beforeRollback=await counts();
 assert.notEqual((await cli(['admin','oidc','flow','rollback','--target-deployment',initial.deploymentId,'--expected-deployment',initial.deploymentId])).code,0);
 assert.deepEqual(await counts(),beforeRollback);
 const rolled=await cmd(['admin','oidc','flow','rollback','--target-deployment',initial.deploymentId,'--expected-deployment',published.deploymentId]);assert.equal(rolled.releaseId,initial.releaseId);
 const afterRollback=await counts();assert(afterRollback.events>=beforeRollback.events+1,'rollback deployment audit event expected');
 assert.equal(await start(),'identifier');assert.equal((await status()).releaseId,initial.releaseId);
 console.log('Real local Worker and operator CLI: flow publication changes the live login step, rollback restores it, stale writes and invalid config fail, and audit failures roll back.');
}finally{if(worker&&worker.exitCode===null&&worker.signalCode===null){const stopped=once(worker,'exit');worker.kill('SIGTERM');await stopped;}await rm(temp,{recursive:true,force:true});}
