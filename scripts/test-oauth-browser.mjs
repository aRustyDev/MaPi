// An isolated, local HTTPS integration test. The issuer uses a self-signed
// test certificate; the RP is a separate loopback HTTPS server and never
// sends its client secret to the browser. Neither service is deployed.
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";

const temp=await mkdtemp(resolve(tmpdir(),"mapi-oauth-browser-"));
const realApp=process.env.MAPI_TEST_REAL_APP==="1";
let worker,rp,browser;
try {
  execFileSync(process.execPath,["scripts/build-login-assets.mjs"],{stdio:"inherit"});
  // Also builds the two-tag test reactor from the pinned source.
  if(process.env.MAPI_TEST_PREBUILT==="1")console.log("Using an existing test reactor; rebuild before recording evidence.");
  else execFileSync(process.execPath,["scripts/test-oauth-composition.mjs"],{stdio:"inherit",env:process.env});
  const cert=resolve(temp,"cert.pem"),key=resolve(temp,"key.pem");
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"],{stdio:"ignore"});
  const tls={key:await readFile(key),cert:await readFile(cert)};
  const portServer=createServer().listen(0,"127.0.0.1");await once(portServer,"listening");const port=portServer.address().port;await new Promise(done=>portServer.close(done));
  const origin=`https://localhost:${port}`;
  const operator=randomBytes(32).toString("base64url");
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
  const variables=resolve(temp,"worker.env");
  if(realApp) await copyFile("worker/generated/oauth-composition-test.wasm","worker/generated/nextgen-oidc.wasm");
  const envText=realApp
    ? `MAPI_APP_ORIGIN=${origin}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify({id:"master-test",pem:privateKey})).toString("base64")}\nMAPI_LOCAL_TEST=1\n`
    : `TEST_ORIGIN=${origin}\nTEST_AUTH=${operator}\nTEST_MASTER_KEY=${JSON.stringify(privateKey)}\n`;
  await writeFile(variables,envText,{mode:0o600});
  const inspectorServer=createServer().listen(0,"127.0.0.1");await once(inspectorServer,"listening");const inspector=inspectorServer.address().port;await new Promise(done=>inspectorServer.close(done));
  worker=spawn(process.execPath,[resolve("node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",realApp?"wrangler.oidc-local.jsonc":"scripts/oauth-browser-test.wrangler.jsonc","--env-file",variables,"--ip","127.0.0.1","--port",String(port),"--inspector-port",String(inspector),"--local-protocol","https","--https-key-path",key,"--https-cert-path",cert,"--persist-to",resolve(temp,"storage")],{stdio:["ignore","ignore","inherit"],env:{...process.env,WRANGLER_LOG_PATH:resolve(temp,"wrangler.log"),WRANGLER_SEND_METRICS:"false"}});
  function issuerRequest(path,{method="GET",headers={},body=""}={}) {
    return new Promise((done,fail)=>{const req=https.request({hostname:"127.0.0.1",port,path,method,headers:{host:`localhost:${port}`,...headers},rejectUnauthorized:false},res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>done({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on("error",fail);req.end(body);});
  }
  let ready=false;
  for(let i=0;i<100;i++){if(worker.exitCode!==null)throw Error("local workerd exited");try{await issuerRequest("/health");ready=true;break;}catch{await setTimeout(200);}}
  if(!ready)throw Error("local HTTPS workerd did not become ready");
  const transactions=new Map();
  let client,callback,tokenReplayStatus,requestError,firstAccessToken;
  rp=https.createServer(tls,async(req,res)=>{
    try {
      const url=new URL(req.url,callback);
      if(url.pathname==="/start"){
        const state=randomBytes(24).toString("base64url"),nonce=randomBytes(24).toString("base64url"),verifier=randomBytes(48).toString("base64url");
        const challenge=createHash("sha256").update(verifier).digest("base64url");transactions.set(state,{nonce,verifier});
        const query=new URLSearchParams({client_id:client.clientId,redirect_uri:callback+"/callback",response_type:"code",scope:"openid",state,nonce,code_challenge:challenge,code_challenge_method:"S256"});
        res.writeHead(302,{location:`${origin}/oauth/${client.projectId}/authorize?${query}`});res.end();return;
      }
      const state=url.searchParams.get("state"),transaction=transactions.get(state);
      if(url.pathname!=="/callback"||!transaction||!url.searchParams.get("code"))throw Error("invalid RP callback");
      transactions.delete(state);
      const body=new URLSearchParams({grant_type:"authorization_code",code:url.searchParams.get("code"),redirect_uri:callback+"/callback",code_verifier:transaction.verifier}).toString();
      const headers={"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`};
      const token=await issuerRequest(`/oauth/${client.projectId}/token`,{method:"POST",headers,body});
      if(token.status!==200)throw Error(`token exchange ${token.status}`);
      const tokenBody=JSON.parse(token.body),[head,payload,signature]=tokenBody.id_token.split(".");
      if(!firstAccessToken)firstAccessToken=tokenBody.access_token;
      const metadata=JSON.parse(Buffer.from(head,"base64url")),claims=JSON.parse(Buffer.from(payload,"base64url"));
      const jwks=await issuerRequest(`/oauth/${client.projectId}/jwks`);
      const jwk=JSON.parse(jwks.body).keys.find(k=>k.kid===metadata.kid);
      if(jwks.status!==200||!jwk||!verify("RSA-SHA256",Buffer.from(`${head}.${payload}`),createPublicKey({key:jwk,format:"jwk"}),Buffer.from(signature,"base64url")))throw Error("RP rejected ID token signature");
      if(claims.iss!==`${origin}/oauth/${client.projectId}`||claims.nonce!==transaction.nonce||!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes(client.clientId)||!claims.sub||claims.exp<=Date.now()/1000)throw Error("RP rejected ID token claims");
      tokenReplayStatus=(await issuerRequest(`/oauth/${client.projectId}/token`,{method:"POST",headers,body})).status;
      if(tokenReplayStatus<400)throw Error("authorization code replay accepted");
      res.writeHead(200,{"content-type":"text/html","cache-control":"no-store"});res.end("<!doctype html><h1>Authenticated by the independent RP</h1>");
    } catch(error){requestError=error;res.writeHead(500,{"content-type":"text/plain"});res.end("RP test failed");}
  });
  rp.listen(0,"127.0.0.1");await once(rp,"listening");callback=`https://127.0.0.1:${rp.address().port}`;
  const email=`browser-${randomUUID()}@example.com`,password=`Example-${randomUUID()}!`;
  const admin=async(path,body)=>issuerRequest(path,{method:"POST",headers:{authorization:`Bearer ${operator}`,"content-type":"application/json"},body:JSON.stringify(body)});
  if(realApp){
    const init=await admin("/_mapi/admin/init",{name:"Local OAuth browser project"});assert.equal(init.status,200);const projectId=JSON.parse(init.body).projectId;
    assert.equal((await admin("/_mapi/admin/users",{email,password})).status,200);
    assert.equal((await admin("/_mapi/admin/oidc/init",{})).status,200);
    const registered=await admin("/_mapi/admin/oidc/clients",{document:{slug:"test-rp",name:"Local test RP",clients:[{slug:"web",type:"confidential",grant_types:["authorization_code","refresh_token"],redirect_uris:[callback+"/callback"]}]}});
    assert.equal(registered.status,200);const secret=JSON.parse(registered.body).Secrets[0];client={projectId,clientId:secret.ClientID,clientSecret:secret.Secret};
    assert.equal((await admin("/_mapi/admin/oidc/logout-uri",{clientId:client.clientId,logoutUri:callback+"/signed-out"})).status,200);
    assert.equal((await admin("/_mapi/admin/oidc/rotate",{})).status,200);
    const rotated=await admin("/_mapi/admin/oidc/client-secret/rotate",{clientId:client.clientId});
    assert.equal(rotated.status,200);const replacement=JSON.parse(rotated.body);
    assert.equal(replacement.clientId,client.clientId);assert.ok(replacement.secret&&replacement.secret!==client.clientSecret);client.clientSecret=replacement.secret;
    assert.equal((await issuerRequest(`/_mapi/admin/oidc/init`,{method:"POST",headers:{authorization:"Bearer invalid","content-type":"application/json"},body:"{}"})).status,404);
    assert.equal((await issuerRequest(`/oauth/${projectId}/.well-known/openid-configuration`)).status,404);
  } else {
    const setup=await admin("/_test/setup",{email,password,redirectURI:callback+"/callback"});
    assert.equal(setup.status,200);client=JSON.parse(setup.body);
  }
  async function memoryUsage() {
    const status=await issuerRequest("/_mapi/admin/status",{headers:{authorization:`Bearer ${operator}`}});
    assert.equal(status.status,200);return JSON.parse(status.body).wasmMemoryBytes;
  }
  const memoryAfterSetup=realApp?await memoryUsage():null;
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
  page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(10000);
  let continuationOrigin,continuationReferer;
  const unexpected=[],failed=[],trace=[];page.on("request",r=>{const u=new URL(r.url()),o=u.origin;if(o!==origin&&o!==callback)unexpected.push(o);if(u.pathname.startsWith("/oauth/")||u.pathname==="/callback")trace.push(`${r.method()} ${u.pathname}`);if(u.pathname==="/oauth/continue"&&r.method()==="POST"){continuationOrigin=r.headers().origin;continuationReferer=r.headers().referer;}});
  page.on("console",msg=>{if(msg.type()==="error"&&msg.text().includes("Content Security Policy"))failed.push("browser blocked a CSP navigation");});
  page.on("response",r=>{const path=new URL(r.url()).pathname;if(r.status()>=400)failed.push(`${r.status()} ${path}`);if(path.startsWith("/oauth/")||path==="/callback")trace.push(`${r.status()} ${path}`);});
  page.on("requestfailed",r=>{failed.push(`network ${new URL(r.url()).pathname}: ${r.failure()?.errorText}`);});
  await page.goto(callback+"/start");
  assert.equal(await page.locator("zitadel-login").count(),1);
  await page.getByLabel("Email").fill(email);await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByTestId("zitadel-input-password").fill(password);await page.getByRole("button",{name:"Sign in",exact:true}).click();
  try { await page.waitForURL("**/oauth/continue?request=*"); }
  catch { throw Error(`login did not reach continuation: ${new URL(page.url()).pathname}; failed requests: ${failed.join(", ")}; alerts: ${(await page.getByRole("alert").allTextContents()).join(" ")}`); }
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  try { await page.waitForURL(`${callback}/callback**`); }
  catch { throw Error(`continuation did not reach RP: ${new URL(page.url()).pathname}; trace: ${trace.join(", ")}; failed requests: ${failed.join(", ")}; page: ${(await page.locator("body").innerText()).slice(0,200)}`); }
  if(requestError)throw requestError;
  await page.getByRole("heading",{name:"Authenticated by the independent RP"}).waitFor();
  assert.ok(tokenReplayStatus>=400);assert.deepEqual(unexpected,[]);
  assert.equal(continuationOrigin,origin);assert.equal(continuationReferer,origin+"/");
  await context.close();
  const memoryAfterFirst=realApp?await memoryUsage():null;
  console.log(`Local HTTPS ${realApp?"real app ingress":"private harness"}: official login -> independent RP callback, verified ID token and code replay rejection passed; no external backend requests.`);
  if(process.env.MAPI_TEST_BURST==="1"){
    if(!realApp)throw Error("The burst requires MAPI_TEST_REAL_APP=1");
    let next=0;const times=[];
    const burstStarted=Date.now();
    await Promise.all(Array.from({length:4},async()=>{
      while(next<20){
        next++;const started=Date.now(),ctx=await browser.newContext({ignoreHTTPSErrors:true});
        try{
          const tab=await ctx.newPage();tab.setDefaultTimeout(30000);tab.setDefaultNavigationTimeout(30000);
          const errors=[];tab.on("response",r=>{if(r.status()>=400)errors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
          try {
            await tab.goto(callback+"/start");await tab.getByLabel("Email").fill(email);await tab.getByRole("button",{name:"Continue",exact:true}).click();
            await tab.getByTestId("zitadel-input-password").fill(password);await tab.getByRole("button",{name:"Sign in",exact:true}).click();
            await tab.waitForURL("**/oauth/continue?request=*");await tab.getByRole("button",{name:"Continue",exact:true}).click();
            await tab.getByRole("heading",{name:"Authenticated by the independent RP"}).waitFor();times.push(Date.now()-started);
          } catch { throw Error(`burst journey failed at ${new URL(tab.url()).pathname}; responses: ${errors.join(", ")}; RP: ${requestError?.message??"none"}`); }
        }finally{await ctx.close();}
      }
    }));
    times.sort((a,b)=>a-b);assert.equal(times.length,20);
    const memoryAfterBurst=await memoryUsage();
    console.log(`20 browser RP journeys, concurrency 4: wall ${Date.now()-burstStarted} ms, p95 ${times[18]} ms, min ${times[0]} ms; Wasm linear memory setup ${memoryAfterSetup}, first ${memoryAfterFirst}, burst ${memoryAfterBurst} bytes.`);
  }
  if(realApp){
    assert.ok(firstAccessToken);
    assert.equal((await admin("/_mapi/admin/oidc/client-secret/revoke",{clientId:client.clientId})).status,200);
    assert.equal((await issuerRequest(`/oauth/${client.projectId}/userinfo`,{headers:{authorization:`Bearer ${firstAccessToken}`}})).status,401);
  }
} finally {
  if(browser)await browser.close();
  if(rp)await new Promise(done=>rp.close(done));
  if(worker&&worker.exitCode===null&&worker.signalCode===null){const stopped=once(worker,"exit");worker.kill("SIGTERM");await stopped;}
  await rm(temp,{recursive:true,force:true});
}
