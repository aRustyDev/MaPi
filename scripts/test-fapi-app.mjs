import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const dir=await mkdtemp(resolve(tmpdir(),'mapi-fapi-app-'));
let server;
try {
 const checkout=resolve(dir,'nextgen');await mkdir(checkout);
 execFileSync('rsync',['-a','--exclude=.git','--exclude=node_modules',`${resolve('.mapi/nextgen')}/`,`${checkout}/`],{stdio:'inherit'});
 execFileSync('rsync',['-a',`${resolve('upstream/overlay/apps/api')}/`,`${checkout}/apps/api/`],{stdio:'inherit'});
 const wasm=resolve('worker/generated/fapi-app-test.wasm');
 execFileSync('go',['build','-tags=mapi_oauth,mapi_flow,mapi_fapi_app_test','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',wasm,'./cmd/mapi-wasm'],{cwd:resolve(checkout,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
 async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
 const p=await port(),inspector=await port(),env=resolve(dir,'empty.env');await writeFile(env,'');
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/fapi-app-test.wrangler.jsonc','--env-file',env,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',dir],{stdio:['ignore','ignore','inherit'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 let response;for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error('workerd exited');try{response=await fetch(`http://127.0.0.1:${p}/`,{method:'POST',body:JSON.stringify({pem:privateKey}),signal:AbortSignal.timeout(120000)});break;}catch(error){if(error.name==='TimeoutError')throw error;await setTimeout(200);}}
 if(!response)throw Error('workerd not ready');const result=await response.json();assert.equal(result.ok,true,result.error);
 console.log(`Private FAPI real-password session journey passed: Wasm ${(await stat(wasm)).size} bytes, linear memory ${result.memoryBytes} bytes, ${result.elapsedMs} ms.`);
} finally {if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await rm(dir,{recursive:true,force:true});}
