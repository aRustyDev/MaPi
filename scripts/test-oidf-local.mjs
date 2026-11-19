// Partial Basic OP exploration against a locally running OIDF suite. This is
// not certification: only selected modules are attempted and a test can remain
// WAITING when the issuer rejects a browser request instead of redirecting.
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";

const temp=await mkdtemp(resolve(tmpdir(),"mapi-oidf-run-"));
let worker,browser;
try {
  if(process.env.MAPI_OIDF_PREBUILT!=="1") {
    execFileSync("bash",["scripts/build-oidc.sh"],{stdio:"inherit"});
    execFileSync(process.execPath,["scripts/build-login-assets.mjs"],{stdio:"inherit"});
  } else console.log("Using prebuilt local issuer; rebuild before recording evidence.");
  async function freePort(){const server=createServer().listen(0,"127.0.0.1");await once(server,"listening");const port=server.address().port;await new Promise(done=>server.close(done));return port;}
  const port=await freePort(),inspector=await freePort(),origin=`https://host.docker.internal:${port}`;
  const cert=resolve(temp,"cert.pem"),key=resolve(temp,"key.pem");
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=host.docker.internal","-addext","subjectAltName=DNS:host.docker.internal"],{stdio:"ignore"});
  const issuerCert=await readFile(cert);
  const suiteCert=execFileSync("docker",["exec","mapi-oidf-local-nginx-1","cat","/etc/ssl/certs/nginx-selfsigned.crt"]);
  const spki=(pem)=>createHash("sha256").update(createPublicKey(pem).export({type:"spki",format:"der"})).digest("base64");
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
  const operator=randomBytes(32).toString("base64url"),variables=resolve(temp,"worker.env");
  await writeFile(variables,`MAPI_APP_ORIGIN=${origin}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify({id:"master-test",pem:privateKey})).toString("base64")}\nMAPI_LOCAL_TEST=1\n`,{mode:0o600});
  worker=spawn(process.execPath,[resolve("node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config","wrangler.oidc-local.jsonc","--env-file",variables,"--ip","127.0.0.1","--port",String(port),"--inspector-port",String(inspector),"--local-protocol","https","--https-key-path",key,"--https-cert-path",cert,"--persist-to",resolve(temp,"storage")],{stdio:["ignore","ignore","inherit"],env:{...process.env,WRANGLER_LOG_PATH:resolve(temp,"wrangler.log"),WRANGLER_SEND_METRICS:"false"}});
  function call(port,host,path,{method="GET",headers={},body=""}={}) {
    const issuerHost=host.startsWith("host.docker.internal:");
    return new Promise((done,fail)=>{const req=https.request({hostname:"127.0.0.1",port,path,method,headers:{host,...headers},ca:issuerHost?issuerCert:suiteCert,servername:issuerHost?"host.docker.internal":"localhost"},res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>done({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on("error",fail);req.end(body);});
  }
  const issuer=(path,opts)=>call(port,`host.docker.internal:${port}`,path,opts);
  const suite=(path,opts)=>call(8443,"localhost.emobix.co.uk:8443",path,opts);
  let ready=false;for(let i=0;i<100;i++){if(worker.exitCode!==null)throw Error("workerd exited");try{await issuer("/health");ready=true;break;}catch{await setTimeout(200);}}
  if(!ready)throw Error("local issuer did not start");
  const admin=async(path,body)=>issuer(path,{method:"POST",headers:{authorization:`Bearer ${operator}`,"content-type":"application/json"},body:JSON.stringify(body)});
  const init=await admin("/_mapi/admin/init",{name:"OIDF local test"});assert.equal(init.status,200);
  const project=JSON.parse(init.body).projectId,alias=`mapi-${randomUUID().replaceAll("-","")}`;
  const email=`oidf-${randomUUID()}@example.com`,password=`Example-${randomUUID()}!`;
  assert.equal((await admin("/_mapi/admin/users",{email,password})).status,200);
  assert.equal((await admin("/_mapi/admin/oidc/init",{})).status,200);
  const redirect=`https://localhost.emobix.co.uk:8443/test/a/${alias}/callback`;
  const clients=[];
  for(let i=0;i<2;i++){
    const app=await admin("/_mapi/admin/oidc/clients",{document:{slug:`oidf-${i}`,name:`OIDF ${i}`,clients:[{slug:"web",type:"confidential",grant_types:["authorization_code","refresh_token"],redirect_uris:[redirect]}]}});
    assert.equal(app.status,200);const c=JSON.parse(app.body).Secrets[0];clients.push({client_id:c.ClientID,client_secret:c.Secret});
  }
  const issuerBase=`${origin}/oauth/${project}`;
  const config={alias,description:"MaPi local isolated Basic OP exploration",server:{issuer:issuerBase,authorization_endpoint:`${issuerBase}/authorize`,token_endpoint:`${issuerBase}/token`,jwks_uri:`${issuerBase}/jwks`,userinfo_endpoint:`${issuerBase}/userinfo`},client:clients[0],client2:clients[1],client_secret_post:clients[0]};
  const variant={server_metadata:"static",client_registration:"static_client"};
  const planQuery=new URLSearchParams({planName:"oidcc-basic-certification-test-plan",variant:JSON.stringify(variant)});
  const created=await suite(`/api/plan?${planQuery}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(config)});
  assert.equal(created.status,201);const plan=JSON.parse(created.body);
  console.log(`Official Basic OP plan created locally with ${plan.modules.length} modules; attempting selected modules only.`);
  browser=await chromium.launch({headless:true,args:["--host-resolver-rules=MAP host.docker.internal 127.0.0.1, MAP localhost.emobix.co.uk 127.0.0.1",`--ignore-certificate-errors-spki-list=${spki(issuerCert)},${spki(suiteCert)}`]});
  const selected=process.env.MAPI_OIDF_ALL==="1" ? plan.modules.map(m=>m.testModule) : ["oidcc-server","oidcc-ensure-request-with-valid-pkce-succeeds","oidcc-response-type-missing"];
  const outcomes=[];
  for(const name of selected){
    const module=plan.modules.find(m=>m.testModule===name);
    if(!module){console.log(`${name}: not present in configured plan`);continue;}
    const query=new URLSearchParams({test:name,plan:plan.id,variant:JSON.stringify(module.variant)});
    const started=await suite(`/api/runner?${query}`,{method:"POST",headers:{"content-type":"application/json"}});
    if(started.status!==201){console.log(`${name}: could not start (HTTP ${started.status})`);continue;}
    const id=JSON.parse(started.body).id;
    let status,details;
    for(let i=0;i<50;i++){
      const info=await suite(`/api/info/${id}`);details=JSON.parse(info.body);status=details.status;
      if(["WAITING","FINISHED","INTERRUPTED"].includes(status))break;
      await setTimeout(200);
    }
    let browserStatus=null;
    if(status==="WAITING"){
      const info=await suite(`/api/runner/${id}`);const urls=JSON.parse(info.body).browser?.urls??[];
      if(urls.length){
        const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(8000);
        try {
          const initial=await page.goto(urls[0],{waitUntil:"domcontentloaded"});browserStatus=initial?.status()??null;
          if(await page.locator("zitadel-login").count()){
            await page.getByLabel("Email").fill(email);await page.getByRole("button",{name:"Continue",exact:true}).click();
            await page.getByTestId("zitadel-input-password").fill(password);await page.getByRole("button",{name:"Sign in",exact:true}).click();
            await page.waitForURL("**/oauth/continue?request=*");await page.getByRole("button",{name:"Continue",exact:true}).click();
            await page.waitForURL("**/callback**");
          }
        } catch { /* Report the module state and response status below. */ }
        await context.close();
      }
      for(let i=0;i<25;i++){const info=await suite(`/api/info/${id}`);details=JSON.parse(info.body);status=details.status;if(["FINISHED","INTERRUPTED"].includes(status))break;await setTimeout(200);}
    }
    let failureConditions=[];
    if(["INTERRUPTED","FINISHED"].includes(status)){
      const log=await suite(`/api/log/${id}`);
      if(log.status===200)failureConditions=JSON.parse(log.body).filter(e=>e.result==="FAILURE").map(e=>e.src).filter(Boolean);
    }
    outcomes.push({module:name,status,result:details?.result??null,browserStatus,failureConditions:[...new Set(failureConditions)]});
    console.log(`${name}: suite status=${status}, result=${details?.result??"none"}, browser HTTP=${browserStatus??"none"}, failing conditions=${failureConditions.join(",")||"none"}`);
    if(status==="WAITING")await suite(`/api/runner/${id}`,{method:"DELETE"});
  }
  const output=process.env.MAPI_OIDF_RESULTS;
  if(output)await writeFile(output,JSON.stringify({suiteImage:"sha256:605026d2b54d17e64b55b3aa3911b394e3b6fff30d26c7ba7e9d50688cbe776a",plan:"oidcc-basic-certification-test-plan",variant,configuredModules:plan.modules.length,attempted:outcomes.length,outcomes},null,2),{mode:0o600});
} finally {
  if(browser)await browser.close();
  if(worker&&worker.exitCode===null&&worker.signalCode===null){const stopped=once(worker,"exit");worker.kill("SIGTERM");await stopped;}
  await rm(temp,{recursive:true,force:true});
}
