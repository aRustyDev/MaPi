import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {chromium} from 'playwright';
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-console-management-'));let server,browser,logs='';
try{
 const p=await port(),inspector=await port(),origin=`http://127.0.0.1:${p}`,other=`http://localhost:${p}`,operator=randomBytes(32).toString('base64url');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 const vars=resolve(dir,'vars');await writeFile(vars,`MAPI_APP_ORIGIN=${origin}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify({id:'master-test',pem:privateKey})).toString('base64')}\nMAPI_LOCAL_TEST=1\n`,{mode:0o600});
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/console-management-proof.wrangler.jsonc','--env-file',vars,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});server.stderr.on('data',c=>logs=(logs+c).slice(-8000));
 const send=(base,path,{method='GET',headers={},body}={})=>fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await send(origin,'/console/runtime.json');break}catch{await setTimeout(200)}}
 assert.equal((await send(origin,'/console/runtime.json')).status,503);assert.equal((await send(other,'/console/runtime.json')).status,503);
 assert.equal((await send(origin,'/console/runtime.json',{headers:{origin:other}})).status,403);
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>{const u=new URL(req.url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin)external.push(u.origin);});await page.goto(origin+'/ui/console/');await page.getByText('Server unavailable',{exact:true}).waitFor({timeout:20000});
 const auth={authorization:`Bearer ${operator}`,'content-type':'application/json'};
 async function provision(projectOrigin){const r=await send(origin,'/_mapi/admin/projects',{method:'POST',headers:auth,body:{name:'Console combined proof',origin:projectOrigin}});if(r.status!==200)throw Error(`provision status ${r.status}`);return (await r.json()).projectId;}
 const project=await provision(origin),foreignProject=await provision(other);assert.notEqual(project,foreignProject);
 const runtime=await send(origin,'/console/runtime.json');assert.equal(runtime.status,200);assert.equal(runtime.headers.get('cache-control'),'no-store');const meta=await runtime.json();assert.equal(meta.console_project_id,project);assert.ok(meta.publishable_key);
 const foreign=await (await send(other,'/console/runtime.json')).json();assert.equal(foreign.console_project_id,foreignProject);assert.ok(foreign.publishable_key!==meta.publishable_key,'project keys differ');
 assert.equal((await send(origin,'/console/runtime.json',{headers:{origin:other}})).status,403);const forwarded=await send(origin,'/console/runtime.json',{headers:{'x-forwarded-host':`localhost:${p}`,'x-forwarded-proto':'https'}});assert.equal((await forwarded.json()).console_project_id,project);

 const email=`console-${randomUUID()}@example.com`,password=`Example-${randomUUID()}!`;
 const user=await send(origin,'/_mapi/admin/users',{method:'POST',headers:auth,body:{email,password}});assert.equal(user.status,200);
 const userId=(await user.json()).userId;assert.ok(userId);
 const otherEmail=`foreign-${randomUUID()}@example.com`;
 const otherUser=await send(other,'/__test/seed-user',{method:'POST',headers:{...auth,origin:other},body:{email:otherEmail,password}});assert.equal(otherUser.status,200);const otherUserId=(await otherUser.json()).userId;assert.ok(otherUserId,'foreign user ID missing');assert.notEqual(userId,otherUserId);
 assert.equal((await send(other,'/__test/seed-user',{method:'POST',headers:{origin:other,'content-type':'application/json'},body:{email:otherEmail,password}})).status,404);
 const foreignLogin=await send(other,'/__test/session',{method:'POST',headers:auth,body:{email:otherEmail,password}});assert.equal(foreignLogin.status,204);const foreignCookie=foreignLogin.headers.get('set-cookie')?.split(';',1)[0];assert.ok(foreignCookie);
 const foreignSession=await send(other,`/api/v1/sessions/me?project_id=${encodeURIComponent(foreignProject)}`,{headers:{cookie:foreignCookie}});assert.equal(foreignSession.status,200);assert.equal((await foreignSession.json()).user_id,otherUserId,'foreign fixture is not owned by its project object');
 async function start(projectId,headers={}){return send(origin,'/api/v1/flows',{method:'POST',headers:{'content-type':'application/json',...headers},body:{project_id:projectId,purpose:'login'}});}
 assert.equal((await start(project)).status,403);
 assert.equal((await start(project,{origin:other})).status,403);
 assert.equal((await start(foreignProject,{origin})).status,403);
 assert.equal((await send(origin,'/api/v1/sessions/exchange?project_id='+foreignProject,{method:'POST',headers:{origin,'content-type':'application/json'},body:{handoff_token:'bad'}})).status,403);
 assert.equal((await send(origin,'/api/v1/sessions/exchange',{method:'POST',headers:{origin,'content-type':'application/json'},body:{handoff_token:'bad'}})).status,403);
 assert.equal((await send(origin,'/api/v1/flows',{method:'POST',headers:{origin,'content-type':'application/json'},body:'x'.repeat(65537)})).status,413);
 assert.equal((await send(origin,`/api/v1/users/query?project_id=${project}`,{method:'POST',headers:{'content-type':'application/json'},body:{}})).status,401);
 assert.equal((await send(origin,'/__test/project-token',{method:'POST',headers:auth,body:{}})).status,404);
 const browserFlow=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/flows'&&r.request().method()==='POST',{timeout:20000});
 await page.getByRole('button',{name:'Try again'}).click();await page.getByText('Sign in to the Zitadel console',{exact:true}).waitFor({timeout:20000});const widget=page.locator('zitadel-login');await widget.waitFor({state:'attached',timeout:20000});assert.ok(await widget.evaluate((el,id)=>el.project?.projectId===id,project),'official widget receives the resolved project');const firstFlow=await browserFlow;assert.equal(firstFlow.status(),201);const firstFlowData=await firstFlow.json();assert.ok(firstFlowData.id);
 const flowCookie=(await page.context().cookies()).find(c=>c.name==='_zflow');assert.ok(flowCookie?.httpOnly);const foreignFlow=await send(other,`/api/v1/flows/${encodeURIComponent(firstFlowData.id)}`,{headers:{cookie:`${flowCookie.name}=${flowCookie.value}`}});assert.ok(foreignFlow.status>=400&&foreignFlow.status<500,'foreign object must reject the flow cookie without an internal error');
 // A bad password cannot create a session.
 await page.getByLabel('Email').fill(email);const knownStart=performance.now();const knownStep=page.waitForResponse(r=>/\/api\/v1\/flows\/[^/]+\/submit$/.test(new URL(r.url()).pathname));await page.getByRole('button',{name:'Continue',exact:true}).click();const knownResponse=await knownStep,knownMs=performance.now()-knownStart,knownData=await knownResponse.json();assert.equal(knownResponse.status(),200);assert.equal(knownData.step?.name,'password');await page.getByTestId('zitadel-input-password').fill('Wrong-password-3!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('alert').getByText('Wrong email or password.').waitFor({timeout:20000});assert.equal((await page.context().cookies()).some(c=>c.name==='zitadel_session'),false);
 // The pinned flow visibly sends unknown identifiers to registration.
 await page.goto(origin+'/ui/console/login');await page.getByLabel('Email').fill(`missing-${randomUUID()}@example.com`);const unknownStart=performance.now();const unknownStep=page.waitForResponse(r=>/\/api\/v1\/flows\/[^/]+\/submit$/.test(new URL(r.url()).pathname));await page.getByRole('button',{name:'Continue',exact:true}).click();const unknownResponse=await unknownStep,unknownMs=performance.now()-unknownStart,unknownData=await unknownResponse.json();assert.equal(unknownResponse.status(),200);assert.equal(unknownData.step?.name,'register');await page.getByRole('button',{name:'Continue with password',exact:true}).waitFor();assert.equal(await page.getByTestId('zitadel-input-password').count(),0);assert.equal((await page.context().cookies()).some(c=>c.name==='zitadel_session'),false);
 const samples={known:[knownMs],unknown:[unknownMs]};
 for(let i=0;i<4;i++)for(const kind of (i%2?['unknown','known']:['known','unknown'])){
  await page.goto(origin+'/ui/console/login');await page.getByLabel('Email').fill(kind==='known'?email:`missing-${randomUUID()}@example.com`);
  const started=performance.now(),response=page.waitForResponse(r=>/\/api\/v1\/flows\/[^/]+\/submit$/.test(new URL(r.url()).pathname));await page.getByRole('button',{name:'Continue',exact:true}).click();const got=await response;samples[kind].push(performance.now()-started);assert.equal(got.status(),200);const data=await got.json();assert.equal(data.step?.name,kind==='known'?'password':'register');
 }
 const timing=a=>{const v=a.map(Math.round).sort((x,y)=>x-y);return{min:v[0],median:v[Math.floor(v.length/2)],max:v.at(-1)};};
 console.log(JSON.stringify({identifierStatus:200,knownStep:'password',unknownStep:'register',unknownAction:'Continue with password',timingMs:{known:timing(samples.known),unknown:timing(samples.unknown)},samplesPerCase:5}));
 // Restart the official component and finish a real password flow and exchange.
 await page.goto(origin+'/ui/console/login');await page.getByLabel('Email').fill(email);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByTestId('zitadel-input-password').fill(password);
 const browserSession=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/sessions/me'&&r.request().method()==='GET'&&r.status()===200,{timeout:30000});
 const exchange=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/sessions/exchange'&&r.request().method()==='POST',{timeout:30000});
 await page.getByRole('button',{name:'Sign in',exact:true}).click();const exchangeResult=await exchange;assert.equal(exchangeResult.status(),200);assert.equal((await browserSession).status(),200);
 const exchangeBody=exchangeResult.request().postDataJSON();assert.ok(typeof exchangeBody.handoff_token==='string');const replay=await send(origin,`/api/v1/sessions/exchange?project_id=${encodeURIComponent(project)}`,{method:'POST',headers:{origin,'content-type':'application/json'},body:exchangeBody});assert.ok(replay.status>=400&&replay.status<500,'handoff replay must fail');
 const cookie=(await page.context().cookies()).find(c=>c.name==='zitadel_session');assert.ok(cookie?.httpOnly,'real HttpOnly session cookie');
 const sessionPath=`/api/v1/sessions/me?project_id=${encodeURIComponent(project)}`;const cookieHeader=`${cookie.name}=${cookie.value}`;
 const me=await send(origin,sessionPath,{headers:{cookie:cookieHeader}});assert.equal(me.status,200);assert.equal(me.headers.get('cache-control'),'no-store');const sessionUser=(await me.json()).user_id;assert.ok(sessionUser);
 assert.equal((await send(origin,sessionPath,{headers:{cookie:cookieHeader,origin:other}})).status,403);
 assert.equal((await send(origin,`/api/v1/sessions/me?project_id=${foreignProject}`,{headers:{cookie:cookieHeader}})).status,403);
 assert.equal((await send(other,`/api/v1/sessions/me?project_id=${foreignProject}`,{headers:{cookie:cookieHeader}})).status,401);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader}})).status,403);
 assert.equal((await send(origin,sessionPath+'&project_id='+project,{headers:{cookie:cookieHeader}})).status,403);
 const queryPath=`/api/v1/users/query?project_id=${encodeURIComponent(project)}`;
 const query=({cookie=cookieHeader,extra={}}={})=>send(origin,queryPath,{method:'POST',headers:{'content-type':'application/json',origin,'sec-fetch-site':'same-origin',...(cookie?{cookie}:{}),...extra},body:{}});
 const unprivileged=(await query()).status;assert.equal(unprivileged,404,'ordinary session had unexpected management behavior');
 const grant=(active)=>send(origin,'/__test/management-grant',{method:'POST',headers:{...auth,origin},body:{userId:(awaitUserId),active}});
 const awaitUserId=sessionUser;assert.equal(awaitUserId,userId);
 assert.equal((await send(origin,'/__test/management-grant',{method:'POST',headers:{origin,'content-type':'application/json'},body:{userId,active:true}})).status,404);
 assert.equal((await send(other,'/__test/management-grant',{method:'POST',headers:{...auth,origin:other},body:{userId:otherUserId,active:true}})).status,204);
 const foreignQuery=await send(other,`/api/v1/users/query?project_id=${foreignProject}`,{method:'POST',headers:{cookie:foreignCookie,origin:other,'content-type':'application/json'},body:{}});assert.equal(foreignQuery.status,200);const foreignUsers=(await foreignQuery.json()).users;assert.ok(foreignUsers.some(u=>u.id===otherUserId));assert.ok(foreignUsers.every(u=>u.id!==userId),'primary user leaked into foreign project');
 assert.equal((await grant(true)).status,204);
 const allowed=await query();assert.equal(allowed.status,200);const listed=await allowed.json();assert.ok(listed.users.some(u=>u.id===awaitUserId),'project administrator could not see its user');assert.ok(listed.users.every(u=>u.id!==otherUserId),'foreign user leaked');assert.equal(allowed.headers.get('cache-control'),'no-store');const responseText=JSON.stringify(listed);for(const secret of [operator,password,cookie.value])assert.ok(!responseText.includes(secret),'credential leaked in management response');
 const browserList=await page.evaluate(async path=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:'{}',credentials:'same-origin'});return {status:response.status,data:await response.json()};},queryPath);assert.equal(browserList.status,200);assert.ok(browserList.data.users.some(u=>u.id===awaitUserId));
 assert.equal((await query({cookie:null})).status,401);
 assert.equal((await query({extra:{authorization:'Bearer invalid'}})).status,401,'invalid Bearer must take precedence over the session');
 assert.equal((await query({extra:{origin:other}})).status,403);
 assert.equal((await query({extra:{'sec-fetch-site':'cross-site'}})).status,403);
 assert.equal((await query({extra:{'x-zitadel-csrf':'invalid'}})).status,200,'pinned query is CSRF-token exempt');
 assert.equal((await query({extra:{'x-forwarded-host':'attacker.invalid','x-forwarded-proto':'https'}})).status,200,'spoofed forwarding headers changed routing');
 assert.equal((await send(origin,`/api/v1/users/query?project_id=${foreignProject}`,{method:'POST',headers:{cookie:cookieHeader,origin,'content-type':'application/json'},body:{}})).status,403);
 assert.equal((await send(other,`/api/v1/users/query?project_id=${foreignProject}`,{method:'POST',headers:{cookie:cookieHeader,origin:other,'content-type':'application/json'},body:{}})).status,401);
 assert.equal((await query({cookie:foreignCookie})).status,401);
 assert.equal((await send(origin,queryPath,{method:'GET',headers:{cookie:cookieHeader}})).status,404);
 assert.equal((await send(origin,`/api/v1/users/${awaitUserId}`,{headers:{cookie:cookieHeader}})).status,200);
 assert.equal((await send(origin,`/api/v1/users/${otherUserId}`,{headers:{cookie:cookieHeader}})).status,404);
 assert.equal((await grant(false)).status,204);const revoked=(await query()).status;assert.equal(revoked,404,'revoked grant had unexpected management behavior');assert.equal((await send(origin,sessionPath,{headers:{cookie:cookieHeader}})).status,200,'revoking the admin grant revoked the session');
 const csrfPath=`/api/v1/sessions/me/csrf?project_id=${encodeURIComponent(project)}`;
 const csrfResponse=await send(origin,csrfPath,{headers:{cookie:cookieHeader}});assert.equal(csrfResponse.status,200);const csrf=(await csrfResponse.json()).csrf_token;assert.ok(csrf);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader,origin:other,'x-zitadel-csrf':csrf}})).status,403);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader,origin}})).status,403);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader,origin,'x-zitadel-csrf':'invalid'}})).status,403);
 const logout=await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader,origin,'x-zitadel-csrf':csrf}});assert.equal(logout.status,204);const clearing=logout.headers.get('set-cookie')??'';assert.match(clearing,/zitadel_session=/);assert.match(clearing,/max-age=0/i);
 assert.equal((await send(origin,sessionPath,{headers:{cookie:cookieHeader}})).status,401,'revoked cookie remained valid');
 assert.deepEqual(errors,[]);assert.equal(external.length,0,'browser contacted an external origin');
 console.log(JSON.stringify({unprivileged,granted:allowed.status,revoked,sessionAfterRevoke:200}));console.log('Real local Console: official sign-in, session-scoped management read, live grant revocation, CSRF logout and isolation passed.');
}catch(e){if(logs)console.error(logs);throw e;}finally{await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
