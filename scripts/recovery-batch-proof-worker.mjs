import { NextgenApplication } from '../worker/generated/recovery-batch-proof-object.js';
export { ProjectRegistry } from '../worker/registry.js';
const check = (v, message) => { if (!v) throw Error(message); };
const reject = async (fn, expected) => { try { await fn(); } catch (error) { if (!expected || String(error).includes(expected)) return; throw error; } throw Error('Expected rejection'); };
export class RecoveryBatchOwner extends NextgenApplication {
  seed(projectId) {
    const s = this.ctx.storage.sql;
    const session = s.exec('SELECT id FROM sessions WHERE project_id=? ORDER BY id LIMIT 1', projectId).one().id;
    this.ctx.storage.transactionSync(() => {
      s.exec('INSERT INTO checks (project_id,id,session_id,type) VALUES (?,?,?,?)',projectId,'z'.repeat(8193),session,1);
      for (let i=0;i<65;i++) {
        const suffix=String(i).padStart(2,'0');
        s.exec('INSERT INTO checks (project_id,id,session_id,type) VALUES (?,?,?,?)',projectId,'C'+suffix+'x'.repeat(8189),session,1);
        s.exec("INSERT INTO tokens (project_id,token_id,token_type,session_id,scope,created_at) VALUES (?,?,'session_token',?,'[]',1)",projectId,'T'+suffix+'x'.repeat(8189),session);
        s.exec('INSERT INTO auth_attempts (project_id,id,handoff_token,handed_off_at,created_at) VALUES (?,?,?,?,1)',projectId,'A'+suffix+'x'.repeat(8189),new Uint8Array([i,89,91]),1000000000000);
      }
      for (let i=0;i<130;i++) {
        const id=String(i).padStart(4,'0');
        s.exec('INSERT INTO checks (project_id,id,session_id,type) VALUES (?,?,?,?)', projectId, 'check_batch_'+id, session, 1);
        s.exec("INSERT INTO tokens (project_id,token_id,token_type,session_id,scope,created_at) VALUES (?,?,'session_token',?,'[]',1)",projectId,'token_batch_'+id,session);
        s.exec('INSERT INTO auth_attempts (project_id,id,handoff_token,handed_off_at,created_at) VALUES (?,?,?,?,1)',projectId,'attempt_batch_'+id,new Uint8Array([i,73,84]),1000000000000);
      }
      for (let i=0;i<130;i++) s.exec('INSERT INTO checks (project_id,id,auth_attempt_id,type) VALUES (?,?,?,?)',projectId,'attempt_check_'+i,'attempt_batch_0000',i+1);
      for (let i=0;i<66;i++) s.exec("INSERT INTO tokens (project_id,token_id,token_type,session_id,scope,created_at) VALUES (?,?,'session_token','sess_orphan','[]',1)",projectId,'orphan_'+i);
    });
  }
  removeOversizeForTest(projectId) { this.ctx.storage.sql.exec('DELETE FROM checks WHERE project_id=? AND id=?',projectId,'z'.repeat(8193)); }
  nextAttemptHasNoChecks(projectId) {
    const sql=this.ctx.storage.sql;
    const phase=sql.exec('SELECT phase FROM mapi_recovery_invalidation WHERE singleton=1').toArray()[0]?.phase;
    const attempt=sql.exec('SELECT id FROM auth_attempts WHERE project_id=? ORDER BY id LIMIT 1',projectId).toArray()[0];
    return phase==='attempts' && !!attempt && sql.exec('SELECT COUNT(*) n FROM checks WHERE project_id=? AND auth_attempt_id=?',projectId,attempt.id).one().n===0;
  }
  state(projectId) {
    const s=this.ctx.storage.sql;
    const q=(x)=>s.exec(x,projectId).one().n;
    return {sessions:q('SELECT COUNT(*) n FROM sessions WHERE project_id=?'), checks:q('SELECT COUNT(*) n FROM checks WHERE project_id=? AND session_id IS NOT NULL'), tokens:q('SELECT COUNT(*) n FROM tokens WHERE project_id=? AND session_id IS NOT NULL'), liveTokens:q('SELECT COUNT(*) n FROM tokens t WHERE t.project_id=? AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=t.project_id AND s.id=t.session_id)'), pending:q('SELECT COUNT(*) n FROM auth_attempts WHERE project_id=? AND handed_off_at IS NOT NULL AND handoff_token IS NOT NULL AND handed_off_at <> 1'), audit:q('SELECT COUNT(*) n FROM events WHERE project_id=?'), attempts:q('SELECT COUNT(*) n FROM auth_attempts WHERE project_id=?'), attemptChecks:q('SELECT COUNT(*) n FROM checks WHERE project_id=? AND auth_attempt_id IS NOT NULL'), attemptAudit:q("SELECT COUNT(*) n FROM events WHERE project_id=? AND event_type='mapi.recovery.attempt_invalidated'"), attemptChecksAudit:q("SELECT COUNT(*) n FROM events WHERE project_id=? AND event_type='mapi.recovery.attempt_checks_invalidated'"), recovery:q("SELECT COUNT(*) n FROM events WHERE project_id=? AND event_type='mapi.recovery.completed'")};
  }
}
export default { async fetch(_request,env) {
  try {
    let owner=env.OWNER.getByName('one');
    const other=env.OWNER.getByName('other');
    const registry=env.PROJECT_REGISTRY.getByName('projects');
    async function provision(instance, name, origin, objectName) {
      await registry.reserve(origin, objectName);
      const pending = {projectId:null, origin, objectName, generation:1};
      const projectId = (await instance.provision(name, origin, pending)).projectId;
      await registry.activate(origin, objectName, projectId);
      return {projectId, origin, objectName, generation:1};
    }
    const otherRoute=await provision(other,'Other project','https://other.example','other');
    const otherProject=otherRoute.projectId;
    await other.addUser('other@example.test','Other-password-123!',otherRoute);
    const otherLogin=await other.login('other@example.test','Other-password-123!','192.0.2.2',otherRoute);
    const otherHandoff=await other.testMintHandoff('other@example.test','Other-password-123!',otherRoute);
    const otherAttempt=await other.testPrepareVerifiedAttempt('other@example.test','Other-password-123!',otherRoute);
    check(otherLogin.status===200 && otherHandoff.status===200 && otherProject!==null,'other project fixture failed');
    const route=await provision(owner,'Batch proof','https://one.example','one'), projectId=route.projectId;
    await owner.addUser('one@example.test','Batch-password-123!',route);
    const login=await owner.login('one@example.test','Batch-password-123!','192.0.2.1',route);
    check(login.status===200 && login.cookie,'login failed');
    const handoff=await owner.testMintHandoff('one@example.test','Batch-password-123!',route);
    const verified=await owner.testPrepareVerifiedAttempt('one@example.test','Batch-password-123!',route);
    const control=await owner.testPrepareVerifiedAttempt('one@example.test','Batch-password-123!',route);
    check((await owner.testResumeVerifiedAttempt(control.attemptId,control.challengeId,'Batch-password-123!','handoff',route)).status===200,'verified control attempt could not hand off');
    check(handoff.status===200,'handoff failed');
    await owner.seed(projectId);
    const oversizedBefore=await owner.state(projectId);
    await reject(()=>owner.testRecoveryBatch('recovery-one',route), 'recovery ID exceeds limit or is invalid');
    check(JSON.stringify(await owner.state(projectId))===JSON.stringify(oversizedBefore),'oversized ID rejection committed data');
    await owner.removeOversizeForTest(projectId);
    let previous=await owner.state(projectId), failed=false, evicted=false, attemptAuditFailed=false, attemptDeleteFailed=false, completionArmed=false, completionFailed=false, calls=0;
    const expectedAttempts=previous.attempts;
    while (calls++ < 400) {
      if (!failed && previous.sessions===1 && previous.checks===0 && previous.liveTokens===0) {
        await owner.failNextAudit(1);
        await reject(()=>owner.testRecoveryBatch('recovery-one',route));
        const rolledBack=await owner.state(projectId);
        check(JSON.stringify(rolledBack)===JSON.stringify(previous),'audit failure committed partial recovery');
        failed=true;
      }
      if (failed && !completionArmed && previous.sessions===0 && previous.attempts===0) { await owner.failNextAudit(1); completionArmed=true; }
      if (!attemptDeleteFailed && previous.sessions===0 && await owner.nextAttemptHasNoChecks(projectId)) {
        await owner.failNextAudit(1); await reject(()=>owner.testRecoveryBatch('recovery-one',route));
        check(JSON.stringify(await owner.state(projectId))===JSON.stringify(previous),'attempt deletion audit failure committed changes');
        attemptDeleteFailed=true;
      }
      let result;
      try { result=await owner.testRecoveryBatch('recovery-one',route); } catch (error) {
        if (!completionArmed || completionFailed) throw error;
        check(JSON.stringify(await owner.state(projectId))===JSON.stringify(previous),'completion audit failure changed state');
        completionFailed=true; continue;
      }
      if (result.count!==undefined) check(result.count<=64,'batch bound exceeded');
      if (!attemptAuditFailed && result.phase==='attempt-checks') {
        const beforeAttemptFailure=await owner.state(projectId);
        await owner.failNextAudit(1); await reject(()=>owner.testRecoveryBatch('recovery-one',route));
        check(JSON.stringify(await owner.state(projectId))===JSON.stringify(beforeAttemptFailure),'attempt audit failure committed partial cleanup');
        attemptAuditFailed=true;
      }
      if (!evicted && result.phase==='checks') {
        await reject(()=>owner.testRecoveryBatch('wrong-recovery',route));
        await reject(()=>owner.evict()); owner=env.OWNER.getByName('one'); evicted=true;
      }
      const current=await owner.state(projectId);
      check(current.sessions<=previous.sessions && current.checks<=previous.checks && current.tokens<=previous.tokens && current.pending<=previous.pending,'recovery moved backwards');
      previous=current;
      if(result.done) break;
    }
    check(calls<400 && evicted && failed && attemptAuditFailed && attemptDeleteFailed && completionFailed,'recovery did not finish or test failure/restart');
    const final=await owner.state(projectId);
    check(final.sessions===0 && final.checks===0 && final.tokens===0 && final.pending===0 && final.attempts===0 && final.attemptChecks===0 && final.recovery===1,'invalidation incomplete');
    check(final.attemptAudit===expectedAttempts && final.attemptChecksAudit>=3,'attempt or challenge invalidation audit incomplete');
    check((await owner.session(login.cookie,'read','',route)).status===401,'old session survived');
    check((await owner.testExchangeHandoff(handoff.handoff,route)).status>=400,'old handoff survived');
    check((await owner.testResumeVerifiedAttempt(verified.attemptId,verified.challengeId,'Batch-password-123!','handoff',route)).status>=400,'verified pre-handoff attempt resumed');
    check((await owner.testResumeVerifiedAttempt(verified.attemptId,verified.challengeId,'Batch-password-123!','challenge',route)).status>=400,'old challenge resumed');
    check((await other.session(otherLogin.cookie,'read','',otherRoute)).status===200,'other session was invalidated');
    check((await other.testExchangeHandoff(otherHandoff.handoff,otherRoute)).status===200,'other handoff was invalidated');
    check((await other.testResumeVerifiedAttempt(otherAttempt.attemptId,otherAttempt.challengeId,'Other-password-123!','handoff',otherRoute)).status===200,'other verified attempt was invalidated');
    await reject(()=>owner.testRecoveryBatch('recovery-two',route), 'conflicting recovery checkpoint');
    const after=await owner.testRecoveryBatch('recovery-one',route);
    check(after.done && (await owner.state(projectId)).recovery===1,'retry duplicated completion audit');
    return Response.json({ok:true,calls,final});
  } catch(error) { return Response.json({error:String(error),stack:error?.stack},{status:500}); }
} };
