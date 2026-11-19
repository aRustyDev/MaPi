import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/mutation-generation-test.wasm';
import {installMutationGeneration,mutationGeneration,missingGenerationCoverage} from './mutation-generation.mjs';
import baseline from '../worker/generated/baseline.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
const encoder=new TextEncoder(),decoder=new TextDecoder(),rejected=Symbol('rollback');
export class MutationGenerationTest extends DurableObject {
 async run(key){
  const started=Date.now();
  this.ctx.storage.transactionSync(()=>{for(const statement of baseline.statements)this.ctx.storage.sql.exec(statement);this.ctx.storage.sql.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY,schema_url TEXT NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)');this.ctx.storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)','https://issuer.example');});
  let protectedTables;this.ctx.storage.transactionSync(()=>{protectedTables=installMutationGeneration(this.ctx.storage);});
  for(const name of ['projects','users','user_passwords','auth_attempts','checks','sessions','events'])if(!protectedTables.includes(name))throw Error(`missing trigger table ${name}`);
  const trace=(table)=>this.ctx.storage.sql.exec('SELECT changes FROM mapi_mutation_trace WHERE table_name=?',table).one().changes;
  if(missingGenerationCoverage(this.ctx.storage).length)throw Error('initial trigger coverage missing');
  const generation=()=>mutationGeneration(this.ctx.storage), changed=(before,label)=>{const after=generation();if(BigInt(after)<=BigInt(before))throw Error(`generation failed to advance on ${label}`);return after;};
  async function fenced(label,action,table){const before=generation(),writes=table?trace(table):0;let release;const gate=new Promise(r=>release=r);const pending=(async()=>{await gate;return generation()===before;})();const result=action();changed(before,label);release();if(await pending)throw Error(`${label} failed to fence a pending verifier`);if(table&&trace(table)<=writes)throw Error(`${label} did not touch ${table}`);return result;}
  let reactor,memory,output,diagnostic='';
  reactor=instantiateReactor(wasm,getMemory=>{memory=getMemory;return{
   sql:(p,n)=>{const q=JSON.parse(decoder.decode(new Uint8Array(memory(),p,n)));let result;try{result=execute(this.ctx.storage,q);}catch(e){result={error:sqliteError(e)};}output=encoder.encode(JSON.stringify(result));return output.length;},
   result:(p,n)=>{new Uint8Array(memory(),p,n).set(output);output.fill(0);output=undefined;},
   transaction:()=>{try{this.ctx.storage.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rejected;});return 0;}catch(e){return e===rejected?1:2;}},
  };},bytes=>{if(diagnostic.length<4000)diagnostic+=decoder.decode(bytes);});
  const call=(name,input)=>{const bytes=encoder.encode(JSON.stringify(input)),p=reactor.mapi_alloc(bytes.length);new Uint8Array(memory(),p,bytes.length).set(bytes);bytes.fill(0);const packed=reactor[name](),ptr=Number(packed>>32n),n=Number(packed&0xffffffffn),value=JSON.parse(decoder.decode(new Uint8Array(memory(),ptr,n)));reactor.mapi_release();if(value?.error)throw Error(`${name}: ${value.error} ${diagnostic.slice(-300)}`);return value;};
  const origin='https://issuer.example';
  call('mapi_init',{id:'master-test',pem:key,projectId:''});
  let gen=generation();const project=call('mapi_provision',{name:'FAPI application test',origin}).projectId;gen=changed(gen,'upstream provision');
  call('mapi_init',{id:'master-test',pem:key,projectId:project});
  const email='fapi-synthetic@example.test',password='Test-Passphrase-49!';
  let gateResolve;const gate=new Promise(r=>gateResolve=r), snapshot=gen;const pending=(async()=>{await gate;return generation()===snapshot;})();
  call('mapi_add_user',{projectId:project,email,password});gen=changed(gen,'upstream user creation');gateResolve();if(await pending)throw Error('real user creation failed to fence async snapshot');
  const projectToken=call('mapi_project_token',{projectId:project}).token;
  let flowCookie='';
  function upstream(method,path,body,projectAuth=false){
   const headers={accept:['application/json']};if(projectAuth)headers.authorization=[`Bearer ${projectToken}`];if(flowCookie)headers.cookie=[flowCookie];if(body!==undefined)headers['content-type']=['application/json'];
   const r=call('mapi_request',{method,url:origin+path,headers,body:body===undefined?'':encoder.encode(JSON.stringify(body)).toBase64(),peer:'127.0.0.1'});
   const text=decoder.decode(Uint8Array.fromBase64(r.body));if(r.status<200||r.status>=300)throw Error(`upstream ${method} ${path.split('?')[0]} returned ${r.status}: ${text.slice(0,200)}`);
   const updated=(r.headers['Set-Cookie']??[]).find(v=>v.startsWith('_zflow='));if(updated)flowCookie=updated.split(';')[0];
   return {...r,data:text?JSON.parse(text):null};
  }
  let flow=(await fenced('upstream flow start',()=>upstream('POST','/flows',{project_id:project,purpose:'login'}),'auth_attempts')).data;gen=generation();
  for(let hop=0;hop<6&&!flow.handoff_token;hop++){
   const fields={};for(const field of flow.step.fields??[]){const name=field.name.split(/[#/.]/).at(-1).toLowerCase();if(name==='email')fields[field.name]=email;else if(name==='password')fields[field.name]=password;else throw Error(`unknown login field ${name}`);}
   flow=(await fenced('upstream challenge submit',()=>upstream('POST',`/flows/${encodeURIComponent(flow.id)}/submit`,{action:'submit',fields,...(flow.session_token?{session_token:flow.session_token}:{})}),'checks')).data;gen=generation();
  }
  if(!flow.handoff_token)throw Error('password flow missing handoff');
  const session=await fenced('upstream session exchange',()=>upstream('POST',`/sessions/exchange?project_id=${encodeURIComponent(project)}`,{handoff_token:flow.handoff_token},true),'sessions');
  gen=generation();
  const cookie=session.headers['Set-Cookie']?.[0]?.split(';')[0];if(!cookie||!cookie.includes('='))throw Error('missing upstream session cookie');
  const credential=decodeURIComponent(cookie.slice(cookie.indexOf('=')+1));
  const sessionsBefore=trace('sessions');
  const result=await fenced('upstream session deletion',()=>call('mapi_fapi_app_probe',{projectId:project,origin,sessionCredential:credential,userId:session.data.session.user_id,sessionId:session.data.session.session_id}),'sessions');
  if(!result.ok||result.tokenType!=='DPoP')throw Error('private FAPI journey failed');gen=changed(gen,'upstream session deletion');if(trace('sessions')<=sessionsBefore)throw Error('session deletion did not bump generation');
  if(!missingGenerationCoverage(this.ctx.storage).some(v=>v.startsWith('mapi_fapi_')))throw Error('new schema escaped coverage detection');
  this.ctx.storage.transactionSync(()=>{installMutationGeneration(this.ctx.storage);});if(missingGenerationCoverage(this.ctx.storage).length)throw Error('schema re-instrumentation failed');
  const initial=gen;try{this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("UPDATE users SET status='inactive' WHERE project_id=?",project);throw Error('rollback');});}catch(e){if(e.message!=='rollback')throw e;}if(generation()!==initial)throw Error('rolled-back mutation advanced generation');
  const userId=session.data.session.user_id, credentialWrites=trace('user_passwords');
  const beforePassword=gen;let resume;const waitPassword=new Promise(r=>resume=r);const asyncSnapshot=(async()=>{await waitPassword;return generation()===beforePassword;})();
  call('mapi_generation_probe',{projectId:project,userId,action:'password'});gen=changed(gen,'upstream password replacement');resume();if(await asyncSnapshot||trace('user_passwords')<=credentialWrites)throw Error('password change failed to fence async verification');
  const userWrites=trace('users');call('mapi_generation_probe',{projectId:project,userId,action:'deactivate'});gen=changed(gen,'upstream deactivation');if(trace('users')<=userWrites)throw Error('upstream deactivation not covered');
  this.ctx.storage.sql.exec("UPDATE users SET status='active' WHERE project_id=? AND id=?",project,userId);gen=changed(gen,'test reactivation');
  await fenced('upstream policy publish',()=>call('mapi_generation_probe',{projectId:project,userId,action:'policy'}),'policy_revisions');gen=generation();
  const old=gen;this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("UPDATE users SET status='inactive' WHERE project_id=?",project);this.ctx.storage.sql.exec("UPDATE users SET status='active' WHERE project_id=?",project);});gen=changed(old,'user ABA');
  if(this.ctx.storage.sql.exec("SELECT status FROM users WHERE project_id=? AND id=?",project,session.data.session.user_id).one().status!=='active')throw Error('ABA fixture changed');
  this.ctx.storage.sql.exec('UPDATE mapi_mutation_generation SET counter=9223372036854775807 WHERE singleton=1');if(generation()!=='9223372036854775807')throw Error('int64 generation rounded');
  let exhausted=false;try{this.ctx.storage.sql.exec("UPDATE users SET status='inactive' WHERE project_id=? AND id=?",project,userId);}catch{exhausted=true;}if(!exhausted||this.ctx.storage.sql.exec('SELECT status FROM users WHERE project_id=? AND id=?',project,userId).one().status!=='active')throw Error('generation overflow did not abort mutation');
  return {ok:true,protectedTables:protectedTables.length,memoryBytes:memory().byteLength,elapsedMs:Date.now()-started};
 }
}
export default{async fetch(request,env){try{return Response.json(await env.GEN_TEST.getByName('isolated').run((await request.json()).pem));}catch(error){return Response.json({ok:false,error:String(error)},{status:500});}}};
