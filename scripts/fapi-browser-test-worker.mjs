// Local-only browser harness. Never deployed or mounted in the application.
import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/fapi-browser-test.wasm';
import baseline from '../worker/generated/baseline.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
import { renderLogin } from '../worker/login-ui.js';
import { handleFlowProxy } from '../worker/flow-proxy.js';
const enc=new TextEncoder(),dec=new TextDecoder(),rejected=Symbol('rollback');
export class FAPIBrowserTest extends DurableObject {
 reactor;memory;project;origin;token;
 call(name,data){const bytes=enc.encode(JSON.stringify(data)),ptr=this.reactor.mapi_alloc(bytes.length);new Uint8Array(this.memory(),ptr,bytes.length).set(bytes);bytes.fill(0);const packed=this.reactor[name](),p=Number(packed>>32n),n=Number(packed&0xffffffffn),out=JSON.parse(dec.decode(new Uint8Array(this.memory(),p,n)));this.reactor.mapi_release();if(out?.error)throw Error(`${name}: ${out.error}`);return out;}
 setup(args){
  this.ctx.storage.transactionSync(()=>{for(const statement of baseline.statements)this.ctx.storage.sql.exec(statement);this.ctx.storage.sql.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY,schema_url TEXT NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)');this.ctx.storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)',args.origin);});
  this.origin=args.origin;this.boot();
  this.call('mapi_init',{id:'master-test',pem:atob(this.env.TEST_MASTER_KEY),projectId:''});this.project=this.call('mapi_provision',{name:'FAPI browser project',origin:args.origin}).projectId;
  this.call('mapi_init',{id:'master-test',pem:atob(this.env.TEST_MASTER_KEY),projectId:this.project});this.call('mapi_add_user',{projectId:this.project,email:args.email,password:args.password});this.token=this.call('mapi_project_token',{projectId:this.project}).token;
  const setup=this.call('mapi_fapi_browser_setup',{projectId:this.project,origin:this.origin,redirectURI:args.redirectURI,publicKey:args.publicKey,publicKey2:args.publicKey2});return {...setup,projectId:this.project};
 }
 boot(){
  let output,reactor;reactor=instantiateReactor(wasm,get=>{this.memory=get;return{sql:(p,n)=>{const q=JSON.parse(dec.decode(new Uint8Array(this.memory(),p,n)));let out;try{out=execute(this.ctx.storage,q);}catch(e){out={error:sqliteError(e)};}output=enc.encode(JSON.stringify(out));return output.length;},result:(p,n)=>{new Uint8Array(this.memory(),p,n).set(output);output.fill(0);output=undefined;},transaction:()=>{try{this.ctx.storage.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rejected;});return 0;}catch(e){return e===rejected?1:2;}}};});this.reactor=reactor;
 }
 ensure(){if(this.reactor)return;let row;try{row=this.ctx.storage.sql.exec('SELECT project_id FROM mapi_project').toArray()[0];}catch{return;}if(!row)return;this.project=row.project_id;this.origin=this.ctx.storage.sql.exec('SELECT origin FROM mapi_project_origin').one().origin;this.boot();this.call('mapi_init',{id:'master-test',pem:atob(this.env.TEST_MASTER_KEY),projectId:this.project});this.token=this.call('mapi_project_token',{projectId:this.project}).token;}
 identity(){this.ensure();return this.project;}
 evict(){this.ctx.abort("synthetic FAPI eviction");}
 flowRequest(request){this.ensure();if(new URL(request.url).pathname==='/api/v1/sessions/exchange')request.headers.authorization=[`Bearer ${this.token}`];return this.call('mapi_request',request);}
 fapi(request){this.ensure();return this.call('mapi_fapi_browser_request',{projectId:this.project,origin:this.origin,request});}
}
export default {async fetch(request,env){
 const u=new URL(request.url),object=env.FAPI_TEST.getByName('one');
 if(u.pathname==='/__setup'&&request.method==='POST'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`){const args=await request.json();return Response.json(await object.setup(args));}
 if(u.pathname==='/__evict'&&request.method==='POST'&&request.headers.get('authorization')===`Bearer ${env.TEST_AUTH}`){try{await object.evict();}catch{}return new Response(null,{status:204});}
 const p=await object.identity();if(!p)return new Response(null,{status:503});
 if(u.pathname==='/zitadel-login.mjs')return env.ASSETS.fetch(request);
 if(u.pathname==='/login'){const handle=u.searchParams.get('mapi_oauth');return renderLogin(p,handle||'');}
 if(u.pathname.startsWith('/__nextgen/'))return handleFlowProxy(request,object,p,u.origin);
 if(u.pathname.startsWith('/oauth/')){
  if(![ `/oauth/${p}/par`, `/oauth/${p}/authorize`, `/oauth/${p}/token`, `/oauth/${p}/jwks`, `/oauth/${p}/resource`, `/oauth/${p}/revoke`, `/oauth/${p}/.well-known/openid-configuration`, '/oauth/continue' ].includes(u.pathname))return new Response(null,{status:404});
  const body=new Uint8Array(await request.arrayBuffer());if(body.length>65536)return new Response(null,{status:413});
  const headers={};for(const [k,v] of request.headers)headers[k]=[v];
  const result=await object.fapi({method:request.method,url:request.url,headers,body:body.toBase64()});const out=new Headers();for(const [k,values] of Object.entries(result.headers))for(const v of values)out.append(k,v);
  return new Response(result.body?Uint8Array.fromBase64(result.body):null,{status:result.status,headers:out});
 }
 return new Response(null,{status:404});
}};
