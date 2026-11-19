import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const upstream=resolve('.mapi/nextgen/apps/api');
await copyFile('upstream/overlay/apps/api/cmd/mapi-wasm/oauth_wasip1.go',resolve(upstream,'cmd/mapi-wasm/oauth_wasip1.go'));
for(const name of ['main_wasip1.go','flow_enabled_wasip1.go','flow_disabled_wasip1.go'])await copyFile(`upstream/overlay/apps/api/cmd/mapi-wasm/${name}`,resolve(upstream,`cmd/mapi-wasm/${name}`));
for(const name of ['cloudflare_wasip1.go','generated/mapi_routes_wasip1.go'])await copyFile(`upstream/overlay/apps/api/internal/api/${name}`,resolve(upstream,`internal/api/${name}`));
for(const name of ['authorization_code.go','refresh_token.go','refresh_revoke.go','client.go','client_credentials.go','signing.go','tokens.go','provider.go','login_bridge.go','login_http.go','admin.go','compose.go','logout_registry.go','logout_http.go','id_hint.go','discovery.go'])await copyFile(`upstream/overlay/apps/api/internal/mapioauth/${name}`,resolve(upstream,`internal/mapioauth/${name}`));
execFileSync('go',['build','-tags=mapi_oauth,mapi_flow','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',resolve('worker/generated/oauth-composition-test.wasm'),'./cmd/mapi-wasm'],{cwd:upstream,stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise((done)=>s.close(done));return n;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-oauth-composition-')),p=await port(),inspector=await port(),env=resolve(dir,'empty.env');await writeFile(env,'');
const server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/oauth-composition-test.wrangler.jsonc','--env-file',env,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',dir],{stdio:['ignore','ignore','inherit'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
try{
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 let response;for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error('workerd exited');try{response=await fetch(`http://127.0.0.1:${p}/`,{method:'POST',body:JSON.stringify({pem:privateKey}),signal:AbortSignal.timeout(120000)});break;}catch(error){if(error.name==='TimeoutError')throw error;await setTimeout(200);}}
 if(!response)throw Error('workerd not ready');const result=await response.json();assert.equal(result.ok,true,result.error);assert.equal(result.keys,2);assert.equal(result.journey,true);console.log(`Workerd OAuth flow, discovery, signed token, userinfo, token revocation, RP logout and replay rejection passed. Wasm bytes: ${(await stat('worker/generated/oauth-composition-test.wasm')).size}; linear memory bytes: ${result.memoryBytes}; total test ms: ${result.elapsedMs}.`);
}finally{if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await rm(dir,{recursive:true,force:true});}
