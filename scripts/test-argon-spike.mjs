import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
async function port(){const server=createServer().listen(0,'127.0.0.1');await once(server,'listening');const result=server.address().port;await new Promise(done=>server.close(done));return result;}
if(process.env.MAPI_TEST_PREBUILT!=='1')execFileSync(process.execPath,['scripts/build-argon-spike.mjs'],{stdio:'inherit'});
const temp=await mkdtemp(resolve(tmpdir(),'mapi-argon-spike-'));let verifier,caller,probe;
try{
 const [vPort,cPort,pPort,vInspector,cInspector,pInspector]=await Promise.all([port(),port(),port(),port(),port(),port()]);
 const secret=randomBytes(32).toString('base64url'),auth=randomBytes(32).toString('base64url');
 const vars=resolve(temp,'vars');await writeFile(vars,`ARGON_SPIKE_SECRET=${secret}\nARGON_SPIKE_TEST_AUTH=${auth}\n`,{mode:0o600});
 function start(config,p,inspect){return spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config',config,'--env-file',vars,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspect),'--persist-to',resolve(temp,'state')],{stdio:['ignore','ignore','ignore'],env:{...process.env,WRANGLER_LOG_PATH:resolve(temp,`${p}.log`),WRANGLER_SEND_METRICS:'false'}});}
 async function ready(p,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('local worker exited');try{await fetch(`http://127.0.0.1:${p}/`);return;}catch{await setTimeout(200);}}throw Error('local worker not ready');}
 verifier=start('scripts/argon-spike-verifier.wrangler.jsonc',vPort,vInspector);await ready(vPort,verifier);
 caller=start('scripts/argon-spike-caller.wrangler.jsonc',cPort,cInspector);await ready(cPort,caller);
 const direct=await fetch(`http://127.0.0.1:${vPort}/verify`,{method:'POST',body:'{}'});assert.equal(direct.status,401);
 const invoke=(path,data,token=auth)=>fetch(`http://127.0.0.1:${cPort}${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await invoke('/test-only/hash',{password:'synthetic'},'wrong')).status,401);
 let seeded;for(let i=0;i<40;i++){try{seeded=await invoke('/test-only/hash',{password:'synthetic-correct-password'});if(seeded.status===200)break;}catch{}await setTimeout(200);}
 assert.equal(seeded?.status,200,'service binding did not connect');const seed=await seeded.json();assert.match(seed.hash,/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
 const bad=await invoke('/verify',{password:'wrong',hash:seed.hash});assert.equal(bad.status,200);assert.equal((await bad.json()).verified,false);
 const unicodeSeed=await invoke('/test-only/hash',{password:'synthetic-e\u0301-password'});assert.equal(unicodeSeed.status,200);const unicodeHash=(await unicodeSeed.json()).hash;const unicodeVerify=await invoke('/verify',{password:'synthetic-\u00e9-password',hash:unicodeHash});assert.equal(unicodeVerify.status,200);assert.equal((await unicodeVerify.json()).verified,true,'upstream NFC normalization');
 assert.equal((await invoke('/verify',{password:'x',hash:seed.hash.replace('m=65536','m=524288')})).status,400);
 assert.equal((await invoke('/verify',{password:'x'.repeat(1025),hash:seed.hash})).status,400);
 const firstStart=performance.now(),first=await invoke('/verify',{password:'synthetic-correct-password',hash:seed.hash});const firstMs=performance.now()-firstStart;assert.equal(first.status,200);const firstResult=await first.json();assert.equal(firstResult.verified,true);
 const samples=[],memory=[];const burstStart=performance.now();for(let i=0;i<5;i++)await Promise.all(Array.from({length:4},async()=>{const t=performance.now(),r=await invoke('/verify',{password:'synthetic-correct-password',hash:seed.hash});const elapsed=performance.now()-t;assert.equal(r.status,200);const v=await r.json();assert.equal(v.verified,true);samples.push(elapsed);memory.push(v.wasmBytes);}));
 samples.sort((a,b)=>a-b);const bytes=(await stat('worker/generated/argon-spike.wasm')).size;
 const measured={checks:'authenticated binding, correct/wrong password, rejected input and pinned Argon2 parameters',wasmBinaryBytes:bytes,setupWasmBytes:seed.wasmBytes,firstWasmBytes:firstResult.wasmBytes,burstMaxWasmBytes:Math.max(...memory),firstMs,burstCount:20,burstConcurrency:4,burstWallMs:performance.now()-burstStart,p95Ms:samples[18]};
 probe=start('scripts/argon-spike-hosted-probe-test.wrangler.jsonc',pPort,pInspector);await ready(pPort,probe);
 assert.equal((await fetch(`http://127.0.0.1:${pPort}/probe`,{method:'POST'})).status,404);
 let probeResponse;for(let i=0;i<40;i++){probeResponse=await fetch(`http://127.0.0.1:${pPort}/probe`,{method:'POST',headers:{authorization:`Bearer ${auth}`}});if(probeResponse.status===200)break;await setTimeout(250);}
 assert.equal(probeResponse.status,200,'hosted probe failed');const probeResult=await probeResponse.json();assert.equal(probeResult.journeys,20);assert.equal(probeResult.concurrency,4);assert.ok(probeResult.burstMaxWasmBytes>0);
 console.log(JSON.stringify({...measured,hostedProbeLocal:probeResult},null,2));
}finally{for(const child of [probe,caller,verifier])if(child&&child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}await rm(temp,{recursive:true,force:true});}
