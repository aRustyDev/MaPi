// Local-only experiment. This does not mount an authentication endpoint.
import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/upstream-split-test.wasm';
import fixture from '../worker/generated/fixture.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
import { installMutationGeneration, mutationGeneration, missingGenerationCoverage } from './mutation-generation.mjs';
import { verifySplit, SplitBusy, SplitStale, SplitUnavailable } from './password-split-protocol.mjs';
const enc=new TextEncoder(),dec=new TextDecoder(),rollback=Symbol('rollback');
const check=(v,message)=>{if(!v)throw Error(message);};
const rejects=async(promise,kind)=>{try{await promise;}catch(e){if(e instanceof kind)return;throw e;}throw Error(`expected ${kind.name}`);};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),release:()=>resolve()};};
export class UpstreamSplitTest extends DurableObject {
 async run({key,user}) {
  const s=this.ctx.storage,sql=s.sql;
  s.transactionSync(()=>{sql.exec('PRAGMA defer_foreign_keys=ON');for(const q of fixture.statements)sql.exec(q);sql.exec('CREATE TABLE split_jobs(project TEXT NOT NULL,attempt TEXT NOT NULL,challenge TEXT NOT NULL,job TEXT NOT NULL,lease_until INTEGER NOT NULL,PRIMARY KEY(project,attempt,challenge))');installMutationGeneration(s);});
  check(!missingGenerationCoverage(s).length,'initial schema uncovered');
  let reactor,memory,output;
  reactor=instantiateReactor(wasm,get=>{memory=get;return{
   sql:(p,n)=>{const q=JSON.parse(dec.decode(new Uint8Array(memory(),p,n)));let result;try{result=execute(s,q);}catch(e){result={error:sqliteError(e)};}output=enc.encode(JSON.stringify(result));return output.length;},
   result:(p,n)=>{new Uint8Array(memory(),p,n).set(output);output.fill(0);output=undefined;},
   transaction:()=>{try{s.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rollback;});return 0;}catch(e){return e===rollback?1:2;}},
  };});
  const call=(name,value)=>{const bytes=enc.encode(JSON.stringify(value)),p=reactor.mapi_alloc(bytes.length);new Uint8Array(memory(),p,bytes.length).set(bytes);bytes.fill(0);try{const packed=reactor[name](),ptr=Number(packed>>32n),len=Number(packed&0xffffffffn),result=JSON.parse(dec.decode(new Uint8Array(memory(),ptr,len)));if(result?.error)throw Error(`${name}: ${result.code??'failed'}`);return result;}finally{reactor.mapi_release();}};
  const project=fixture.projectId, origin='https://split.example';call('mapi_init',{...key,projectId:project});const token=call('mapi_project_token',{projectId:project}).token;
  function api(method,path,body,options={}) {const headers={accept:['application/json']};if(!options.noAuth)headers.authorization=[`Bearer ${token}`];if(options.cookie)headers.cookie=[options.cookie];if(body!==undefined)headers['content-type']=['application/json'];const r=call('mapi_request',{method,url:origin+path,headers,body:body===undefined?'':enc.encode(JSON.stringify(body)).toBase64(),peer:'127.0.0.1'});let data=null;if(r.body)data=JSON.parse(dec.decode(Uint8Array.fromBase64(r.body)));return {...r,data};}
  function ok(r){if(r.status<200||r.status>=300)throw Error(`upstream status ${r.status} code ${r.data?.code??''}`);return r.data;}
  function attempt(){const id=ok(api('POST','/auth_attempts',{project_id:project})).attempt_id;const path=`/auth_attempts/${id}/challenges`;const ident=ok(api('POST',path,{method:'identifier'})).challenge_id;ok(api('POST',`${path}/${ident}/verify`,{login_name:user.email}));const challenge=ok(api('POST',path,{method:'password'})).challenge_id;return {id,challenge,path};}
  const audit=(type)=>sql.exec('SELECT count(*) AS n FROM events WHERE project_id=? AND event_type=?',project,type).one().n;
  const row=(id)=>sql.exec('SELECT failure_count,last_verified_at FROM checks WHERE project_id=? AND id=?',project,id).toArray()[0];
  const load=(_project,id,challenge)=>{try{return {...call('mapi_split_prepare',{projectId:project,attemptId:id,challengeId:challenge}),epoch:mutationGeneration(s)};}catch{return null;}};
  const verify=async({password,hash,signal})=>{const response=await this.env.ARGON_VERIFIER.fetch('https://argon.internal/verify',{method:'POST',headers:{authorization:`Bearer ${this.env.ARGON_SPIKE_SECRET}`,'content-type':'application/json'},body:JSON.stringify({password,hash}),signal});if(!response.ok)throw Error('verifier unavailable');const result=await response.json();return {verified:result.verified,rehash:result.rehash};};
  function run(a,password,overrides={}) {let finish,finishError;
   const doFinish=(snapshot,verified)=>{try{const hash=overrides.corruptFinish?snapshot.hash+'x':snapshot.hash;const result=call('mapi_split_finish',{projectId:project,attemptId:a.id,challengeId:a.challenge,password,hash,verified});if(result.ok!==verified)throw Error('unexpected upstream outcome');finish=result;}catch(e){finishError=String(e);throw e;}};
   return verifySplit({storage:s,project,attempt:a.id,challenge:a.challenge,password,load,verify,success:snapshot=>doFinish(snapshot,true),failure:snapshot=>doFinish(snapshot,false),...overrides}).then(value=>{if(finishError||!finish)throw new SplitUnavailable();return {value,finish};});
  }
  // Wrong passwords commit the pinned failure counter and audit exactly once.
  let a=attempt(), before=audit('auth.check.failed');const wrong=await run(a,'Wrong-synthetic-password!');check(!wrong.value&&typeof wrong.finish?.code==='string',`wrong password response ${wrong.finishError??wrong.finish?.code??'missing'}`);check(row(a.challenge).failure_count===1&&audit('auth.check.failed')===before+1,'wrong password accounting');
  // A matching proof commits the upstream factor and audit, then issues a real session.
  const successBefore=audit('auth.check.succeeded');check((await run(a,user.password)).value,'correct password rejected');check(audit('auth.check.succeeded')===successBefore+1,'success audit missing');await rejects(run(a,user.password),SplitStale);
  const handoff=ok(api('POST',`/auth_attempts/${a.id}/handoff`)).handoff_token;const exchange=api('POST',`/sessions/exchange?project_id=${encodeURIComponent(project)}`,{handoff_token:handoff});const session=ok(exchange);check(session.session?.session_id,'session exchange failed');const cookie=(exchange.headers['Set-Cookie']??[])[0]?.split(';')[0];check(cookie,'session cookie missing');check(api('GET',`/sessions/me?project_id=${encodeURIComponent(project)}`,undefined,{noAuth:true,cookie}).status===200,'session read failed');
  // A successful factor cannot survive an audit failure; retry must work.
  a=attempt();sql.exec("CREATE TRIGGER split_fail_audit BEFORE INSERT ON events WHEN NEW.event_type='auth.check.succeeded' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");before=audit('auth.check.succeeded');let failed=false;try{await run(a,user.password);}catch{failed=true;}check(failed&&row(a.challenge).last_verified_at===null&&audit('auth.check.succeeded')===before,'success audit failure committed');sql.exec('DROP TRIGGER split_fail_audit');check((await run(a,user.password)).value,'success retry failed');
  // Upstream wrong-proof bookkeeping is best effort when audit fails.
  a=attempt();sql.exec("CREATE TRIGGER split_fail_audit BEFORE INSERT ON events WHEN NEW.event_type='auth.check.failed' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");before=audit('auth.check.failed');check(!(await run(a,'Wrong-synthetic-password!')).value,'failure became success');check(row(a.challenge).failure_count===0&&audit('auth.check.failed')===before,'failed audit persisted');sql.exec('DROP TRIGGER split_fail_audit');
  // Operational failures never become wrong passwords.
  a=attempt();before=audit('auth.check.failed');await rejects(run(a,user.password,{verify:async()=>{throw Error('unavailable');}}),SplitUnavailable);await rejects(run(a,user.password,{verify:async()=>({verified:'invalid'})}),SplitUnavailable);await rejects(run(a,user.password,{verify:async()=>({verified:true,rehash:'unsupported'})}),SplitUnavailable);await rejects(run(a,user.password,{leaseMs:5,verify:()=>new Promise(()=>{})}),SplitUnavailable);check(row(a.challenge).failure_count===0&&audit('auth.check.failed')===before,'unavailable verifier counted as failure');
  await rejects(run(a,'Wrong-synthetic-password!',{corruptFinish:true}),SplitUnavailable);check(row(a.challenge).failure_count===0&&audit('auth.check.failed')===before,'invalid oracle context counted as wrong password');
  a=attempt();before=audit('auth.check.failed');await rejects(run(a,user.password,{leaseMs:5}),SplitUnavailable);await new Promise(r=>setTimeout(r,1000));check(row(a.challenge).failure_count===0&&audit('auth.check.failed')===before,'timed-out private call counted as failure');
  const captured=load(project,a.id,a.challenge);sql.exec('UPDATE user_passwords SET encoded_hash=? WHERE project_id=? AND id=?','unsupported-hash',project,captured.credentialId);await rejects(run(a,user.password),SplitUnavailable);check(row(a.challenge).failure_count===0&&audit('auth.check.failed')===before,'unsupported hash counted as wrong password');sql.exec('UPDATE user_passwords SET encoded_hash=? WHERE project_id=? AND id=?',captured.hash,project,captured.credentialId);
  a=attempt();sql.exec('UPDATE projects SET password_hash_policy=? WHERE id=?',JSON.stringify({algorithm:'argon2id',params:{time:3,memory:65536,threads:4}}),project);await rejects(run(a,user.password),SplitStale);sql.exec('UPDATE projects SET password_hash_policy=NULL WHERE id=?',project);
  // Exactly one invocation reserves a challenge while its verifier is pending.
  a=attempt();let gate=deferred();const lockedHash=load(project,a.id,a.challenge).hash;let pending=run(a,user.password,{verify:async v=>{const result=await verify(v);await gate.promise;return result;}});const jobRows=JSON.stringify(sql.exec('SELECT * FROM split_jobs').toArray());check(!jobRows.includes(user.password)&&!jobRows.includes(lockedHash),'job persisted credential');await rejects(run(a,user.password),SplitBusy);gate.release();check((await pending).value,'reserved verifier failed');
  // A late result cannot finish or delete a newer reservation after lease expiry.
  a=attempt();let clock=Date.now(), oldGate=deferred(),newGate=deferred();const old=run(a,user.password,{now:()=>clock,verify:async v=>{const result=await verify(v);await oldGate.promise;return result;}});clock+=30001;const fresh=run(a,user.password,{now:()=>clock,verify:async v=>{const result=await verify(v);await newGate.promise;return result;}});oldGate.release();await rejects(old,SplitStale);check(sql.exec('SELECT count(*) AS n FROM split_jobs').one().n===1,'late job removed new reservation');newGate.release();check((await fresh).value,'replacement reservation failed');
  // Parent-session/step-up paths are deliberately unsupported by this spike.
  a=attempt();sql.exec('UPDATE auth_attempts SET session_id=? WHERE project_id=? AND id=?',session.session.session_id,project,a.id);await rejects(run(a,user.password),SplitStale);
  // Real upstream password, challenge, policy and session mutations fence a
  // trusted asynchronous result; a global generation also detects ABA.
  const races=[
   ['credential',()=>call('mapi_generation_probe',{projectId:project,userId:user.id,action:'password'})],
   ['challenge',()=>ok(api('POST',`/auth_attempts/${a.id}/challenges`,{method:'password'}))],
   ['policy',()=>call('mapi_generation_probe',{projectId:project,userId:user.id,action:'policy'})],
   ['deactivation',()=>call('mapi_generation_probe',{projectId:project,userId:user.id,action:'deactivate'}),()=>sql.exec("UPDATE users SET status='active' WHERE project_id=? AND id=?",project,user.id)],
   ['session',()=>{const r=api('DELETE',`/sessions/${session.session.session_id}`);check(r.status===204,'session revoke failed');}],
   ['ABA',()=>s.transactionSync(()=>{sql.exec("UPDATE users SET status='deactivated' WHERE project_id=? AND id=?",project,user.id);sql.exec("UPDATE users SET status='active' WHERE project_id=? AND id=?",project,user.id);})],
   ['hash ABA',()=>{const current=load(project,a.id,a.challenge);s.transactionSync(()=>{sql.exec('UPDATE user_passwords SET encoded_hash=? WHERE project_id=? AND id=?','temporary-hash',project,current.credentialId);sql.exec('UPDATE user_passwords SET encoded_hash=? WHERE project_id=? AND id=?',current.hash,project,current.credentialId);});}],
   ['hasher policy ABA',()=>s.transactionSync(()=>{sql.exec('UPDATE projects SET password_hash_policy=? WHERE id=?',JSON.stringify({algorithm:'argon2id',params:{time:3,memory:65536,threads:4}}),project);sql.exec('UPDATE projects SET password_hash_policy=NULL WHERE id=?',project);})],
  ];
  for(const [name,mutate,cleanup] of races){a=attempt();before=audit('auth.check.succeeded');gate=deferred();pending=run(a,user.password,{verify:async v=>{const result=await verify(v);await gate.promise;return result;}});mutate();gate.release();await rejects(pending,SplitStale);check(audit('auth.check.succeeded')===before,`${name} unexpected audit`);cleanup?.();}
  check(api('GET',`/sessions/me?project_id=${encodeURIComponent(project)}`,undefined,{noAuth:true,cookie}).status===401,'revoked session remained valid');
  // Expiration must be rechecked even when no SQL write advances generation.
  a=attempt();sql.exec('UPDATE auth_attempts SET time_to_live=4000000000 WHERE project_id=? AND id=?',project,a.id);gate=deferred();const beforeExpiry=mutationGeneration(s);pending=run(a,user.password,{verify:async v=>{const result=await verify(v);await gate.promise;return result;}});await new Promise(r=>setTimeout(r,4200));check(mutationGeneration(s)===beforeExpiry,'unexpected expiry mutation');gate.release();await rejects(pending,SplitStale);
  check(sql.exec('SELECT count(*) AS n FROM split_jobs').one().n===0,'orphan job');
  return {ok:true,wrongCode:wrong.finish.code,wasmBytes:memory().byteLength,checks:'upstream success/failure and audit, real verifier, replay, rollback, expiry, concurrent reservation, mutation races'};
 }
}
export default{async fetch(request,env){if(env.MAPI_LOCAL_TEST!=='1'||!['127.0.0.1','localhost'].includes(new URL(request.url).hostname)||request.method!=='POST')return new Response(null,{status:404});try{return Response.json(await env.SPLIT.getByName('synthetic').run(await request.json()));}catch(error){return Response.json({ok:false,error:String(error)},{status:500});}}};
