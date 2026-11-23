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
export async function verifySplit(options) {
 // The guarded entry fails closed before resolving a route, admitting a
 // request or touching SQLite if any required authority check is missing.
 // Callers must construct these callbacks on the server, never from a request.
 if (!options || ['authority','resolveAuthority','admit'].some(name=>typeof options[name]!=='function')) throw new SplitUnavailable();
 return verifySplitInternal(options);
}

// The isolated state-machine and latency tests deliberately exercise the
// protocol without a registry, fence or admission. Never mount this entry.
export async function verifySplitUnsafeForTest(options) {
 return verifySplitInternal(options);
}

async function verifySplitInternal({storage, load, success, failure, verify, project, attempt, challenge, password, authority, resolveAuthority, admit, now=()=>Date.now(), leaseMs=30_000}) {
 if(typeof password!=='string'||password.length===0||password.length>4096||typeof verify!=='function'||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>30_000)throw new SplitUnavailable();
 const job=crypto.randomUUID();
 let snapshot, initialAuthority, registryAuthority;
 if (resolveAuthority) { try { registryAuthority=JSON.stringify(await resolveAuthority()); } catch { throw new SplitStale(); } if (!registryAuthority || registryAuthority==='null') throw new SplitStale(); }
 // The production owner would supply its normal rate-limit admission here.
 // Commit admission separately: rejected/invalid proofs must not roll it back.
 if (admit) {
  let allowed;
  try { allowed=storage.transactionSync(()=>{if (authority) authority();return admit()===true;}); } catch { throw new SplitUnavailable(); }
  if (!allowed) throw new SplitBusy();
 }
 const started=now();
 storage.transactionSync(()=>{
  // Optional only for the original isolated state-machine tests. A real
  // integration must supply an owner-fence and recovery-era check here and
  // must never accept these values from the verifier or browser.
  if (authority) { try { initialAuthority=JSON.stringify(authority()); } catch { throw new SplitStale(); } if (!initialAuthority) throw new SplitStale(); }
  snapshot=load(project,attempt,challenge);
  if(!snapshot||!current(snapshot,snapshot,started)||!snapshot.hash||!snapshot.epoch)throw new SplitStale();
  storage.sql.exec('DELETE FROM split_jobs WHERE project=? AND attempt=? AND challenge=? AND lease_until<=?',project,attempt,challenge,started);
  const rows=storage.sql.exec('INSERT INTO split_jobs(project,attempt,challenge,job,lease_until) VALUES(?,?,?,?,?) ON CONFLICT(project,attempt,challenge) DO NOTHING RETURNING job',project,attempt,challenge,job,started+leaseMs).toArray();
  if(rows.length!==1)throw new SplitBusy();
 });
 // Cleanup is a write too. A verifier can return after the owner has been
 // frozen, retired, or restored into a different era; in that case leave
 // the reservation for a later authorized cleanup instead of mutating the
 // stale owner. Never let a cleanup failure replace the original result.
 const release=()=>{try{storage.transactionSync(()=>{
  if (authority && JSON.stringify(authority())!==initialAuthority) throw new SplitStale();
  storage.sql.exec('DELETE FROM split_jobs WHERE project=? AND attempt=? AND challenge=? AND job=?',project,attempt,challenge,job);
 });}catch{ /* A later authorized invocation can reclaim an expired lease. */ }};
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
  // Resolve through an independent registry after the verifier I/O. The
  // owner fence still decides authority inside the following transaction.
  if (resolveAuthority) { let currentRegistry; try { currentRegistry=JSON.stringify(await resolveAuthority()); } catch { throw new SplitStale(); } if (!currentRegistry || currentRegistry!==registryAuthority) throw new SplitStale(); }
  return storage.transactionSync(()=>{
   if (authority) { let currentAuthority; try { currentAuthority=JSON.stringify(authority()); } catch { throw new SplitStale(); } if (!currentAuthority || currentAuthority!==initialAuthority) throw new SplitStale(); }
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
