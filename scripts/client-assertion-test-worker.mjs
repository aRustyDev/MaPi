import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/client-assertion-test.wasm';
import baseline from '../worker/generated/baseline.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute,sqliteError } from '../worker/sql.js';
const encoder=new TextEncoder(),decoder=new TextDecoder(),rejected=Symbol('rollback');
export class ClientAssertionTest extends DurableObject {
 run(key){
  this.ctx.storage.transactionSync(()=>{for(const statement of baseline.statements)this.ctx.storage.sql.exec(statement);this.ctx.storage.sql.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY,schema_url TEXT NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)');this.ctx.storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)','https://issuer.example');});
  let reactor,memory,output,diagnostic='';
  reactor=instantiateReactor(wasm,getMemory=>{memory=getMemory;return{
   sql:(p,n)=>{const q=JSON.parse(decoder.decode(new Uint8Array(memory(),p,n)));let result;try{result=execute(this.ctx.storage,q);}catch(e){result={error:sqliteError(e)};}output=encoder.encode(JSON.stringify(result));return output.length;},
   result:(p,n)=>{new Uint8Array(memory(),p,n).set(output);output.fill(0);output=undefined;},
   transaction:()=>{try{this.ctx.storage.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rejected;});return 0;}catch(e){return e===rejected?1:2;}},
  };},bytes=>{if(diagnostic.length<2000)diagnostic+=decoder.decode(bytes);});
  const call=(name,input)=>{const bytes=encoder.encode(JSON.stringify(input)),p=reactor.mapi_alloc(bytes.length);new Uint8Array(memory(),p,bytes.length).set(bytes);bytes.fill(0);const packed=reactor[name](),ptr=Number(packed>>32n),n=Number(packed&0xffffffffn),value=JSON.parse(decoder.decode(new Uint8Array(memory(),ptr,n)));reactor.mapi_release();if(value?.error)throw Error(`${name}: ${value.error} ${diagnostic.slice(-300)}`);return value;};
  call('mapi_init',{id:'master-test',pem:key,projectId:''});const projectId=call('mapi_provision',{name:'Assertion test',origin:'https://issuer.example'}).projectId;
  const result=call('mapi_assertion_probe',{projectId,origin:'https://issuer.example'});
  if(!result.ok||result.algorithms!==3||result.auditedUses!==4)throw Error('assertion probe failed');
  const par=call('mapi_private_par_probe',{projectId,origin:'https://issuer.example'});
  if(!par.ok||par.auditEvents!==11)throw Error('composed PAR probe failed');
  return {...result,par:par.ok,memoryBytes:memory().byteLength};
 }
}
export default{async fetch(request,env){try{return Response.json(await env.ASSERTION_TEST.getByName('isolated').run((await request.json()).pem));}catch(error){return Response.json({ok:false,error:String(error)},{status:500});}}};
