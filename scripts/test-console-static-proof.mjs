import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-console-static-'));let server,browser,logs='';
try {
 const p=await port(),inspector=await port(),base=`http://127.0.0.1:${p}`;
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/console-static-proof.wrangler.jsonc','--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});server.stderr.on('data',c=>logs=(logs+c).slice(-8000));
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await fetch(base+'/console/runtime.json');break}catch{await setTimeout(200)}}
 const index=await readFile('worker/generated/console-assets/index.html','utf8'),policy=JSON.parse(await readFile('worker/generated/console-policy.json','utf8'));
 const res=async(path,init={})=>fetch(base+path,{redirect:'manual',...init});
 const redir=await res('/ui/console');assert.equal(redir.status,308);assert.equal(new URL(redir.headers.get('location')).pathname,'/ui/console/');
 for(const path of ['/ui/console/','/ui/console/settings/team','/ui/console/schemas/https%3A%2F%2Fh%2Fx.json','/ui/console/assetsX/y.js','/ui/console/schemas/https%3A%2F%2Fh%2Findex.html','/ui/console/schemas/a%2F..%2Fb.json']) {const r=await res(path);assert.equal(r.status,200,path);assert.equal(await r.text(),index,path);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('content-security-policy'),policy.enforced);assert.equal(r.headers.get('content-security-policy-report-only'),policy.report);}
 const asset=index.match(/(?:src|href)="(\/ui\/console\/assets\/[^"?]+\.js)"/);assert.ok(asset,'compiled JS asset');const found=await res(asset[1]);assert.equal(found.status,200);assert.match(found.headers.get('content-type'),/javascript/);assert.equal(found.headers.get('cache-control'),'public, max-age=31536000, immutable');assert.equal((await res('/ui/console/assets/missing.js')).status,404);assert.equal((await res('/api/v1/users/me')).status,404);assert.equal((await res('/ui/console/',{method:'POST'})).status,404);
 const head=await res('/ui/console/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('cache-control'),'no-store');
 const runtime=await res('/console/runtime.json');assert.deepEqual(await runtime.json(),{mode:'standalone'});assert.equal(runtime.headers.get('cache-control'),'no-store');assert.equal((await res('/console/runtime.json',{method:'POST'})).status,405);
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errs=[];page.on('pageerror',e=>errs.push(e.message));await page.goto(base+'/ui/console/');await page.getByText('No project yet',{exact:true}).waitFor({timeout:20000});assert.deepEqual(errs,[]);
 const errorPage=await browser.newPage();let failRuntime=true;await errorPage.route('**/console/runtime.json',r=>failRuntime?r.fulfill({status:500,contentType:'text/plain',body:'synthetic outage'}):r.continue());await errorPage.goto(base+'/ui/console/');await errorPage.getByRole('button',{name:'Try again'}).waitFor({timeout:20000});assert.equal(await errorPage.getByText('No project yet',{exact:true}).count(),0);failRuntime=false;await errorPage.getByRole('button',{name:'Try again'}).click();await errorPage.getByText('No project yet',{exact:true}).waitFor({timeout:20000});
 console.log('Pinned Console static assets: workerd routing, headers, missing assets, runtime and browser states passed.');
}catch(e){if(logs)console.error(logs);throw e;}finally{await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
