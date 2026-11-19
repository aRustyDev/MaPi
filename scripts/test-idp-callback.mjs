import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import https from 'node:https';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(done=>s.close(done));return n;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-idp-callback-'));let worker,idp,diagnostics='';
try {
 execFileSync('node',['scripts/build-egress-spike.mjs'],{stdio:'inherit',env:process.env});
 const cert=resolve(dir,'cert.pem'),key=resolve(dir,'key.pem'),ca=resolve(dir,'ca.pem'),caKey=resolve(dir,'ca-key.pem'),csr=resolve(dir,'csr'),ext=resolve(dir,'ext');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=MaPi Test CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout',caKey,'-out',ca],{stdio:'ignore'});
 execFileSync('openssl',['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',key,'-out',csr],{stdio:'ignore'});
 await writeFile(ext,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
 execFileSync('openssl',['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-days','1','-extfile',ext,'-out',cert],{stdio:'ignore'});
 const ip=await port(),wp=await port(),inspector=await port(),issuer=`https://127.0.0.1:${ip}`,testKey=randomBytes(32).toString('hex');
 const signing=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...signing.publicKey.export({format:'jwk'}),kid:'synthetic-key',alg:'RS256',use:'sig'};
 let mode='valid',tokenCalls=0,total=0;
 const jwt=()=>{const now=Math.floor(Date.now()/1000),enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),text=enc({alg:'RS256',kid:'synthetic-key'})+'.'+enc({iss:mode==='wrong-issuer'?'https://wrong.example':issuer,aud:mode==='wrong-audience'?'other':'synthetic',sub:'user-1',exp:now+600,iat:now,nonce:mode==='wrong-nonce'?'wrong':'synthetic-nonce'});return text+'.'+sign('RSA-SHA256',Buffer.from(text),signing.privateKey).toString('base64url');};
 idp=https.createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{total++;if(req.url==='/token')tokenCalls++;res.setHeader('content-type','application/json');
  if(mode==='slow'&&req.url==='/token')await setTimeout(2000);
  if(mode==='redirect'&&req.url==='/token'){res.writeHead(302,{location:'http://169.254.169.254/'});res.end();return;}
  if(req.url==='/.well-known/openid-configuration'){res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',userinfo_endpoint:issuer+'/userinfo',jwks_uri:mode==='external-keys'?'https://example.com/keys':issuer+'/keys'}));return;}
  if(req.url==='/token'){if(req.destroyed)return;assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Basic '+Buffer.from('synthetic:synthetic-secret').toString('base64'));let body='';try {for await(const chunk of req)body+=chunk;}catch{return;}const form=new URLSearchParams(body);assert.equal(form.get('code'),'synthetic-code');assert.equal(form.get('code_verifier'),'synthetic-verifier-abcdefghijklmnopqrstuvwxyz0123456789');if(mode==='oversized'){res.end('x'.repeat(20000));return;}res.end(JSON.stringify({access_token:'synthetic-access',token_type:'Bearer',id_token:jwt()}));return;}
  if(req.url==='/keys'){res.end(JSON.stringify({keys:[jwk]}));return;}
  if(req.url==='/userinfo'){assert.equal(req.headers.authorization,'Bearer synthetic-access');res.end(JSON.stringify({sub:mode==='wrong-sub'?'other':'user-1',email:'user@example.test'}));return;}
  res.writeHead(404);res.end();
 });
 await new Promise(done=>idp.listen(ip,'127.0.0.1',done));
 const env=resolve(dir,'vars');await writeFile(env,`MAPI_LOCAL_TEST=1\nMAPI_EGRESS_ORIGIN=${issuer}\nMAPI_TEST_KEY=${testKey}\n`,{mode:0o600});
 worker=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/idp-callback.wrangler.jsonc','--env-file',env,'--ip','127.0.0.1','--port',String(wp),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_EXTRA_CA_CERTS:ca,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-8000);});
 async function req(path,data){const response=await fetch(`http://127.0.0.1:${wp}${path}`,{method:'POST',headers:{'content-type':'application/json','x-local-test-key':testKey},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});return {status:response.status,data:await response.json().catch(()=>null)};}
 for(let i=0;;i++){if(worker.exitCode!==null||i===100)throw Error('workerd failed');try{await req('/status',{id:'ready'});break;}catch{await setTimeout(200);}}
 const binding='synthetic-browser-binding-1',run=(id,extra={})=>req('/run',{id,issuer,binding,...extra});
 let r=await run('valid');assert.deepEqual(r.data,{subject:'user-1',email:'user@example.test'});let before=tokenCalls;
 assert.deepEqual((await run('valid')).data,r.data);assert.equal(tokenCalls,before);
 assert.equal((await run('valid',{binding:'different-browser-binding'})).data.error,'denied');assert.equal(tokenCalls,before);
 for(const [bad,expected] of Object.entries({'wrong-nonce':'callback_failed','wrong-issuer':'callback_failed','wrong-audience':'callback_failed','wrong-sub':'callback_failed','external-keys':'denied','oversized':'oversized','redirect':'redirect','slow':'timeout'})){mode=bad;r=await run(bad);assert.equal(r.data?.error,expected,JSON.stringify({case:bad,result:r.data}));}
 mode='valid';before=tokenCalls;r=await run('commit-failure',{failStage:'commit'});assert.equal(r.status,500);assert.equal(tokenCalls,before+1);const failedCommit=(await req('/status',{id:'commit-failure'})).data;assert.equal(failedCommit.state,'pending');assert.equal(failedCommit.result,null);assert.equal(failedCommit.auditCount,0);assert.equal((await run('commit-failure')).data.error,'restart_required');assert.equal(tokenCalls,before+1);
 mode='valid';before=tokenCalls;r=await run('interrupted',{failStage:'after-token'});assert.equal(r.status,500);assert.equal(tokenCalls,before+1);assert.equal((await run('interrupted')).data.error,'restart_required');assert.equal(tokenCalls,before+1);
 mode='slow';before=tokenCalls;const both=await Promise.all([run('concurrent'),run('concurrent')]);assert.equal(both.filter(x=>x.data?.error==='restart_required').length,1);assert.equal(tokenCalls,before+1);
 console.log(`Pinned Nextgen OIDC discovery, token, JWKS and userinfo callback passed through bounded local workerd egress (${total} provider calls).`);
}catch(error){if(diagnostics)console.error(diagnostics);throw error;}finally{if(worker&&worker.exitCode===null&&worker.signalCode===null){const stopped=once(worker,'exit');worker.kill('SIGTERM');await stopped;}if(idp)await new Promise(done=>idp.close(done));await rm(dir,{recursive:true,force:true});}
