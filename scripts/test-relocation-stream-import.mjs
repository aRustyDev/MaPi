import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
async function port() { const server = createServer().listen(0,'127.0.0.1'); await once(server,'listening'); const n = server.address().port; await new Promise((ok,fail)=>server.close(error=>error?fail(error):ok())); return n; }
const dir=await mkdtemp(resolve(tmpdir(),'mapi-stream-import-')), env=resolve(dir,'empty.env'); await writeFile(env,''); const n=await port(), inspector=await port();
const server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/relocation-stream-import-test.wrangler.jsonc','--env-file',env,'--ip','127.0.0.1','--port',String(n),'--inspector-port',String(inspector),'--persist-to',dir],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
let diagnostic=''; server.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-16000)});
try { let response; for(let i=0;i<100;i++) { if(server.exitCode!==null) throw Error('Wrangler exited'); try { response=await fetch(`http://127.0.0.1:${n}/`); break; } catch { await setTimeout(200); } } if(!response) throw Error('Wrangler did not start'); const body=await response.json(); assert.equal(response.status,200,JSON.stringify(body)); assert.equal(body.ok,true); console.log('Stream import passed near-limit TEXT, binary, NUL, typed values, rollback and owner eviction in Workerd.'); } catch(error) {if(diagnostic) console.error(diagnostic);throw error;} finally { if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await rm(dir,{recursive:true,force:true}); }
