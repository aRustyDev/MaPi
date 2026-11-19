import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const operator='synthetic-operator-secret', secret='synthetic-client-secret', calls=[];
const server=createServer(async(req,res)=>{
 let data='';for await(const chunk of req)data+=chunk;
 calls.push({method:req.method,path:req.url,auth:req.headers.authorization,body:data?JSON.parse(data):null});
 res.setHeader('content-type','application/json');
 if(req.url==='/_mapi/admin/oidc/clients')res.end(JSON.stringify({Secrets:[{ClientID:'client-test',Secret:secret}]}));
 else if(req.url==='/_mapi/admin/oidc/client-secret/rotate')res.end(JSON.stringify({clientId:'client-test',secret}));
 else res.end(JSON.stringify({ok:true}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const dir=await mkdtemp(resolve(tmpdir(),'mapi-oidc-cli-'));
try{
 const env={...process.env,MAPI_URL:`http://127.0.0.1:${server.address().port}`,MAPI_OPERATOR_TOKEN:operator};
 async function cli(args,input=''){
  const child=spawn(process.execPath,['scripts/mapi.mjs',...args],{env,stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.stdin.end(input);
  const [code]=await once(child,'exit');return {code,out,err};
 }
 const app={slug:'shop',name:'Shop',clients:[{slug:'web',type:'confidential',grant_types:['authorization_code','refresh_token'],redirect_uris:['https://shop.example/callback']}]};
 const file=resolve(dir,'app.json');await writeFile(file,JSON.stringify(app));
 for(const command of [['admin','oidc','init'],['admin','oidc','rotate'],['admin','oidc','logout-uri','add','--client-id','client-test','--uri','https://shop.example/logout']]){
  const result=await cli(command);assert.equal(result.code,0,result.err);assert.deepEqual(JSON.parse(result.out),{ok:true});assert(!result.out.includes(operator));
 }
 for(const source of [file,'-']){
  const result=await cli(['admin','oidc','client','add','--file',source],source==='-'?JSON.stringify(app):'');
  assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).Secrets[0].Secret,secret);assert(result.err.includes('shown once'));assert(!result.err.includes(secret));assert(!result.out.includes(operator));
 }
 const rotation=await cli(['admin','oidc','client-secret','rotate','--client-id','client-test']);assert.equal(rotation.code,0,rotation.err);assert.equal(JSON.parse(rotation.out).secret,secret);assert(rotation.err.includes('shown once'));assert(!rotation.err.includes(secret));
 const revoked=await cli(['admin','oidc','client-secret','revoke','--client-id','client-test']);assert.equal(revoked.code,0,revoked.err);
 assert.deepEqual(calls.map(c=>c.path),['/_mapi/admin/oidc/init','/_mapi/admin/oidc/rotate','/_mapi/admin/oidc/logout-uri','/_mapi/admin/oidc/clients','/_mapi/admin/oidc/clients','/_mapi/admin/oidc/client-secret/rotate','/_mapi/admin/oidc/client-secret/revoke']);
 assert(calls.every(c=>c.method==='POST'&&c.auth===`Bearer ${operator}`));assert.deepEqual(calls[2].body,{clientId:'client-test',logoutUri:'https://shop.example/logout'});assert.deepEqual(calls[3].body,{document:app});assert.deepEqual(calls[4].body,{document:app});assert.deepEqual(calls[5].body,{clientId:'client-test'});assert.deepEqual(calls[6].body,{clientId:'client-test'});
 const flowStatus=await cli(['admin','oidc','flow','status']);assert.equal(flowStatus.code,0,flowStatus.err);
 const flowPublish=await cli(['admin','oidc','flow','publish','--file',file,'--expected-deployment','dep-current']);assert.equal(flowPublish.code,0,flowPublish.err);
 const flowRollback=await cli(['admin','oidc','flow','rollback','--target-deployment','dep-old','--expected-deployment','dep-current']);assert.equal(flowRollback.code,0,flowRollback.err);
 assert.deepEqual(calls.slice(7).map(c=>c.path),['/_mapi/admin/oidc/flow/status','/_mapi/admin/oidc/flow/publish','/_mapi/admin/oidc/flow/rollback']);
 assert.deepEqual(calls[8].body,{document:app,expectedDeploymentId:'dep-current'});assert.deepEqual(calls[9].body,{targetDeploymentId:'dep-old',expectedDeploymentId:'dep-current'});
 const before=calls.length;const bad=await cli(['admin','oidc','client','add','--file','-'],'not json');assert.notEqual(bad.code,0);assert.equal(calls.length,before);
 console.log('OIDC operator CLI requests, stdin/file input and one-time secret handling passed.');
}finally{server.close();await rm(dir,{recursive:true,force:true});}
