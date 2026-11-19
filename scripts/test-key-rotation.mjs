import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const dir=await mkdtemp(resolve(tmpdir(),'mapi-key-rotation-'));let server;
try {
 const checkout=resolve(dir,'nextgen');await mkdir(checkout);const archive=resolve(dir,'nextgen.tar');execFileSync('git',['-C',resolve('.mapi/nextgen'),'archive','--format=tar',`--output=${archive}`,'b0b74cd4a198428ea9b82910c217259ffc62b65c'],{stdio:'inherit'});execFileSync('tar',['-xf',archive,'-C',checkout],{stdio:'inherit'});await cp('upstream/overlay',checkout,{recursive:true});execFileSync('git',['apply','--unidiff-zero',resolve('upstream/audit-tracing.patch')],{cwd:checkout,stdio:'inherit'});
 for(const file of ['dialect','error','pool','with_transaction']){const path=resolve(checkout,`apps/api/internal/storage/dialect/sqlite/${file}.go`);await writeFile(path,`//go:build !wasip1\n\n${await readFile(path,'utf8')}`);}
 const wasm=resolve('worker/generated/key-rotation-test.wasm');execFileSync('go',['build','-tags=mapi_oauth,mapi_flow,mapi_key_rotation_test','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',wasm,'./cmd/mapi-wasm'],{cwd:resolve(checkout,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
 async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
 const p=await port(),inspector=await port(),env=resolve(dir,'empty.env');await writeFile(env,'');server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/key-rotation-test.wrangler.jsonc','--env-file',env,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',dir],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});let diagnostic='';server.stderr.on('data',c=>diagnostic=(diagnostic+c).slice(-4000));
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});let response;
 for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error('workerd exited');try{response=await fetch(`http://127.0.0.1:${p}/`,{method:'POST',body:JSON.stringify({pem:privateKey}),signal:AbortSignal.timeout(120000)});break;}catch(error){if(error.name==='TimeoutError')throw error;await setTimeout(200);}}
 if(!response)throw Error('workerd did not start');const result=await response.json();assert.equal(result.ok,true,result.error);
 execFileSync('go',['test','-race','-tags=mapi_native_e2e','-run','^(TestAdminFreshInstallUpstreamServicesAndRetries|TestFAPISigningKeysRotationAndRollback|TestSigningKeyRotationAndSignedTokens)$','-count=1','./internal/mapioauth'],{cwd:resolve(checkout,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOTOOLCHAIN:'go1.26.9'}});
 console.log(`Two-project real-key rollover, audit rollback, injected retired-key removal and eviction passed in workerd; native key tests passed; Wasm ${(await stat(wasm)).size} bytes.`);
} finally {if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await rm(dir,{recursive:true,force:true});}
