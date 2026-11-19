import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {chromium} from 'playwright';
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-console-flow-'));let server,browser,logs='';
try{
 const p=await port(),inspector=await port(),origin=`http://127.0.0.1:${p}`,other=`http://localhost:${p}`,operator=randomBytes(32).toString('base64url');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 const sessionVars=process.env.MAPI_TEST_SESSION_CONFIG==='1'?'MAPI_SESSION_DEFAULT_TTL=2h\nMAPI_SESSION_MAX_TTL=4h\n':'';
 const vars=resolve(dir,'vars'), baseVars=`MAPI_APP_ORIGIN=${origin}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify({id:'master-test',pem:privateKey})).toString('base64')}\nMAPI_LOCAL_TEST=1\n`;await writeFile(vars,baseVars+sessionVars,{mode:0o600});
 const launch=(config='scripts/console-flow-proof.wrangler.jsonc')=>{server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config',config,'--env-file',vars,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});server.stderr.on('data',c=>logs=(logs+c).slice(-8000));};launch();
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
 async function start(projectId,headers={}){return send(origin,'/api/v1/flows',{method:'POST',headers:{'content-type':'application/json',...headers},body:{project_id:projectId,purpose:'login'}});}
 assert.equal((await start(project)).status,403);
 assert.equal((await start(project,{origin:other})).status,403);
 assert.equal((await start(foreignProject,{origin})).status,403);
 assert.equal((await send(origin,'/api/v1/sessions/exchange?project_id='+foreignProject,{method:'POST',headers:{origin,'content-type':'application/json'},body:{handoff_token:'bad'}})).status,403);
 assert.equal((await send(origin,'/api/v1/sessions/exchange',{method:'POST',headers:{origin,'content-type':'application/json'},body:{handoff_token:'bad'}})).status,403);
 assert.equal((await send(origin,'/api/v1/flows',{method:'POST',headers:{origin,'content-type':'application/json'},body:'x'.repeat(65537)})).status,413);
 assert.equal((await send(origin,'/api/v1/users/query',{method:'POST',headers:{'content-type':'application/json'},body:{}})).status,404);
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
 const me=await send(origin,sessionPath,{headers:{cookie:cookieHeader}});assert.equal(me.status,200);assert.equal(me.headers.get('cache-control'),'no-store');const meData=await me.json();assert.ok(meData.user_id);if(process.env.MAPI_TEST_SESSION_CONFIG==='1'){const remaining=Date.parse(meData.expires_at)-Date.now();assert.ok(remaining>7190000&&remaining<=7200000,'configured app session default');}
 assert.equal((await send(origin,sessionPath,{headers:{cookie:cookieHeader,origin:other}})).status,403);
 assert.equal((await send(origin,`/api/v1/sessions/me?project_id=${foreignProject}`,{headers:{cookie:cookieHeader}})).status,403);
 assert.equal((await send(other,`/api/v1/sessions/me?project_id=${foreignProject}`,{headers:{cookie:cookieHeader}})).status,401);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader}})).status,403);
 assert.equal((await send(origin,sessionPath+'&project_id='+project,{headers:{cookie:cookieHeader}})).status,403);
 const csrfPath=`/api/v1/sessions/me/csrf?project_id=${encodeURIComponent(project)}`;
 const csrfResponse=await send(origin,csrfPath,{headers:{cookie:cookieHeader}});assert.equal(csrfResponse.status,200);const csrf=(await csrfResponse.json()).csrf_token;assert.ok(csrf);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader,origin:other,'x-zitadel-csrf':csrf}})).status,403);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader,origin}})).status,403);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader,origin,'x-zitadel-csrf':'invalid'}})).status,403);
 const logout=await send(origin,sessionPath,{method:'DELETE',headers:{cookie:cookieHeader,origin,'x-zitadel-csrf':csrf}});assert.equal(logout.status,204);const clearing=logout.headers.get('set-cookie')??'';assert.match(clearing,/zitadel_session=/);assert.match(clearing,/max-age=0/i);
 assert.equal((await send(origin,sessionPath,{headers:{cookie:cookieHeader}})).status,401,'revoked cookie remained valid');
 if(process.env.MAPI_TEST_SESSION_CONFIG==='1'){
  const withoutMaster=baseVars.replace(/^MAPI_MASTER_KEY=.*\n/m,'');
  const failures=[
   ['invalid TTL',baseVars+'MAPI_SESSION_DEFAULT_TTL=5h\nMAPI_SESSION_MAX_TTL=4h\n',true],
   ['malformed key',withoutMaster+'MAPI_MASTER_KEY=invalid\nMAPI_SESSION_DEFAULT_TTL=2h\nMAPI_SESSION_MAX_TTL=4h\n',true],
   ['missing key',withoutMaster+'MAPI_SESSION_DEFAULT_TTL=2h\nMAPI_SESSION_MAX_TTL=4h\n',true],
   ['malformed default key',withoutMaster+'MAPI_MASTER_KEY=invalid\n',false],
   ['missing default key',withoutMaster,false],
   ['null TTL binding',baseVars+'MAPI_SESSION_MAX_TTL=4h\n',true,{MAPI_SESSION_DEFAULT_TTL:null}],
   ['number TTL binding',baseVars+'MAPI_SESSION_DEFAULT_TTL=2h\n',true,{MAPI_SESSION_MAX_TTL:123}],
   ['boolean TTL binding',baseVars+'MAPI_SESSION_MAX_TTL=4h\n',true,{MAPI_SESSION_DEFAULT_TTL:true}],
   ['object TTL binding',baseVars+'MAPI_SESSION_DEFAULT_TTL=2h\n',true,{MAPI_SESSION_MAX_TTL:{}}],
   ['array TTL binding',baseVars+'MAPI_SESSION_MAX_TTL=4h\n',true,{MAPI_SESSION_DEFAULT_TTL:[]}],
  ];
  for(const [label,configuration,rejectOfficial,bindings] of failures){
   const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;
   let configPath='scripts/console-flow-proof.wrangler.jsonc';
   if(bindings){const config=JSON.parse(await readFile(configPath,'utf8'));config.main=resolve('scripts/console-flow-proof-worker.mjs');config.assets.directory=resolve('worker/generated/console-assets');config.vars=bindings;configPath=resolve(dir,'invalid-bindings.json');await writeFile(configPath,JSON.stringify(config));}
   await writeFile(vars,configuration+'MAPI_OFFICIAL_LOGIN=1\n',{mode:0o600});launch(configPath);
   let status;for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error('workerd exited during invalid-config restart');try{status=await send(origin,'/_mapi/admin/status',{headers:{authorization:`Bearer ${operator}`}});break}catch{await setTimeout(200)}}
   assert.ok(status,'invalid-config restart not ready');
   for(let n=0;n<3;n++){
    if(n)status=await send(origin,'/_mapi/admin/status',{headers:{authorization:`Bearer ${operator}`}});
    assert.equal(status.status,200);const state=await status.json();assert.equal(state.ready,false,`${label} reported ready`);assert.equal(state.configurationReady,false,`${label} accepted on retry`);
    assert.equal((await send(origin,'/console/runtime.json')).status,503,`${label} served Console runtime`);
    if(rejectOfficial)assert.equal((await send(origin,'/login')).status,503,`${label} served official login`);
   }
  }
 }
 assert.deepEqual(errors,[]);assert.equal(external.length,0,'browser contacted an external origin');
 console.log('Real local Console: official password flow, session exchange, CSRF logout, replay rejection and project/origin fencing passed.');
}catch(e){if(logs)console.error(logs);throw e;}finally{await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
