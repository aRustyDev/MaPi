import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/key-rotation-test.wasm';
import baseline from '../worker/generated/baseline.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
const encoder=new TextEncoder(),decoder=new TextDecoder(),rejected=Symbol('rollback');
export class KeyRotationTest extends DurableObject {
 reactor() {
  let reactor,memory,output,diagnostic='';
  reactor=instantiateReactor(wasm,getMemory=>{memory=getMemory;return{
   sql:(p,n)=>{const q=JSON.parse(decoder.decode(new Uint8Array(memory(),p,n)));let result;try{result=execute(this.ctx.storage,q);}catch(e){result={error:sqliteError(e)};}output=encoder.encode(JSON.stringify(result));return output.length;},
   result:(p,n)=>{new Uint8Array(memory(),p,n).set(output);output.fill(0);output=undefined;},
   transaction:()=>{try{this.ctx.storage.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rejected;});return 0;}catch(e){return e===rejected?1:2;}},
  };},bytes=>{if(diagnostic.length<4000)diagnostic+=decoder.decode(bytes);});
  return {memory,call:(name,input)=>{const bytes=encoder.encode(JSON.stringify(input)),p=reactor.mapi_alloc(bytes.length);new Uint8Array(memory(),p,bytes.length).set(bytes);bytes.fill(0);const packed=reactor[name](),ptr=Number(packed>>32n),n=Number(packed&0xffffffffn),value=JSON.parse(decoder.decode(new Uint8Array(memory(),ptr,n)));reactor.mapi_release();if(value?.error)throw Error(`${name}: ${value.error} ${diagnostic.slice(-300)}`);return value;}};
 }
 async run(key,name){
  const origin=`https://${name}.example`;
  this.ctx.storage.transactionSync(()=>{for(const statement of baseline.statements)this.ctx.storage.sql.exec(statement);this.ctx.storage.sql.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY,schema_url TEXT NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)');this.ctx.storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)',origin);});
  const {call}=this.reactor();call('mapi_init',{id:'master-test',pem:key,projectId:''});const project=call('mapi_provision',{name:'Rotation test '+name,origin}).projectId;call('mapi_init',{id:'master-test',pem:key,projectId:project});
  const email=`${name}@example.test`,password='Key-rotation-fixture-49!';call('mapi_add_user',{projectId:project,email,password});const token=call('mapi_project_token',{projectId:project}).token;let flowCookie='';
  const upstream=(method,path,body,auth=false)=>{const headers={accept:['application/json']};if(auth)headers.authorization=[`Bearer ${token}`];if(flowCookie)headers.cookie=[flowCookie];if(body!==undefined)headers['content-type']=['application/json'];const r=call('mapi_request',{method,url:origin+path,headers,body:body===undefined?'':encoder.encode(JSON.stringify(body)).toBase64(),peer:'127.0.0.1'});if(r.status<200||r.status>=300)throw Error(`upstream ${method} ${path.split('?')[0]} returned ${r.status}`);const updated=(r.headers['Set-Cookie']??[]).find(v=>v.startsWith('_zflow='));if(updated)flowCookie=updated.split(';')[0];const text=decoder.decode(Uint8Array.fromBase64(r.body));return {...r,data:text?JSON.parse(text):null};};
  let flow=upstream('POST','/flows',{project_id:project,purpose:'login'}).data;
  for(let hop=0;hop<6&&!flow.handoff_token;hop++){const fields={};for(const field of flow.step.fields??[]){const n=field.name.split(/[#/.]/).at(-1).toLowerCase();if(n==='email')fields[field.name]=email;else if(n==='password')fields[field.name]=password;else throw Error('unexpected login field');}flow=upstream('POST',`/flows/${encodeURIComponent(flow.id)}/submit`,{action:'submit',fields,...(flow.session_token?{session_token:flow.session_token}:{})}).data;}
  if(!flow.handoff_token)throw Error('password flow missing handoff');const session=upstream('POST',`/sessions/exchange?project_id=${encodeURIComponent(project)}`,{handoff_token:flow.handoff_token},true);
  const result=call('mapi_key_rotation_probe',{projectId:project,origin,userId:session.data.session.user_id,sessionId:session.data.session.session_id});if(!result.ok)throw Error('rotation probe failed');return {...result,origin};
 }
 verify(key,own,foreign){const {call}=this.reactor();call('mapi_init',{id:'master-test',pem:key,projectId:own.projectId});return call('mapi_key_rotation_probe',{projectId:own.projectId,origin:own.origin,ownBearer:own.bearer,foreignBearer:foreign.bearer,ownFAPIID:own.fapiID,ownFAPIAccess:own.fapiAccess,ownFAPIClient:own.fapiClient,foreignFAPIID:foreign.fapiID,foreignFAPIAccess:foreign.fapiAccess,foreignFAPIClient:foreign.fapiClient});}
 evict(){this.ctx.abort('key rotation eviction test');}
}
export default {async fetch(request,env){try{const {pem}=await request.json();let a=env.KEY_TEST.getByName('a'),b=env.KEY_TEST.getByName('b');const own=await a.run(pem,'a'),foreign=await b.run(pem,'b');if(!a.verify||!(await a.verify(pem,own,foreign)).ok||!(await b.verify(pem,foreign,own)).ok)throw Error('cross-project validation failed');await Promise.allSettled([a.evict(),b.evict()]);a=env.KEY_TEST.getByName('a');b=env.KEY_TEST.getByName('b');if(!(await a.verify(pem,own,foreign)).ok||!(await b.verify(pem,foreign,own)).ok)throw Error('key state lost after eviction');return Response.json({ok:true});}catch(error){return Response.json({ok:false,error:String(error)},{status:500});}}};
