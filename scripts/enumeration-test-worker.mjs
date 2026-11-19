// Local-only browser harness. Never deployed or mounted in the application.
import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/enumeration-test.wasm';
import baseline from '../worker/generated/baseline.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
import { renderLogin } from '../worker/login-ui.js';
import { handleFlowProxy } from '../worker/flow-proxy.js';
const enc=new TextEncoder(),dec=new TextDecoder(),rejected=Symbol('rollback');
export class EnumerationTest extends DurableObject {
 reactor;memory;project;origin;token;
 call(name,data){const bytes=enc.encode(JSON.stringify(data)),ptr=this.reactor.mapi_alloc(bytes.length);new Uint8Array(this.memory(),ptr,bytes.length).set(bytes);bytes.fill(0);const packed=this.reactor[name](),p=Number(packed>>32n),n=Number(packed&0xffffffffn),out=JSON.parse(dec.decode(new Uint8Array(this.memory(),p,n)));this.reactor.mapi_release();if(out?.error)throw Error(`${name}: ${out.error}`);return out;}
 setup(args){
  this.ctx.storage.transactionSync(()=>{for(const statement of baseline.statements)this.ctx.storage.sql.exec(statement);this.ctx.storage.sql.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY,schema_url TEXT NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)');this.ctx.storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)',args.origin);});
  this.origin=args.origin;this.boot();
  this.call('mapi_init',{id:'master-test',pem:atob(this.env.TEST_MASTER_KEY),projectId:''});this.project=this.call('mapi_provision',{name:'FAPI browser project',origin:args.origin}).projectId;
  this.call('mapi_init',{id:'master-test',pem:atob(this.env.TEST_MASTER_KEY),projectId:this.project});this.call('mapi_add_user',{projectId:this.project,email:args.email,password:args.password});this.token=this.call('mapi_project_token',{projectId:this.project}).token;
  this.ctx.storage.sql.exec('CREATE TABLE mapi_masked_flows(flow_id TEXT PRIMARY KEY, valid INTEGER NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_masked_limits(key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_masked_identifiers(key TEXT NOT NULL, time_ms INTEGER NOT NULL)');this.ctx.storage.sql.exec('CREATE INDEX mapi_masked_identifiers_key_time ON mapi_masked_identifiers(key,time_ms)');
  const status=this.call('mapi_flow_release',{projectId:this.project,origin:this.origin,action:'status'});const definition=args.definition;definition.name=status.loginFlows[0].name;this.call('mapi_flow_release',{projectId:this.project,origin:this.origin,action:'publish',document:definition,expectedDeploymentId:status.deploymentId});this.call('mapi_enumeration_dummy_init',{});return {projectId:this.project};
 }
 boot(){
  let output,reactor;reactor=instantiateReactor(wasm,get=>{this.memory=get;return{sql:(p,n)=>{const q=JSON.parse(dec.decode(new Uint8Array(this.memory(),p,n)));let out;try{out=execute(this.ctx.storage,q);}catch(e){out={error:sqliteError(e)};}output=enc.encode(JSON.stringify(out));return output.length;},result:(p,n)=>{new Uint8Array(this.memory(),p,n).set(output);output.fill(0);output=undefined;},transaction:()=>{try{this.ctx.storage.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rejected;});return 0;}catch(e){return e===rejected?1:2;}}};});this.reactor=reactor;
 }
 ensure(){if(this.reactor)return;let row;try{row=this.ctx.storage.sql.exec('SELECT project_id FROM mapi_project').toArray()[0];}catch{return;}if(!row)return;this.project=row.project_id;this.origin=this.ctx.storage.sql.exec('SELECT origin FROM mapi_project_origin').one().origin;this.boot();this.call('mapi_init',{id:'master-test',pem:atob(this.env.TEST_MASTER_KEY),projectId:this.project});this.token=this.call('mapi_project_token',{projectId:this.project}).token;this.call('mapi_enumeration_dummy_init',{});}
 identity(){this.ensure();return this.project;}
 counts(){this.ensure();return {users:this.ctx.storage.sql.exec('SELECT count(*) AS n FROM users WHERE project_id=?',this.project).one().n,credentialFactors:this.ctx.storage.sql.exec('SELECT count(*) AS n FROM checks WHERE project_id=? AND session_id IS NOT NULL AND last_verified_at IS NOT NULL AND type <> 1',this.project).one().n};}
 session(cookie){this.ensure();return this.call('mapi_request',{method:'GET',url:this.origin+'/api/v1/sessions/me?project_id='+encodeURIComponent(this.project),headers:{cookie:[cookie]},body:'',peer:'127.0.0.1'});}
 limits(){this.ensure();return this.ctx.storage.sql.exec('SELECT key,window,count FROM mapi_masked_limits ORDER BY key').toArray();}
 seedLimits(ip,count){this.ensure();const window=Math.floor(Date.now()/60000);this.ctx.storage.sql.exec('INSERT INTO mapi_masked_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=excluded.count',`ip:${ip}`,window,count);}
 async identifierKey(value){
  if(typeof value!=='string'||!value||enc.encode(value).length>1024)throw Error('invalid identifier');
  const key=await crypto.subtle.importKey('raw',Uint8Array.fromBase64(this.env.TEST_THROTTLE_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const message=enc.encode(JSON.stringify(['mapi-enumeration-test-v1',this.project,value.normalize('NFKC').toLowerCase()]));
  return new Uint8Array(await crypto.subtle.sign('HMAC',key,message)).toBase64();
 }
 async identityCount(identifier){this.ensure();const key=await this.identifierKey(identifier);return this.ctx.storage.sql.exec('SELECT count(*) AS n FROM mapi_masked_identifiers WHERE key=? AND time_ms>?',key,Date.now()-900000).one().n;}
 async seedIdentity(identifier,count){this.ensure();if(!Number.isInteger(count)||count<0||count>12)throw Error('bad seed');const key=await this.identifierKey(identifier);this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM mapi_masked_identifiers WHERE key=?',key);for(let i=0;i<count;i++)this.ctx.storage.sql.exec('INSERT INTO mapi_masked_identifiers VALUES (?,?)',key,Date.now());});}
 async ageIdentity(identifier){this.ensure();const key=await this.identifierKey(identifier);this.ctx.storage.sql.exec('UPDATE mapi_masked_identifiers SET time_ms=? WHERE key=?',Date.now()-900001,key);}
 expireFlow(flow){this.ensure();const sql=this.ctx.storage.sql;if(!sql.exec('SELECT id FROM auth_attempts WHERE project_id=? AND flow_id=?',this.project,flow).toArray().length)throw Error('unknown flow');sql.exec('UPDATE auth_attempts SET created_at=1 WHERE project_id=? AND flow_id=?',this.project,flow);}
 identityKeyShape(){this.ensure();return this.ctx.storage.sql.exec('SELECT DISTINCT key FROM mapi_masked_identifiers').toArray().every(row=>/^[A-Za-z0-9+/]{43}=$/.test(row.key));}
 evict(){this.ctx.abort("synthetic FAPI eviction");}
 maskedFailure(flowId,peer){
  const sql=this.ctx.storage.sql;sql.exec('UPDATE mapi_masked_flows SET valid=0 WHERE flow_id=?',flowId);
  const start={method:'POST',url:this.origin+'/api/v1/flows',headers:{'content-type':['application/json'],origin:[this.origin]},body:enc.encode(JSON.stringify({project_id:this.project,purpose:'login'})).toBase64(),peer};
  const fresh=this.call('mapi_request',start);if(fresh.status!==201)throw Error('fresh flow unavailable');const normalized=JSON.parse(dec.decode(Uint8Array.fromBase64(fresh.body)));normalized.step.error='error.invalid_credentials';sql.exec('INSERT INTO mapi_masked_flows VALUES (?,1)',normalized.id);fresh.status=400;fresh.body=enc.encode(JSON.stringify(normalized)).toBase64();return fresh;
 }
 async flowRequest(request){
  this.ensure();const url=new URL(request.url),path=url.pathname,sql=this.ctx.storage.sql;
  if(path==='/api/v1/sessions/exchange'){request.headers.authorization=[`Bearer ${this.token}`];return this.call('mapi_request',request);}
  const match=path.match(/^\/api\/v1\/flows\/(flow_[A-Za-z0-9_-]+)(\/submit)?$/);
  if(match){const row=sql.exec('SELECT valid FROM mapi_masked_flows WHERE flow_id=?',match[1]).toArray()[0];if(!row?.valid)return {status:404,headers:{},body:''};}
  if(match?.[2]){
   // Keep the original object/IP gate ahead of all HMAC and upstream work,
   // including malformed requests and requests with an invalid flow cookie.
   const window=Math.floor(Date.now()/60000),ip=request.peer??'local';const permitted=this.ctx.storage.transactionSync(()=>{for(const [limit,max] of [['global',120],[`ip:${ip}`,60]]){const row=sql.exec('SELECT window,count FROM mapi_masked_limits WHERE key=?',limit).toArray()[0];if(row?.window===window&&row.count>=max)return false;}for(const limit of ['global',`ip:${ip}`])sql.exec('INSERT INTO mapi_masked_limits VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window',limit,window);return true;});
   if(!permitted)return {status:429,headers:{},body:''};
   let body;try{body=JSON.parse(dec.decode(Uint8Array.fromBase64(request.body)));}catch{return {status:400,headers:{},body:''};}
   const identifier=body.fields?.email,password=body.fields?.['x-auth-methods#password'];if(typeof identifier!=='string'||!identifier||typeof password!=='string'||enc.encode(identifier).length>1024||enc.encode(password).length>1024)return {status:400,headers:{},body:''};
   const key=await this.identifierKey(identifier);
   // The HMAC call yields: re-check the authoritative flow after it returns.
   if(!sql.exec('SELECT valid FROM mapi_masked_flows WHERE flow_id=?',match[1]).toArray()[0]?.valid)return {status:404,headers:{},body:''};
   // A blocked identifier must not let a guessed flow ID invalidate another browser's flow.
   const probe=this.call('mapi_request',{...request,method:'GET',url:this.origin+'/api/v1/flows/'+match[1],body:''});if(probe.status!==200)return probe;
   const now=Date.now();const admitted=this.ctx.storage.transactionSync(()=>{sql.exec('DELETE FROM mapi_masked_identifiers WHERE key=? AND time_ms<=?',key,now-900000);if(sql.exec('SELECT count(*) AS n FROM mapi_masked_identifiers WHERE key=?',key).one().n>=12)return 'masked';sql.exec('INSERT INTO mapi_masked_identifiers VALUES (?,?)',key,now);return 'allow';});
   if(admitted==='masked'){this.call('mapi_enumeration_dummy_verify',{password});return this.maskedFailure(match[1],request.peer);}
  }
  const result=this.call('mapi_request',request);
  const data=result.body?JSON.parse(dec.decode(Uint8Array.fromBase64(result.body))):null;
  if(path==='/api/v1/flows'&&request.method==='POST'&&result.status===201&&data?.id)sql.exec('INSERT INTO mapi_masked_flows VALUES (?,1)',data.id);
  if(match?.[2]&&result.status===400&&['error.user_not_found','error.invalid_credentials'].includes(data?.step?.error)){
   const body=JSON.parse(dec.decode(Uint8Array.fromBase64(request.body)));const password=body.fields?.['x-auth-methods#password'];if(typeof password!=='string'||enc.encode(password).length>1024)return {status:400,headers:{},body:''};
   if(data.step.error==='error.user_not_found')this.call('mapi_enumeration_dummy_verify',{password});
   return this.maskedFailure(match[1],request.peer);
  }
  return result;
 }

}
export default {async fetch(request,env){
 const u=new URL(request.url),object=env.ENUMERATION_TEST.getByName('one');
 if(u.pathname==='/__setup'&&request.method==='POST'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`){const args=await request.json();return Response.json(await object.setup(args));}
 if(u.pathname==='/__evict'&&request.method==='POST'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`){try{await object.evict();}catch{}return new Response(null,{status:204});}
 if(u.pathname==='/__session'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`){const result=await object.session(request.headers.get('x-test-cookie')??'');return new Response(null,{status:result.status});}
 if(u.pathname==='/__counts'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`)return Response.json(await object.counts());
 if(u.pathname==='/__limits'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`)return Response.json(await object.limits());
 if(u.pathname==='/__seed-limits'&&request.method==='POST'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`){const a=await request.json();await object.seedLimits(a.ip,a.count);return new Response(null,{status:204});}
 if(u.pathname==='/__identity-ledger'&&request.method==='POST'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`){const a=await request.json();if(a.action==='seed')await object.seedIdentity(a.identifier,a.count);else if(a.action==='age')await object.ageIdentity(a.identifier);else if(a.action!=='read')return new Response(null,{status:400});return Response.json({count:await object.identityCount(a.identifier),keysAreDigests:await object.identityKeyShape()});}
 if(u.pathname==='/__expire-flow'&&request.method==='POST'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`){const a=await request.json();await object.expireFlow(a.flow);return new Response(null,{status:204});}
 const p=await object.identity();if(!p)return new Response(null,{status:503});
 if(u.pathname==='/zitadel-login.mjs')return env.ASSETS.fetch(request);
 if(u.pathname==='/login')return renderLogin(p);
 if(u.pathname.startsWith('/__nextgen/'))return handleFlowProxy(request,object,p,u.origin);
 return new Response(null,{status:404});
}};
