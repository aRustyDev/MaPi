import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel } from '@zitadel/testing';
import { client } from './parity.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(done=>s.close(done));return p;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-session-overflow-'));let native,server;const previous=process.env.NEXTGEN_SESSION_MAX_TTL;
try {
 process.env.NEXTGEN_SESSION_MAX_TTL='2562047h';native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'TTL overflow probe'});const nativeFixture={...native.handle,user:await native.seedUser()};
 const fixture=JSON.parse(await readFile('.mapi/fixture.json','utf8')),localVars=await readFile('.dev.vars.poc','utf8'),envFile=resolve(dir,'vars');await writeFile(envFile,localVars+'\nMAPI_SESSION_MAX_TTL=2562047h\n',{mode:0o600});
 const p=await port(),inspector=await port();server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/session-extra-test.wrangler.jsonc','--env-file',envFile,'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','ignore'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 const worker=`http://127.0.0.1:${p}`;for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await fetch(worker+'/livez');break}catch{await setTimeout(200)}}
 const db=new DatabaseSync(resolve(dir,'native/.zitadel/local/nextgen-data/zitadel.db'),{readOnly:true});
 try {
  const nowNs=BigInt(Date.now())*1000000n, safeHours=Number(((1n<<63n)-1n-nowNs)/3600000000000n)-2;
  const out={};for(const [name,base,f] of [['native',native.handle.baseUrl,nativeFixture],['worker',worker,fixture]]){
   const api=client(base,f);const count=async()=>{if(name==='native')return db.prepare("SELECT count(*) AS n FROM events WHERE project_id=? AND event_type='session.established'").get(f.projectId).n;const r=await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command:'events'})});return (await r.json()).events.find(e=>e.event_type==='session.established')?.count??0;};
   const token=await api.mint(),before=await count(),response=await api.exchange(token,'PT2562047H');
   assert.equal(response.status,400);assert.equal(response.data.code,'sess.exchange_conflict');assert.equal(await count(),before,'overflow wrote audit');
   const retry=await api.exchange(token,'PT1H');assert.equal(retry.status,200,'overflow consumed handoff');
   const safe=await api.exchange(await api.mint(),`PT${safeHours}H`);assert.equal(safe.status,200,'within-bound duration rejected');
   const session=api.session(safe);assert.equal((await api.read(session)).status,200,'within-bound session unusable');
   assert.ok(Math.abs(Date.parse(safe.data.session.expires_at)-Date.now()-safeHours*3600000)<10000,'within-bound expiry inaccurate');
   out[name]={overflowStatus:response.status,overflowCode:response.data.code,retryStatus:retry.status,safeStatus:safe.status};
  }
  assert.deepEqual(out.worker,out.native);console.log(JSON.stringify(out));
 } finally {db.close();}
} finally {if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}if(native)await native.stop();if(previous===undefined)delete process.env.NEXTGEN_SESSION_MAX_TTL;else process.env.NEXTGEN_SESSION_MAX_TTL=previous;await rm(dir,{recursive:true,force:true});}
