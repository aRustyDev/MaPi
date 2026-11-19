// Local-only two-project OIDC isolation test. Distinct synthetic DNS names
// prevent host-only cookies from being shared merely because ports differ.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

const temp=await mkdtemp(resolve(tmpdir(),'mapi-oidc-isolation-'));
let worker,proxy,rp,browser;
try {
 if(process.env.MAPI_TEST_PREBUILT!=='1'){
  execFileSync('bash',['scripts/build-oidc.sh'],{stdio:'inherit'});
  execFileSync(process.execPath,['scripts/baseline.mjs'],{stdio:'inherit'});
  execFileSync(process.execPath,['scripts/build-login-assets.mjs'],{stdio:'inherit'});
 }
 const cert=resolve(temp,'cert.pem'),key=resolve(temp,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=a.test','-addext','subjectAltName=DNS:a.test,DNS:b.test,DNS:rp.test,IP:127.0.0.1'],{stdio:'ignore'});
 const tls={key:await readFile(key),cert:await readFile(cert)};
 const certPin=createHash('sha256').update(createPublicKey(tls.cert).export({type:'spki',format:'der'})).digest('base64');
 async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
 const workPort=await port(),inspector=await port();
 const originA=`https://a.test:${workPort}`;
 const operator=randomBytes(32).toString('base64url');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 const variables=resolve(temp,'worker.env');
 await writeFile(variables,`MAPI_APP_ORIGIN=${originA}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify({id:'master-test',pem:privateKey})).toString('base64')}\nMAPI_LOCAL_TEST=1\n`,{mode:0o600});
 worker=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','wrangler.oidc-local.jsonc','--env-file',variables,'--ip','127.0.0.1','--port',String(workPort),'--inspector-port',String(inspector),'--local-protocol','https','--https-key-path',key,'--https-cert-path',cert,'--persist-to',resolve(temp,'storage')],{stdio:['ignore','ignore','inherit'],env:{...process.env,WRANGLER_LOG_PATH:resolve(temp,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 proxy=https.createServer(tls,(incoming,outgoing)=>{
  const target=https.request({hostname:'127.0.0.1',port:workPort,path:incoming.url,method:incoming.method,headers:incoming.headers,ca:tls.cert},res=>{outgoing.writeHead(res.statusCode,res.headers);res.pipe(outgoing);});
  target.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});incoming.pipe(target);
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const proxyPort=proxy.address().port,originB=`https://b.test:${proxyPort}`;
 const origins=[originA,originB],ports=[workPort,proxyPort],hosts=['a.test','b.test'];
 function request(index,path,{method='GET',headers={},body=''}={}){
  return new Promise((done,fail)=>{const req=https.request({hostname:'127.0.0.1',port:ports[index],path,method,headers:{host:`${hosts[index]}:${ports[index]}`,...headers},ca:tls.cert},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>done({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',fail);req.end(body);});
 }
 let ready=false;for(let i=0;i<100;i++){if(worker.exitCode!==null)throw Error('local workerd exited');try{await request(0,'/livez');ready=true;break;}catch{await setTimeout(200);}}if(!ready)throw Error('local Worker not ready');
 const clients=[],sharedClients=[],jwks=[],results=[],states=new Map(),errors=[];
 let rpOrigin;
 rp=https.createServer(tls,async(req,res)=>{
  try{
   const url=new URL(req.url,rpOrigin);
   if(url.pathname==='/start'){
    const i=Number(url.searchParams.get('project'));if(![0,1].includes(i))throw Error('invalid project');
    const state=randomBytes(24).toString('base64url'),nonce=randomBytes(24).toString('base64url'),verifier=randomBytes(48).toString('base64url');
    const challenge=createHash('sha256').update(verifier).digest('base64url');states.set(state,{i,nonce,verifier});
    const client=clients[i],query=new URLSearchParams({client_id:client.clientId,redirect_uri:`${rpOrigin}/callback/${i}`,response_type:'code',scope:'openid offline_access',state,nonce,code_challenge:challenge,code_challenge_method:'S256'});
    res.writeHead(302,{location:`${origins[i]}/oauth/${client.projectId}/authorize?${query}`});res.end();return;
   }
   const state=url.searchParams.get('state'),saved=states.get(state);if(!saved||url.pathname!==`/callback/${saved.i}`||!url.searchParams.get('code'))throw Error('invalid RP callback');states.delete(state);
   const {i,verifier,nonce}=saved,client=clients[i],form=new URLSearchParams({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:`${rpOrigin}/callback/${i}`,code_verifier:verifier});
   const headers={'content-type':'application/x-www-form-urlencoded',authorization:`Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret)}`).toString('base64')}`};
   const exchanged=await request(i,`/oauth/${client.projectId}/token`,{method:'POST',headers,body:form.toString()});if(exchanged.status!==200)throw Error(`project ${i} token exchange returned ${exchanged.status}`);
   const token=JSON.parse(exchanged.body),[header,payload,sig]=token.id_token.split('.'),meta=JSON.parse(Buffer.from(header,'base64url')),claims=JSON.parse(Buffer.from(payload,'base64url'));
   const key=jwks[i].keys.find(k=>k.kid===meta.kid);if(!key||!verify('RSA-SHA256',Buffer.from(`${header}.${payload}`),createPublicKey({key,format:'jwk'}),Buffer.from(sig,'base64url')))throw Error(`project ${i} signature failed`);
   if(claims.iss!==`${origins[i]}/oauth/${client.projectId}`||claims.nonce!==nonce||!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes(client.clientId)||!claims.sub||claims.exp<=Date.now()/1000)throw Error(`project ${i} claims failed`);
   results[i]={token,claims,header,payload,sig};res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(`<!doctype html><h1>RP project ${i} authenticated</h1>`);
  }catch(error){errors.push(error);res.writeHead(500);res.end('RP failed');}
 });
 rp.listen(0,'127.0.0.1');await once(rp,'listening');rpOrigin=`https://rp.test:${rp.address().port}`;
 const admin=(i,path,body)=>request(i,path,{method:'POST',headers:{authorization:`Bearer ${operator}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const first=await admin(0,'/_mapi/admin/init',{name:'Isolation primary'});assert.equal(first.status,200);const idA=JSON.parse(first.body).projectId;
 const second=await admin(0,'/_mapi/admin/projects',{name:'Isolation secondary',origin:originB});assert.equal(second.status,200);const idB=JSON.parse(second.body).projectId;assert.notEqual(idA,idB);
 const email=`projects-${randomUUID()}@example.test`,passwords=[`A-${randomUUID()}!`,`B-${randomUUID()}!`];
 for(let i=0;i<2;i++){
  const projectId=[idA,idB][i];assert.equal((await admin(i,'/_mapi/admin/users',{email,password:passwords[i]})).status,200);
  const initialized=await admin(i,'/_mapi/admin/oidc/init',{});assert.equal(initialized.status,200);assert.equal(JSON.parse(initialized.body).issuer,`${origins[i]}/oauth/${projectId}`);
  const doc={slug:`rp${i}`,name:`RP ${i}`,clients:[{slug:'web',client_id:`isolation-rp-${i}`,type:'confidential',grant_types:['authorization_code','refresh_token'],redirect_uris:[`${rpOrigin}/callback/${i}`]}]};
  const created=await admin(i,'/_mapi/admin/oidc/clients',{document:doc});assert.equal(created.status,200);const s=JSON.parse(created.body).Secrets[0];clients.push({projectId,clientId:s.ClientID,secret:s.Secret});
  const sharedDoc={slug:'shared-rp',name:'Shared client ID test',clients:[{slug:'web',client_id:'shared-rp-id',type:'confidential',grant_types:['authorization_code'],redirect_uris:[`${rpOrigin}/callback/${i}`]}]};
  const shared=await admin(i,'/_mapi/admin/oidc/clients',{document:sharedDoc});assert.equal(shared.status,200);sharedClients.push(JSON.parse(shared.body).Secrets[0]);
  const keys=await request(i,`/oauth/${projectId}/jwks`);assert.equal(keys.status,200);jwks.push(JSON.parse(keys.body));
 }
 assert.notEqual(clients[0].clientId,clients[1].clientId);assert.notEqual(clients[0].secret,clients[1].secret);assert.equal(sharedClients[0].ClientID,sharedClients[1].ClientID);assert.notEqual(sharedClients[0].Secret,sharedClients[1].Secret);
 assert.equal(jwks[0].keys.length,1);assert.equal(jwks[1].keys.length,1);assert.notEqual(jwks[0].keys[0].kid,jwks[1].keys[0].kid);assert.notEqual(jwks[0].keys[0].n,jwks[1].keys[0].n);
 browser=await chromium.launch({headless:true,args:['--no-proxy-server',`--ignore-certificate-errors-spki-list=${certPin}`,'--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1, MAP rp.test 127.0.0.1']});
 const contexts=await Promise.all(origins.map(()=>browser.newContext())),pages=await Promise.all(contexts.map(c=>c.newPage()));
 const unexpected=[],failed=[];for(const page of pages){page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(20000);page.on('request',req=>{const o=new URL(req.url()).origin;if(![...origins,rpOrigin].includes(o))unexpected.push(o);});page.on('requestfailed',req=>failed.push(`${new URL(req.url()).pathname}: ${req.failure()?.errorText}`));}
 // Identical email belongs to different projects, with separate passwords.
 for(let i=0;i<2;i++){
  await pages[i].goto(`${rpOrigin}/start?project=${i}`);await pages[i].getByLabel('Email').fill(email);await pages[i].getByRole('button',{name:'Continue',exact:true}).click();await pages[i].getByTestId('zitadel-input-password').fill(passwords[1-i]);await pages[i].getByRole('button',{name:'Sign in',exact:true}).click();await pages[i].getByRole('alert').getByText('Wrong email or password.').waitFor();
 }
 await Promise.all(pages.map(async(page,i)=>{
  await page.goto(`${rpOrigin}/start?project=${i}`);assert.equal(await page.locator('zitadel-login').count(),1);await page.getByLabel('Email').fill(email);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByTestId('zitadel-input-password').fill(passwords[i]);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL('**/oauth/continue?request=*');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('heading',{name:`RP project ${i} authenticated`}).waitFor();
 }));
 if(errors.length)throw errors[0];assert.deepEqual(unexpected,[]);assert.deepEqual(failed,[]);assert.notEqual(results[0].claims.sub,results[1].claims.sub);
 for(let i=0;i<2;i++){
  const other=1-i,client=clients[i],foreign=clients[other],item=results[i];
  const rpValidate=(expectedIssuer,expectedAudience,key)=>{
   assert.equal(item.claims.iss,expectedIssuer);assert((Array.isArray(item.claims.aud)?item.claims.aud:[item.claims.aud]).includes(expectedAudience));
   assert(verify('RSA-SHA256',Buffer.from(`${item.header}.${item.payload}`),createPublicKey({key,format:'jwk'}),Buffer.from(item.sig,'base64url')));
  };
  rpValidate(`${origins[i]}/oauth/${client.projectId}`,client.clientId,jwks[i].keys[0]);
  assert.throws(()=>rpValidate(`${origins[other]}/oauth/${foreign.projectId}`,client.clientId,jwks[i].keys[0]),'wrong issuer must fail');
  assert.throws(()=>rpValidate(`${origins[i]}/oauth/${client.projectId}`,foreign.clientId,jwks[i].keys[0]),'wrong audience must fail');
  assert.throws(()=>rpValidate(`${origins[i]}/oauth/${client.projectId}`,client.clientId,jwks[other].keys[0]),'foreign project signing key must fail');
  const foreignToken=await request(i,`/oauth/${client.projectId}/userinfo`,{headers:{authorization:`Bearer ${results[other].token.access_token}`}});assert.equal(foreignToken.status,401);
  const badBasic=Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(foreign.secret)}`).toString('base64');
  const badClient=await request(i,`/oauth/${client.projectId}/token`,{method:'POST',headers:{authorization:`Basic ${badBasic}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:'invalid',redirect_uri:`${rpOrigin}/callback/${i}`,code_verifier:'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'}).toString()});
  assert.notEqual(badClient.status,200);assert.equal(JSON.parse(badClient.body).error,'invalid_client');
  const foreignBasic=Buffer.from(`${encodeURIComponent(foreign.clientId)}:${encodeURIComponent(foreign.secret)}`).toString('base64');
  const foreignClient=await request(i,`/oauth/${client.projectId}/token`,{method:'POST',headers:{authorization:`Basic ${foreignBasic}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:'invalid',redirect_uri:`${rpOrigin}/callback/${i}`,code_verifier:'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'}).toString()});
  assert.notEqual(foreignClient.status,200);assert.equal(JSON.parse(foreignClient.body).error,'invalid_client');
  const sharedForm=new URLSearchParams({grant_type:'authorization_code',code:'invalid',redirect_uri:`${rpOrigin}/callback/${i}`,code_verifier:'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'}).toString();
  const sharedRequest=secret=>request(i,`/oauth/${client.projectId}/token`,{method:'POST',headers:{authorization:`Basic ${Buffer.from(`${encodeURIComponent(sharedClients[i].ClientID)}:${encodeURIComponent(secret)}`).toString('base64')}`,'content-type':'application/x-www-form-urlencoded'},body:sharedForm});
  const sharedWrong=await sharedRequest(sharedClients[other].Secret),sharedOwn=await sharedRequest(sharedClients[i].Secret);
  assert.equal(JSON.parse(sharedWrong.body).error,'invalid_client');assert.equal(JSON.parse(sharedOwn.body).error,'invalid_grant');
  const ownCookies=await contexts[other].cookies(origins[other]),foreignCookie=ownCookies.find(c=>c.name==='__Host-zitadel_session');assert(foreignCookie?.value);
  const replay=await request(i,'/app',{headers:{cookie:`__Host-zitadel_session=${foreignCookie.value}`}});assert([302,303].includes(replay.status));assert.match(replay.headers.location,/\/login/);
  const replayContext=await browser.newContext();
  await replayContext.addCookies([{name:'__Host-zitadel_session',value:foreignCookie.value,url:origins[i],secure:true,httpOnly:true,sameSite:'Lax'}]);
  const replayPage=await replayContext.newPage();await replayPage.goto(`${origins[i]}/app`);assert.equal(new URL(replayPage.url()).pathname,'/login');await replayContext.close();
  const own=await request(i,`/oauth/${client.projectId}/userinfo`,{headers:{authorization:`Bearer ${item.token.access_token}`}});assert.equal(own.status,200);assert.equal(JSON.parse(own.body).sub,item.claims.sub);
 }
 // Logging one project out revokes its session while the other stays active.
 await pages[0].goto(`${originA}/app`);await pages[0].getByRole('button',{name:'Sign out'}).click();await pages[0].waitForURL('**/login');
 assert.equal((await request(0,`/oauth/${idA}/userinfo`,{headers:{authorization:`Bearer ${results[0].token.access_token}`}})).status,401);
 assert.equal((await request(1,`/oauth/${idB}/userinfo`,{headers:{authorization:`Bearer ${results[1].token.access_token}`}})).status,200);
 const memory=[];for(let i=0;i<2;i++){const status=await request(i,'/_mapi/admin/status',{headers:{authorization:`Bearer ${operator}`}});assert.equal(status.status,200);memory.push(JSON.parse(status.body).wasmMemoryBytes);}
 for(const context of contexts)await context.close();
 console.log(`Two local projects: official login, independent RP, distinct issuers and signing keys, wrong issuer/audience/signature, credential, bearer and cookie isolation, and isolated logout passed. Wasm linear memory per project: ${memory.join(', ')} bytes.`);
}finally{
 if(browser)await browser.close();if(rp){rp.closeAllConnections?.();await new Promise(done=>rp.close(done));}if(proxy){proxy.closeAllConnections?.();await new Promise(done=>proxy.close(done));}
 if(worker&&worker.exitCode===null&&worker.signalCode===null){const stopped=once(worker,'exit');worker.kill('SIGTERM');await stopped;}await rm(temp,{recursive:true,force:true});
}
