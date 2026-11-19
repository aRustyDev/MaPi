import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel } from '@zitadel/testing';
import { client } from './parity.mjs';
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(done=>s.close(done));return p;}
if(process.env.MAPI_TEST_PREBUILT!=='1'){
 execFileSync(process.execPath,['scripts/build-upstream-split-test.mjs'],{stdio:'inherit'});
}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-upstream-split-'));let verifier,caller,native;
try {
 const [vp,cp,vi,ci]=await Promise.all([port(),port(),port(),port()]);const secret=randomBytes(32).toString('base64url');
 const vars=resolve(dir,'vars');await writeFile(vars,`ARGON_SPIKE_SECRET=${secret}\nMAPI_LOCAL_TEST=1\n`,{mode:0o600});
 function start(config,p,inspect){return spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config',config,'--env-file',vars,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspect),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,`${p}.log`),WRANGLER_SEND_METRICS:'false'}});}
 async function ready(p,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('local worker exited');try{await fetch(`http://127.0.0.1:${p}/`);return;}catch{await setTimeout(200);}}throw Error('local worker not ready');}
 verifier=start('scripts/argon-spike-verifier.wrangler.jsonc',vp,vi);await ready(vp,verifier);
 caller=start('scripts/upstream-split-test.wrangler.jsonc',cp,ci);await ready(cp,caller);
 const key=JSON.parse(await readFile('.mapi/runtime-key.json','utf8'));const {user}=JSON.parse(await readFile('.mapi/fixture.json','utf8'));
 const response=await fetch(`http://127.0.0.1:${cp}/`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,user}),signal:AbortSignal.timeout(120000)});
 const result=await response.json();assert.equal(response.status,200,result.error);assert.equal(result.ok,true);
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'Synthetic split parity'});const nativeUser=await native.seedUser();const api=client(native.handle.baseUrl,{...native.handle,user:nativeUser});
 const wrong=await api.attempt('Wrong-synthetic-password!');assert.ok(wrong.passwordResult.status>=400&&wrong.passwordResult.status<500);assert.equal(wrong.passwordResult.data.code,result.wrongCode,'wrong-proof error code differs');
 const nativeSession=api.session(await api.exchange(await api.mint()));assert.equal((await api.read(nativeSession)).status,200);assert.equal((await api.revoke(nativeSession)).status,204);assert.equal((await api.read(nativeSession)).status,401);
 console.log(JSON.stringify({...result,nativeParity:'wrong proof code and password-to-session lifecycle passed'}));
} finally {
 for(const child of [caller,verifier])if(child&&child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}
 if(native)await native.stop();
 await rm(dir,{recursive:true,force:true});
}
