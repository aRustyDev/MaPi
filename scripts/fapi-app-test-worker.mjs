import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/fapi-app-test.wasm';
import baseline from '../worker/generated/baseline.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
const encoder=new TextEncoder(),decoder=new TextDecoder(),rejected=Symbol('rollback');
export class FAPIAppTest extends DurableObject {
 run(key){
  const started=Date.now();
  this.ctx.storage.transactionSync(()=>{for(const statement of baseline.statements)this.ctx.storage.sql.exec(statement);this.ctx.storage.sql.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY,schema_url TEXT NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)');this.ctx.storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)','https://issuer.example');});
  let reactor,memory,output,diagnostic='';
  reactor=instantiateReactor(wasm,getMemory=>{memory=getMemory;return{
   sql:(p,n)=>{const q=JSON.parse(decoder.decode(new Uint8Array(memory(),p,n)));let result;try{result=execute(this.ctx.storage,q);}catch(e){result={error:sqliteError(e)};}output=encoder.encode(JSON.stringify(result));return output.length;},
   result:(p,n)=>{new Uint8Array(memory(),p,n).set(output);output.fill(0);output=undefined;},
   transaction:()=>{try{this.ctx.storage.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rejected;});return 0;}catch(e){return e===rejected?1:2;}},
  };},bytes=>{if(diagnostic.length<4000)diagnostic+=decoder.decode(bytes);});
  const call=(name,input)=>{const bytes=encoder.encode(JSON.stringify(input)),p=reactor.mapi_alloc(bytes.length);new Uint8Array(memory(),p,bytes.length).set(bytes);bytes.fill(0);const packed=reactor[name](),ptr=Number(packed>>32n),n=Number(packed&0xffffffffn),value=JSON.parse(decoder.decode(new Uint8Array(memory(),ptr,n)));reactor.mapi_release();if(value?.error)throw Error(`${name}: ${value.error} ${diagnostic.slice(-300)}`);return value;};
  const origin='https://issuer.example';
  call('mapi_init',{id:'master-test',pem:key,projectId:''});
  const project=call('mapi_provision',{name:'FAPI application test',origin}).projectId;
  call('mapi_init',{id:'master-test',pem:key,projectId:project});
  const email='fapi-synthetic@example.test',password='Test-Passphrase-49!';
  call('mapi_add_user',{projectId:project,email,password});
  const projectToken=call('mapi_project_token',{projectId:project}).token;
  let flowCookie='';
  function upstream(method,path,body,projectAuth=false){
   const headers={accept:['application/json']};if(projectAuth)headers.authorization=[`Bearer ${projectToken}`];if(flowCookie)headers.cookie=[flowCookie];if(body!==undefined)headers['content-type']=['application/json'];
   const r=call('mapi_request',{method,url:origin+path,headers,body:body===undefined?'':encoder.encode(JSON.stringify(body)).toBase64(),peer:'127.0.0.1'});
   const text=decoder.decode(Uint8Array.fromBase64(r.body));if(r.status<200||r.status>=300)throw Error(`upstream ${method} ${path.split('?')[0]} returned ${r.status}: ${text.slice(0,200)}`);
   const updated=(r.headers['Set-Cookie']??[]).find(v=>v.startsWith('_zflow='));if(updated)flowCookie=updated.split(';')[0];
   return {...r,data:text?JSON.parse(text):null};
  }
  let flow=upstream('POST','/flows',{project_id:project,purpose:'login'}).data;
  for(let hop=0;hop<6&&!flow.handoff_token;hop++){
   const fields={};for(const field of flow.step.fields??[]){const name=field.name.split(/[#/.]/).at(-1).toLowerCase();if(name==='email')fields[field.name]=email;else if(name==='password')fields[field.name]=password;else throw Error(`unknown login field ${name}`);}
   flow=upstream('POST',`/flows/${encodeURIComponent(flow.id)}/submit`,{action:'submit',fields,...(flow.session_token?{session_token:flow.session_token}:{})}).data;
  }
  if(!flow.handoff_token)throw Error('password flow missing handoff');
  const session=upstream('POST',`/sessions/exchange?project_id=${encodeURIComponent(project)}`,{handoff_token:flow.handoff_token},true);
  const cookie=session.headers['Set-Cookie']?.[0]?.split(';')[0];if(!cookie||!cookie.includes('='))throw Error('missing upstream session cookie');
  const credential=decodeURIComponent(cookie.slice(cookie.indexOf('=')+1));
  const reload=call('mapi_fapi_reload_probe',{projectId:project,origin,sessionCredential:credential});if(!reload.ok)throw Error('private FAPI reload probe failed');
  const result=call('mapi_fapi_app_probe',{projectId:project,origin,sessionCredential:credential,userId:session.data.session.user_id,sessionId:session.data.session.session_id});
  if(!result.ok||result.tokenType!=='DPoP')throw Error('private FAPI journey failed');
  return {ok:true,memoryBytes:memory().byteLength,elapsedMs:Date.now()-started};
 }
}
export default{async fetch(request,env){try{return Response.json(await env.FAPI_TEST.getByName('isolated').run((await request.json()).pem));}catch(error){return Response.json({ok:false,error:String(error)},{status:500});}}};
