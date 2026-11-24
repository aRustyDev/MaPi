import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {verifySplit, SplitUnavailable} from './password-split-protocol.mjs';

// Missing authority must fail before rate-limit admission, SQLite or verifier
// work; the insecure state-machine adapter is isolated to its own test worker.
let touches=0;
const guarded={
 storage:{transactionSync(){touches++;throw Error('unexpected transaction');}},
 authority(){touches++;}, resolveAuthority(){touches++;}, admit(){touches++;},
 verify(){touches++;}, load(){touches++;}, success(){touches++;}, failure(){touches++;},
 project:'p',attempt:'a',challenge:'c',password:'synthetic',
};
for(const key of ['authority','resolveAuthority','admit']) {
 for(const value of [undefined,null,true]) {
  await assert.rejects(verifySplit({...guarded,[key]:value}),SplitUnavailable);
  assert.equal(touches,0,`missing ${key} reached a side effect`);
 }
}
console.log('Guarded split entry rejects missing authority, registry or admission before any side effect.');

async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-password-split-')),p=await port(),inspector=await port(),env=resolve(dir,'empty.env');await writeFile(env,'');
const server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/password-split-test.wrangler.jsonc','--env-file',env,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',dir],{stdio:['ignore','ignore','inherit'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
try{
 let response;for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error('workerd exited');try{response=await fetch(`http://127.0.0.1:${p}/`,{signal:AbortSignal.timeout(30000)});break;}catch(error){if(error.name==='TimeoutError')throw error;await setTimeout(200);}}
 if(!response)throw Error('workerd not ready');const result=await response.json();assert.equal(result.ok,true,result.error);assert.equal(result.races,8);assert.equal(result.frozenClockCounterexample,true);console.log('Local workerd password split state-machine: rollback, replay, lease and eight authoritative mutation races passed; simulated frozen-clock late commit remains a known limitation.');
}finally{if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await rm(dir,{recursive:true,force:true});}
