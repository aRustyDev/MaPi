import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function freePort(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(done=>s.close(done));return p;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-typedrows-workerd-'));let server;let diagnostic='';
try {
  await mkdir(resolve(dir,'typedrows'));
  for(const f of ['main.go','worker.mjs','wrangler.jsonc']) await copyFile(resolve('experiments/sql-result-spill/typedrows-workerd',f),resolve(dir,f));
  await copyFile(resolve('experiments/sql-result-spill/typedrows/rows.go'),resolve(dir,'typedrows/rows.go'));
  await copyFile(resolve('worker/wasi.js'),resolve(dir,'wasi.js'));
  await writeFile(resolve(dir,'go.mod'),'module mapi-typedrows-probe\n\ngo 1.26.0\n');await writeFile(resolve(dir,'empty.env'),'');
  execFileSync('go',['build','-trimpath','-buildmode=c-shared','-o',resolve(dir,'typedrows.wasm'),'.'],{cwd:dir,stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
  const port=await freePort(),inspector=await freePort();
  server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config',resolve(dir,'wrangler.jsonc'),'--env-file',resolve(dir,'empty.env'),'--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
  server.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-16000)});
  let first;
  for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('workerd exited before readiness');try{first=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(120000)});break;}catch(e){if(e.name==='TimeoutError')throw e;await setTimeout(200);}}
  assert.ok(first,'workerd did not start');
  const probes=[{commit:false,nested:false,fault:null,response:first},{commit:true,nested:false,fault:null},{commit:false,nested:true,fault:null},{commit:true,nested:true,fault:null},{commit:false,nested:false,fault:'corrupt'},{commit:false,nested:false,fault:'truncated'},{commit:false,nested:false,fault:'extra'},{commit:false,nested:false,fault:'early'}];
  for(const probe of probes){
    const params=new URLSearchParams();if(probe.commit)params.set('commit','1');if(probe.nested)params.set('nested','1');if(probe.fault)params.set('fault',probe.fault);
    const response=probe.response??await fetch(`http://127.0.0.1:${port}/?${params}`,{signal:AbortSignal.timeout(120000)});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
    assert.equal(result.ok,true);assert.equal(result.commit,probe.commit);assert.equal(result.nested,probe.nested);assert.equal(result.fault,probe.fault);
    if(!probe.fault)assert.equal(result.rows,probe.nested?9:10);else assert.ok(result.rows<10);
    assert.equal(result.closed,1);assert.ok(result.maxWire<65536);assert.ok(result.maxPages>0);
    console.log(`Local Workerd SQLite → Go/Wasm typed frames ${probe.fault?`${probe.fault} rollback`:probe.commit?'commit':'rollback'}${probe.nested?' with nested delete':''}: ${result.rows} rows, max JSON frame ${result.maxWire} bytes, sampled Wasm ${result.maxPages} pages.`);
  }
}catch(error){if(diagnostic)console.error(diagnostic);throw error;}
finally{if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await rm(dir,{recursive:true,force:true});}
