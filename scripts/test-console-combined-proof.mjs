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
const dir=await mkdtemp(resolve(tmpdir(),'mapi-console-combined-'));let server,browser,logs='';
try{
 const p=await port(),inspector=await port(),origin=`http://127.0.0.1:${p}`,other=`http://localhost:${p}`,operator=randomBytes(32).toString('base64url');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 const vars=resolve(dir,'vars');await writeFile(vars,`MAPI_APP_ORIGIN=${origin}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify({id:'master-test',pem:privateKey})).toString('base64')}\nMAPI_LOCAL_TEST=1\n`,{mode:0o600});
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/console-combined-proof.wrangler.jsonc','--env-file',vars,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});server.stderr.on('data',c=>logs=(logs+c).slice(-8000));
 const send=(base,path,{method='GET',headers={},body}={})=>fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await send(origin,'/console/runtime.json');break}catch{await setTimeout(200)}}
 assert.equal((await send(origin,'/console/runtime.json')).status,503);assert.equal((await send(other,'/console/runtime.json')).status,503);
 assert.equal((await send(origin,'/console/runtime.json',{headers:{origin:other}})).status,403);
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/ui/console/');await page.getByText('Server unavailable',{exact:true}).waitFor({timeout:20000});
 const auth={authorization:`Bearer ${operator}`,'content-type':'application/json'};
 async function provision(projectOrigin){const r=await send(origin,'/_mapi/admin/projects',{method:'POST',headers:auth,body:{name:'Console combined proof',origin:projectOrigin}});if(r.status!==200)throw Error(`provision status ${r.status}`);return (await r.json()).projectId;}
 const project=await provision(origin),foreignProject=await provision(other);assert.notEqual(project,foreignProject);
 const runtime=await send(origin,'/console/runtime.json');assert.equal(runtime.status,200);assert.equal(runtime.headers.get('cache-control'),'no-store');const meta=await runtime.json();assert.equal(meta.console_project_id,project);assert.ok(meta.publishable_key);
 const foreign=await (await send(other,'/console/runtime.json')).json();assert.equal(foreign.console_project_id,foreignProject);assert.ok(foreign.publishable_key!==meta.publishable_key,'project keys differ');
 assert.equal((await send(origin,'/console/runtime.json',{headers:{origin:other}})).status,403);const forwarded=await send(origin,'/console/runtime.json',{headers:{'x-forwarded-host':`localhost:${p}`,'x-forwarded-proto':'https'}});assert.equal((await forwarded.json()).console_project_id,project);
 const browserFlow=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/flows'&&r.request().method()==='POST',{timeout:20000});
 await page.getByRole('button',{name:'Try again'}).click();await page.getByText('Sign in to the Zitadel console',{exact:true}).waitFor({timeout:20000});const widget=page.locator('zitadel-login');await widget.waitFor({state:'attached',timeout:20000});assert.ok(await widget.evaluate((el,id)=>el.project?.projectId===id,project),'official widget receives the resolved project');assert.equal((await browserFlow).status(),404);assert.deepEqual(errors,[]);
 // No flow/management or diagnostic route is exposed by this combined Worker.
 assert.equal((await send(origin,'/api/v1/flows',{method:'POST',headers:{'content-type':'application/json'},body:{project_id:project,purpose:'login'}})).status,404);
 assert.equal((await send(origin,'/api/v1/users/query',{method:'POST',headers:{'content-type':'application/json'},body:{}})).status,404);assert.equal((await send(origin,'/__test/project-token',{method:'POST',headers:auth,body:{}})).status,404);
 const sessionPath=`/api/v1/sessions/me?project_id=${encodeURIComponent(project)}`;
 assert.equal((await send(origin,sessionPath)).status,401);assert.equal((await send(origin,sessionPath,{headers:{cookie:'zitadel_session=bad'}})).status,401);assert.equal((await send(origin,sessionPath,{headers:{authorization:'Bearer arbitrary'}})).status,401);
 const email=`combined-${randomUUID()}@example.com`,password=`Example-${randomUUID()}!`;
 const user=await send(origin,'/_mapi/admin/users',{method:'POST',headers:auth,body:{email,password}});assert.equal(user.status,200);
 const login=await send(origin,'/__test/session',{method:'POST',headers:auth,body:{email,password}});assert.equal(login.status,204);const cookie=login.headers.get('set-cookie')?.split(';',1)[0];assert.ok(cookie,'real upstream session cookie');
 const me=await send(origin,sessionPath,{headers:{cookie}});assert.equal(me.status,200);assert.equal(me.headers.get('cache-control'),'no-store');const session=await me.json();assert.ok(session.user_id);
 const split=cookie.indexOf('=');await page.context().addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:origin,httpOnly:true,sameSite:'Lax'}]);
 const browserSession=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/sessions/me'&&r.request().method()==='GET',{timeout:20000});await page.goto(origin+'/ui/console/login');assert.equal((await browserSession).status(),200);
 assert.equal((await send(origin,`/api/v1/sessions/me?project_id=${foreignProject}`,{headers:{cookie}})).status,403);
 assert.equal((await send(other,`/api/v1/sessions/me?project_id=${foreignProject}`,{headers:{cookie}})).status,401);
 assert.equal((await send(origin,sessionPath,{headers:{cookie,origin:other}})).status,403);
 assert.equal((await send(origin,sessionPath,{method:'DELETE',headers:{cookie}})).status,405);
 assert.equal((await send(origin,sessionPath+'&project_id='+project,{headers:{cookie}})).status,403);
 console.log('Combined local Console: real assets and project bootstrap, official widget, session read, project/origin fences and missing API denial passed.');
}catch(e){if(logs)console.error(logs);throw e;}finally{await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
