import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function freePort() {
  const server=createServer().listen(0,'127.0.0.1'); await once(server,'listening');
  const port=server.address().port; await new Promise(done=>server.close(done)); return port;
}
const directory=await mkdtemp(resolve(tmpdir(),'mapi-result-spill-'));
const envFile=resolve(directory,'empty.env'); await writeFile(envFile,'');
const port=await freePort(), inspector=await freePort();
const server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','experiments/sql-result-spill/wrangler.jsonc','--env-file',envFile,'--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspector),'--persist-to',directory],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(directory,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
let diagnostic='';server.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-16000)});
try {
  let first;
  for(let attempt=0;attempt<100;attempt++) {
    if(server.exitCode!==null) throw Error('workerd exited before readiness');
    try{first=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(120000)});break;}
    catch(error){if(error.name==='TimeoutError') throw error; await setTimeout(200);}
  }
  if(!first) throw Error('workerd did not start');
  for(const [mode,response] of [['rollback',first],['commit',await fetch(`http://127.0.0.1:${port}/?commit`,{signal:AbortSignal.timeout(120000)})],['fail',await fetch(`http://127.0.0.1:${port}/?fail`,{signal:AbortSignal.timeout(120000)})]]) {
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
    assert.equal(result.ok,true);assert.equal(result.mode,mode);assert.equal(result.commit,mode==='commit');assert.equal(result.size,8388530);
    assert.equal(result.frameCount,mode==='fail'?1:Math.ceil(result.size/32768));assert.ok(result.maxFrame<=32768);assert.equal(result.audit,mode==='commit'?1:0);
    console.log(`Local known-BLOB DML spill ${mode}: ${result.size} bytes, ${result.frameCount} encrypted frames, maximum ${result.maxFrame} bytes.`);
  }
} catch(error) { if(diagnostic) console.error(diagnostic); throw error; }
finally {if(server.exitCode===null && server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await rm(directory,{recursive:true,force:true});}
