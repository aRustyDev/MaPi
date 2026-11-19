import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

async function port() { const s=createServer().listen(0,"127.0.0.1");await once(s,"listening");const p=s.address().port;await new Promise(done=>s.close(done));return p; }
const dir=await mkdtemp(resolve(tmpdir(),"mapi-owner-guard-")), address=await port(), inspector=await port(), envFile=resolve(dir,"worker.env");
const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
const master=Buffer.from(JSON.stringify({id:"master-test",pem:privateKey})).toString("base64");
await writeFile(envFile,`MAPI_MASTER_KEY=${master}\n`,{mode:0o600});
const server=spawn(process.execPath,[resolve("node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config","scripts/hot-path-guard-test.wrangler.jsonc","--env-file",envFile,"--ip","127.0.0.1","--port",String(address),"--inspector-port",String(inspector),"--persist-to",dir],{stdio:["ignore","ignore","inherit"],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,"wrangler.log"),WRANGLER_SEND_METRICS:"false"}});
try {
  let response;
  for(let i=0;i<100;i++){if(server.exitCode!==null)throw new Error("local workerd exited");try{response=await fetch(`http://127.0.0.1:${address}/`,{signal:AbortSignal.timeout(120000)});break;}catch(error){if(error.name==="TimeoutError")throw error;await setTimeout(200);}}
  if(!response)throw new Error("local workerd did not start");
  if(response.status!==200)throw new Error(`guard test returned HTTP ${response.status}`);
  const result=await response.json();assert.equal(result.ok,true);assert.equal(result.allowed,59);assert.equal(result.rejected,6);
  console.log("Owner hot-path identity/origin, maintenance/recovery fence and concurrent scoped throttle passed.");
} finally {
  if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,"exit");server.kill("SIGTERM");await stopped;}
  await rm(dir,{recursive:true,force:true});
}
