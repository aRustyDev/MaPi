import { DurableObject } from 'cloudflare:workers';
import { verifySplitUnsafeForTest as verifySplit, SplitBusy, SplitStale, SplitUnavailable } from './password-split-protocol.mjs';

export class PasswordSplitTest extends DurableObject {
 async run(){
  const s=this.ctx.storage, sql=s.sql;let clock=1000, failAudit=false, calls=0;
  s.transactionSync(()=>{
   sql.exec('CREATE TABLE split_jobs(project TEXT NOT NULL,attempt TEXT NOT NULL,challenge TEXT NOT NULL,job TEXT NOT NULL,lease_until INTEGER NOT NULL,PRIMARY KEY(project,attempt,challenge))');
   sql.exec('CREATE TABLE fixture(project TEXT,attempt TEXT,challenge TEXT,epoch TEXT,hash TEXT,credential_id TEXT,user_id TEXT,user_active INTEGER,session_id TEXT,session_active INTEGER,challenge_open INTEGER,expires_at INTEGER,handed_off INTEGER,factor INTEGER,failures INTEGER)');
   sql.exec('CREATE TABLE audit(kind TEXT)');
  });
  const reset=()=>s.transactionSync(()=>{sql.exec('DELETE FROM split_jobs');sql.exec('DELETE FROM fixture');sql.exec('DELETE FROM audit');sql.exec("INSERT INTO fixture VALUES('p','a','c','1','hash-v1','cred-1','user-1',1,'session-1',1,1,2000,0,0,0)");});
  const load=(project,attempt,challenge)=>{
   const x=sql.exec('SELECT * FROM fixture WHERE project=? AND attempt=? AND challenge=?',project,attempt,challenge).toArray()[0];if(!x||x.handed_off)return null;
   return {epoch:x.epoch,hash:x.hash,credentialId:x.credential_id,userId:x.user_id,sessionId:x.session_id,userActive:x.user_active===1,parentSessionActive:x.session_active===1,challengeOpen:x.challenge_open===1,expiresAt:x.expires_at};
  };
  const audit=(kind)=>{sql.exec('INSERT INTO audit VALUES(?)',kind);if(failAudit)throw Error('injected audit failure');};
  const success=()=>{sql.exec('UPDATE fixture SET factor=1,challenge_open=0');audit('succeeded');};
  const failure=()=>{sql.exec('UPDATE fixture SET failures=failures+1');audit('failed');};
  const args={storage:s,load,success,failure,project:'p',attempt:'a',challenge:'c',password:'synthetic',now:()=>clock,leaseMs:1000};
  const run=verify=>verifySplit({...args,verify});
  const row=()=>sql.exec('SELECT * FROM fixture').toArray()[0];
  const count=(table)=>sql.exec(`SELECT count(*) AS n FROM ${table}`).toArray()[0].n;
  const expect=async(promise,cls)=>{try{await promise;}catch(e){if(e instanceof cls)return;throw e;}throw Error(`expected ${cls.name}`);};
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
  reset();if(await run(async()=>({verified:true}))!==true||row().factor!==1||count('audit')!==1||count('split_jobs')!==0)throw Error('successful commit');
  await expect(run(async()=>({verified:true})),SplitStale);
  reset();if(await run(async()=>({verified:false}))!==false||row().factor!==0||row().failures!==1||count('audit')!==1)throw Error('failure commit');
  reset();failAudit=true;if(await run(async()=>({verified:false}))!==false)throw Error('audit failure changed rejection');failAudit=false;if(row().failures!==0||count('audit')!==0||count('split_jobs')!==0)throw Error('failed audit not rolled back');
  reset();failAudit=true;try{await run(async()=>({verified:true}));throw Error('success audit failure accepted');}catch(e){if(e.message!=='injected audit failure')throw e;}failAudit=false;if(row().factor!==0||count('audit')!==0||count('split_jobs')!==0)throw Error('successful factor survived failed audit');if(!await run(async()=>({verified:true})))throw Error('success audit retry failed');
  reset();await expect(run(async()=>{throw Error('verifier unavailable');}),SplitUnavailable);if(row().failures!==0||count('audit')!==0||count('split_jobs')!==0)throw Error('verifier failure counted');
  reset();await expect(run(async()=>({verified:'yes'})),SplitUnavailable);if(row().factor!==0||count('audit')!==0)throw Error('malformed verifier result accepted');
  reset();await expect(run(async()=>({verified:true,rehash:'unimplemented'})),SplitUnavailable);if(row().factor!==0||count('audit')!==0)throw Error('unsafe rehash accepted');
  reset();let releaseSlow;const slow=new Promise(r=>releaseSlow=r);await expect(verifySplit({...args,leaseMs:5,verify:()=>slow}),SplitUnavailable);releaseSlow({verified:true});await new Promise(r=>setTimeout(r,10));if(row().factor!==0||count('audit')!==0||count('split_jobs')!==0)throw Error('late verification committed');
  // Mutations occur while the verify promise is suspended, as in DO reentry.
  for(const [name,mutation] of [
   ['credential changed',"UPDATE fixture SET credential_id='cred-2',hash='hash-v2',epoch='2'"],
   ['hash ABA',"UPDATE fixture SET epoch='3'"],
   ['challenge replaced',"UPDATE fixture SET challenge='c2',epoch='2'"],
   ['challenge consumed',"UPDATE fixture SET challenge_open=0,epoch='2'"],
   ['attempt handed off',"UPDATE fixture SET handed_off=1,epoch='2'"],
   ['user deactivated',"UPDATE fixture SET user_active=0,epoch='2'"],
   ['session revoked',"UPDATE fixture SET session_active=0,epoch='2'"],
   ['policy changed',"UPDATE fixture SET epoch='2'"],
  ]){
   reset();const gate=deferred(),pending=run(()=>{calls++;return gate.promise;});s.transactionSync(()=>sql.exec(mutation));gate.resolve({verified:true});await expect(pending,SplitStale);if(row().factor!==0||count('audit')!==0||count('split_jobs')!==0)throw Error(`${name} changed result`);
  }
  reset();const first=deferred(),pending=run(()=>first.promise);await expect(run(async()=>({verified:true})),SplitBusy);first.resolve({verified:true});if(!await pending||count('audit')!==1)throw Error('concurrent exchange');
  reset();const expiry=deferred(),expired=run(()=>expiry.promise);clock=2000;expiry.resolve({verified:true});await expect(expired,SplitStale);clock=1000;
  // Counterexample only: the protocol observes a frozen clock throughout the
  // last transaction while an independent test oracle advances past expiry
  // immediately before the success mutation. This models a possible elapsed
  // interval; the oracle is not an actual workerd wall-clock measurement.
  reset();let oracle=1000;
  const late=await verifySplit({...args,verify:async()=>({verified:true}),success:()=>{
   if(clock!==1000||oracle!==1000)throw Error('invalid frozen-clock fixture');
   oracle=2001;success();
  }});
  if(!late||oracle<=row().expires_at||clock>=row().expires_at||row().factor!==1||count('audit')!==1||count('split_jobs')!==0)throw Error('frozen-clock counterexample changed');
  await expect(run(async()=>({verified:true})),SplitStale);
  if(row().factor!==1||count('audit')!==1||count('split_jobs')!==0)throw Error('late proof replay changed state');
  reset();const old=deferred(),oldJob=run(()=>old.promise);clock=2000;await expect(run(async()=>({verified:true})),SplitStale);clock=1000;old.resolve({verified:true});await oldJob;
  reset();const lost=deferred(),firstLease=run(()=>lost.promise);clock=2000;sql.exec('UPDATE fixture SET expires_at=4000');const fresh=deferred(),second=run(()=>fresh.promise);lost.resolve({verified:true});await expect(firstLease,SplitStale);if(count('split_jobs')!==1)throw Error('old job removed newer lease');fresh.resolve({verified:true});if(!await second)throw Error('expired lease retry');clock=1000;
  return {ok:true,races:calls,frozenClockCounterexample:true};
 }
}
export default{async fetch(_request,env){try{return Response.json(await env.SPLIT.getByName('isolated').run());}catch(error){return Response.json({ok:false,error:String(error)},{status:500});}}};
