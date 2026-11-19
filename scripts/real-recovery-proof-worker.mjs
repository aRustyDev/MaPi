// Test-only orchestration. The control methods trust the caller.
import { DurableObject } from 'cloudflare:workers';
import { NextgenApplication } from '../worker/generated/real-recovery-proof-object.js';
export { NextgenApplication };
const check = (value, message) => { if (!value) throw Error(message); };
const rejects = async (fn, message) => { try { await fn(); } catch { return; } throw Error(message); };
export class RecoveryRegistry extends DurableObject {
  constructor(ctx, env) { super(ctx,env); ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS route (project_id TEXT PRIMARY KEY, era TEXT NOT NULL, state TEXT NOT NULL, op TEXT, previous TEXT)'); }
  read(project) { return this.ctx.storage.sql.exec('SELECT * FROM route WHERE project_id=?',project).toArray()[0] ?? null; }
  register(project) {
    return this.ctx.storage.transactionSync(() => { this.ctx.storage.sql.exec("INSERT OR IGNORE INTO route VALUES (?,?,'active',NULL,NULL)",project,crypto.randomUUID());return this.read(project); });
  }
  begin(project, old, op) {
    return this.ctx.storage.transactionSync(() => {
      const row=this.read(project);if(row?.state==='recovering'&&row.op===op&&row.previous===old)return row;
      check(row?.state==='active'&&row.era===old,'stale recovery');
      this.ctx.storage.sql.exec("UPDATE route SET era=?,state='recovering',op=?,previous=? WHERE project_id=?",crypto.randomUUID(),op,old,project);return this.read(project);
    });
  }
  activate(project, era, op) {
    return this.ctx.storage.transactionSync(() => {
      const row=this.read(project);if(row?.state==='active'&&row.era===era&&row.op===op)return row;
      check(row?.state==='recovering'&&row.era===era&&row.op===op,'stale activation');
      this.ctx.storage.sql.exec("UPDATE route SET state='active' WHERE project_id=?",project);return this.read(project);
    });
  }
}
export default { async fetch(request, env) {
  if (env.MAPI_LOCAL_TEST !== '1' || !['localhost','127.0.0.1'].includes(new URL(request.url).hostname)) return new Response(null,{status:404});
  try {
    const registry=env.RECOVERY_REGISTRY.getByName('control'), name=crypto.randomUUID();
    const one=env.NEXTGEN_APPLICATION.getByName('one-'+name), two=env.NEXTGEN_APPLICATION.getByName('two-'+name);
    const p1=(await one.provision('Recovery one','https://one.example')).projectId, p2=(await two.provision('Recovery two','https://two.example')).projectId;
    const r1={projectId:p1,era:(await registry.register(p1)).era},r2={projectId:p2,era:(await registry.register(p2)).era};
    await one.proofInit(r1.era);await two.proofInit(r2.era);
    const email1='one@example.test', email2='two@example.test', pass='Test-Password-123!';
    await one.proofCall(r1,'add',{email:email1,password:pass});await two.proofCall(r2,'add',{email:email2,password:pass});
    const s1=await one.proofCall(r1,'login',{email:email1,password:pass}),s2=await two.proofCall(r2,'login',{email:email2,password:pass});
    check(s1.status===200&&s2.status===200&&s1.cookie&&s2.cookie,'login failed');
    const c1=s1.cookie.split(';',1)[0],c2=s2.cookie.split(';',1)[0];
    const active=await one.proofCall(r1,'login',{email:email1,password:pass});check(active.status===200&&active.cookie,'second session failed');
    const activeCookie=active.cookie.split(';',1)[0];
    check((await one.proofCall(r1,'session',{cookie:c1})).status===200,'session not readable');
    const control=await two.proofCall(r2,'mint',{email:email2,password:pass});check(control.status===200,'control handoff failed');
    check((await two.proofCall(r2,'exchange',{handoff:control.handoff})).status===200,'valid control handoff rejected');
    const handoff=await one.proofCall(r1,'mint',{email:email1,password:pass});check(handoff.status===200,'handoff failed');
    await one.proofBackup(r1);
    const csrf=await one.proofCall(r1,'session',{cookie:c1,action:'csrf'});
    check(csrf.status===200 && csrf.data?.csrf_token,'csrf failed');
    check((await one.proofCall(r1,'session',{cookie:c1,action:'logout',csrf:csrf.data.csrf_token})).status===204,'logout failed');
    check((await one.proofCall(r1,'session',{cookie:c1})).status===401,'revoked cookie accepted');
    const pending=one.proofDelayedAdd(r1,'late','late@example.test',pass),pendingResult=pending.then(()=>false,()=>true);
    const restartPending=one.proofDelayedAdd(r1,'restart','restart@example.test',pass),restartResult=restartPending.then(()=>false,()=>true);
    for(let i=0;i<100&&(!(await one.proofWaiting('late'))||!(await one.proofWaiting('restart')));i++)await new Promise(resolve=>setTimeout(resolve,10));
    check(await one.proofWaiting('late')&&await one.proofWaiting('restart'),'in-flight work did not start');
    const next=await registry.begin(p1,r1.era,'restore-1');check((await registry.begin(p1,r1.era,'restore-1')).era===next.era,'recovery retry changed era');
    await rejects(()=>registry.begin(p1,'wrong-era','restore-1'),'mismatched recovery retry accepted');
    await rejects(()=>registry.begin(p1,r1.era,'conflict'),'conflicting recovery accepted');
    await one.proofFreeze(r1);
    await rejects(()=>one.proofCall(r1,'add',{email:'stale@example.test',password:pass}),'stale route wrote');
    await one.proofRelease('late');check(await pendingResult,'suspended write committed after fence');
    check((await two.proofCall(r2,'session',{cookie:c2})).status===200,'other project affected');
    await one.proofRestore(r1);await rejects(()=>one.evict(),'eviction failed');check(await restartResult,'in-flight write survived restart');
    const restored=env.NEXTGEN_APPLICATION.getByName('one-'+name),rnew={projectId:p1,era:next.era};
    await rejects(()=>restored.proofCall(r1,'session',{cookie:c1}),'old route admitted during recovery');
    const before=await restored.proofState();check(before.sessions>0&&before.users===1&&before.recovered===0,'partial restore missing state');
    await rejects(()=>restored.proofRecover(rnew,true),'injected recovery audit failure committed');
    const failed=await restored.proofState();check(failed.epoch==='0'&&failed.sessions===before.sessions&&failed.recovered===0,'failed recovery persisted');
    await rejects(()=>restored.proofRecover(rnew,false,true),'recovery checkpoint did not abort');
    const resumed=env.NEXTGEN_APPLICATION.getByName('one-'+name),checkpoint=await resumed.proofState();
    check(checkpoint.epoch===rnew.era&&checkpoint.recovered===1,'recovery transaction did not survive abort');
    await resumed.proofRecover(rnew);const recovered=await resumed.proofState();check(recovered.epoch===rnew.era&&recovered.recovered===1,'recovery retry failed or duplicated audit');
    await resumed.proofRecover(rnew);check((await resumed.proofState()).recovered===1,'recovery retry duplicated audit');
    await rejects(()=>resumed.proofCall(rnew,'session',{cookie:c1}),'owner admitted before registry activation');
    await registry.activate(p1,rnew.era,'restore-1');await registry.activate(p1,rnew.era,'restore-1');
    await rejects(()=>resumed.proofCall(r1,'add',{email:'stale2@example.test',password:pass}),'old era accepted after recovery');
    check((await resumed.proofCall(rnew,'session',{cookie:c1})).status===401,'restored session survived recovery');
    check((await resumed.proofCall(rnew,'session',{cookie:activeCookie})).status===401,'active restored session survived recovery');
    const expired=await resumed.proofCall(rnew,'exchange',{handoff:handoff.handoff});
    check(expired.status>=400&&expired.status<500,'restored handoff was not rejected as invalid');
    const after=await resumed.proofCall(rnew,'login',{email:email1,password:pass});check(after.status===200,'user did not survive');
    check((await two.proofCall(r2,'session',{cookie:c2})).status===200,'other session revoked');
    const last=await resumed.proofState();check(last.users===1&&last.checks>0,'stale user persisted or transaction fence not exercised');
    return Response.json({ok:true,projects:2,guardedTransactions:last.checks,recoveryAudit:recovered.recovered});
  } catch(error) { return Response.json({ok:false,error:String(error),stack:error?.stack},{status:500}); }
} };
