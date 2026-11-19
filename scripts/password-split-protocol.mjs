// Isolated experiment: the caller must supply an authoritative synchronous
// snapshot and mutation callbacks tied to the SAME DO SQLite transaction.
// No handler or verifier service is mounted by this module.
export class SplitUnavailable extends Error {}
export class SplitStale extends Error {}
export class SplitBusy extends Error {}
class FailureWriteError extends Error {}

function current(a,b,now) {
 // Snapshot fields and revision are server-owned, never returned by a verifier.
 // Serialize only an explicitly constructed plain object, never the password.
 return JSON.stringify(a)===JSON.stringify(b) && Number.isSafeInteger(b.expiresAt) && now < b.expiresAt && b.challengeOpen===true && b.userActive===true && b.parentSessionActive===true;
}

// One active verification per challenge. Epoch must advance atomically for
// *every* mutation that can invalidate any snapshot field, including change and
// restore ABA; no such universal epoch currently exists in production MaPi.
export async function verifySplit({storage, load, success, failure, verify, project, attempt, challenge, password, now=()=>Date.now(), leaseMs=30_000}) {
 if(typeof password!=='string'||password.length===0||password.length>4096||typeof verify!=='function'||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>30_000)throw new SplitUnavailable();
 const job=crypto.randomUUID(), started=now();
 let snapshot;
 storage.transactionSync(()=>{
  snapshot=load(project,attempt,challenge);
  if(!snapshot||!current(snapshot,snapshot,started)||!snapshot.hash||!snapshot.epoch)throw new SplitStale();
  storage.sql.exec('DELETE FROM split_jobs WHERE project=? AND attempt=? AND challenge=? AND lease_until<=?',project,attempt,challenge,started);
  const rows=storage.sql.exec('INSERT INTO split_jobs(project,attempt,challenge,job,lease_until) VALUES(?,?,?,?,?) ON CONFLICT(project,attempt,challenge) DO NOTHING RETURNING job',project,attempt,challenge,job,started+leaseMs).toArray();
  if(rows.length!==1)throw new SplitBusy();
 });
 const release=()=>storage.transactionSync(()=>{storage.sql.exec('DELETE FROM split_jobs WHERE project=? AND attempt=? AND challenge=? AND job=?',project,attempt,challenge,job);});
 let result, timer;
 const controller=new AbortController();
 try {
  // The live credential hash and plaintext never enter durable job rows.
  // The returned boolean is accepted only from the private call controlled by
  // this closure; it is not a client-submittable or portable assertion.
  result=await Promise.race([verify({password,hash:snapshot.hash,signal:controller.signal}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new SplitUnavailable());},leaseMs);})]);
  if(!result||typeof result.verified!=='boolean'||(result.rehash!==undefined&&result.rehash!==''))throw new SplitUnavailable();
 } catch {release();throw new SplitUnavailable();} finally {clearTimeout(timer);}
 try {
  return storage.transactionSync(()=>{
   const live=storage.sql.exec('SELECT job,lease_until FROM split_jobs WHERE project=? AND attempt=? AND challenge=?',project,attempt,challenge).toArray()[0];
   const next=load(project,attempt,challenge), timestamp=now();
   if(!live||live.job!==job||timestamp>=live.lease_until||!next||!current(snapshot,next,timestamp))throw new SplitStale();
   // The callback performs the product mutation and its audit in this same
   // transaction. It must use the upstream Go domain and tagged SQL adapters.
   if(result.verified)success(next);else {try{failure(next);}catch{throw new FailureWriteError();}}
   storage.sql.exec('DELETE FROM split_jobs WHERE project=? AND attempt=? AND challenge=? AND job=?',project,attempt,challenge,job);
   return result.verified;
  });
 } catch(err) {release();if(err instanceof FailureWriteError)return false;throw err;}
}
