import { NextgenApplication } from '../worker/generated/recovery-credential-proof-object.js';
const check = (v, message) => { if (!v) throw Error(message); };
const reject = async (fn, expected) => { try { await fn(); } catch (error) { if (!expected || String(error).includes(expected)) return; throw error; } throw Error('Expected rejection'); };
export class RecoveryBatchOwner extends NextgenApplication {
  setEpochsForTest(epochs) { this.ctx.storage.transactionSync(() => { const s=this.ctx.storage.sql; s.exec('DELETE FROM mapi_recovery_epoch'); for(const epoch of epochs) s.exec('INSERT INTO mapi_recovery_epoch VALUES (?)',epoch); }); }
  setProjectsForTest(projects) { this.ctx.storage.transactionSync(() => { const s=this.ctx.storage.sql; s.exec("DELETE FROM mapi_project"); for(const project of projects) s.exec("INSERT INTO mapi_project VALUES (?, ?)",project,"https://schema.example"); }); }
  makeOnlySessionLegacy(projectId) { return this.ctx.storage.transactionSync(() => { const s=this.ctx.storage.sql; const rows=s.exec('SELECT id FROM sessions WHERE project_id=?',projectId).toArray(); if(rows.length!==1) throw Error('expected one test session'); s.exec("UPDATE sessions SET token_id='' WHERE project_id=? AND id=?",projectId,rows[0].id); return rows[0].id; }); }
  makeFirstSessionLegacy(projectId) { return this.ctx.storage.transactionSync(() => { const s=this.ctx.storage.sql; const rows=s.exec('SELECT id FROM sessions WHERE project_id=? ORDER BY id LIMIT 1',projectId).toArray(); if(rows.length!==1) throw Error('expected a test session'); s.exec("UPDATE sessions SET token_id='' WHERE project_id=? AND id=?",projectId,rows[0].id); return rows[0].id; }); }
  backupCredentials(projectId, first, second) { this.ctx.storage.sql.exec('CREATE TABLE mapi_test_credential_backup AS SELECT * FROM tokens WHERE project_id=? AND token_id IN (?,?)', projectId, first, second); }
  restoreCredentials() { this.ctx.storage.sql.exec('INSERT INTO tokens SELECT * FROM mapi_test_credential_backup'); }
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
  phaseForTest() { const sql=this.ctx.storage.sql; if (!sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_recovery_invalidation'").toArray().length) return null; return sql.exec('SELECT phase FROM mapi_recovery_invalidation WHERE singleton=1').toArray()[0]?.phase; }
  nextAttemptHasNoChecks(projectId) {
    const sql=this.ctx.storage.sql;
    const phase=sql.exec('SELECT phase FROM mapi_recovery_invalidation WHERE singleton=1').toArray()[0]?.phase;
    const attempt=sql.exec('SELECT id FROM auth_attempts WHERE project_id=? ORDER BY id LIMIT 1',projectId).toArray()[0];
    return phase==='attempts' && !!attempt && sql.exec('SELECT COUNT(*) n FROM checks WHERE project_id=? AND auth_attempt_id=?',projectId,attempt.id).one().n===0;
  }
  state(projectId) {
    const s=this.ctx.storage.sql;
    const q=(x)=>s.exec(x,projectId).one().n;
    return {sessions:q('SELECT COUNT(*) n FROM sessions WHERE project_id=?'), checks:q('SELECT COUNT(*) n FROM checks WHERE project_id=? AND session_id IS NOT NULL'), tokens:q('SELECT COUNT(*) n FROM tokens WHERE project_id=? AND session_id IS NOT NULL'), nonSessionTokens:q('SELECT COUNT(*) n FROM tokens WHERE project_id=? AND session_id IS NULL'), credentialAudit:q("SELECT COUNT(*) n FROM events WHERE project_id=? AND event_type='mapi.recovery.credential_invalidated'"), liveTokens:q('SELECT COUNT(*) n FROM tokens t WHERE t.project_id=? AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=t.project_id AND s.id=t.session_id)'), pending:q('SELECT COUNT(*) n FROM auth_attempts WHERE project_id=? AND handed_off_at IS NOT NULL AND handoff_token IS NOT NULL AND handed_off_at <> 1'), audit:q('SELECT COUNT(*) n FROM events WHERE project_id=?'), attempts:q('SELECT COUNT(*) n FROM auth_attempts WHERE project_id=?'), attemptChecks:q('SELECT COUNT(*) n FROM checks WHERE project_id=? AND auth_attempt_id IS NOT NULL'), attemptAudit:q("SELECT COUNT(*) n FROM events WHERE project_id=? AND event_type='mapi.recovery.attempt_invalidated'"), attemptChecksAudit:q("SELECT COUNT(*) n FROM events WHERE project_id=? AND event_type='mapi.recovery.attempt_checks_invalidated'"), recovery:q("SELECT COUNT(*) n FROM events WHERE project_id=? AND event_type='mapi.recovery.completed'")};
  }
}
export default { async fetch(request,env) {
  if (new URL(request.url).pathname === '/ready') return new Response('ready');
  try {
    let owner=env.OWNER.getByName('one');
    const other=env.OWNER.getByName('other');
    const otherProject=(await other.provision('Other project','https://other.example')).projectId;
    const otherUser=await other.addUser('other@example.test','Other-password-123!');
    const otherCredential=await other.testCredentialProof({Action:'mint',Kind:'project'});
    const otherLogin=await other.login('other@example.test','Other-password-123!','192.0.2.2');
    const otherHandoff=await other.testMintHandoff('other@example.test','Other-password-123!');
    const otherAttempt=await other.testPrepareVerifiedAttempt('other@example.test','Other-password-123!');
    check(otherLogin.status===200 && otherHandoff.status===200 && otherProject!==null,'other project fixture failed');
    const projectId=(await owner.provision('Batch proof','https://one.example')).projectId;
    const user=await owner.addUser('one@example.test','Batch-password-123!');
    const pat=await owner.testCredentialProof({Action:'mint',Kind:'pat',UserID:user.userId});
    const projectToken=await owner.testCredentialProof({Action:'mint',Kind:'project'});
    const legacyPat=await owner.testCredentialProof({Action:'legacy',Kind:'pat',UserID:user.userId});
    const legacyProject=await owner.testCredentialProof({Action:'legacy',Kind:'project'});
    const legacyPreview=await owner.testCredentialProof({Action:'legacy',Kind:'preview'});
    const legacyFlow=await owner.testCredentialProof({Action:'legacy',Kind:'flow'});
    const legacyJwtProfile=await owner.testCredentialProof({Action:'legacy',Kind:'jwtprofile'});
    const legacyOIDC=await owner.testCredentialProof({Action:'legacy',Kind:'oidc',UserID:user.userId,OIDCSessionID:'oidc-synthetic'});
    const legacySAML=await owner.testCredentialProof({Action:'legacy',Kind:'saml',UserID:user.userId,SAMLSessionID:'saml-synthetic'});
    const otherLegacyOIDC=await other.testCredentialProof({Action:'legacy',Kind:'oidc',UserID:'user-other',OIDCSessionID:'oidc-other'});
    const otherLegacySAML=await other.testCredentialProof({Action:'legacy',Kind:'saml',UserID:'user-other',SAMLSessionID:'saml-other'});
    check(pat.tokenId && projectToken.tokenId && !legacyPat.tokenId && !legacyProject.tokenId,'credential JTI fixture mismatch');
    for(const item of [pat,projectToken,legacyPat,legacyProject,legacyPreview,legacyFlow,legacyJwtProfile,legacyOIDC,legacySAML]) check((await owner.testCredentialProof({Action:'introspect',Token:item.token})).valid,'credential fixture invalid');
    for(const item of [otherLegacyOIDC,otherLegacySAML]) check((await other.testCredentialProof({Action:'introspect',Token:item.token})).valid,'other project legacy fixture invalid');
    const legacyBearerBefore = await owner.testLegacyBearer(legacyProject.token);
    check(legacyBearerBefore.status===201, `legacy project bearer failed before recovery: ${legacyBearerBefore.status} ${JSON.stringify(legacyBearerBefore.data)}`);
    await owner.backupCredentials(projectId,pat.tokenId,projectToken.tokenId);
    await owner.testCredentialProof({Action:'revoke',TokenID:pat.tokenId}); await owner.testCredentialProof({Action:'revoke',TokenID:projectToken.tokenId});
    check(!(await owner.testCredentialProof({Action:'introspect',Token:pat.token})).valid && !(await owner.testCredentialProof({Action:'introspect',Token:projectToken.token})).valid,'revoked credential stayed valid');
    await owner.restoreCredentials();
    check((await owner.testCredentialProof({Action:'introspect',Token:pat.token})).valid && (await owner.testCredentialProof({Action:'introspect',Token:projectToken.token})).valid,'snapshot did not reproduce credential resurrection');
    const login=await owner.login('one@example.test','Batch-password-123!','192.0.2.1');
    check(login.status===200 && login.cookie,'login failed');
    const handoff=await owner.testMintHandoff('one@example.test','Batch-password-123!');
    const verified=await owner.testPrepareVerifiedAttempt('one@example.test','Batch-password-123!');
    const control=await owner.testPrepareVerifiedAttempt('one@example.test','Batch-password-123!');
    check((await owner.testResumeVerifiedAttempt(control.attemptId,control.challengeId,'Batch-password-123!','handoff')).status===200,'verified control attempt could not hand off');
    check(handoff.status===200,'handoff failed');
    await owner.seed(projectId);
    const oversizedBefore=await owner.state(projectId);
    await reject(()=>owner.testRecoveryBatch('recovery-one'), 'recovery ID exceeds limit or is invalid');
    check(JSON.stringify(await owner.state(projectId))===JSON.stringify(oversizedBefore),'oversized ID rejection committed data');
    await owner.removeOversizeForTest(projectId);
    let previous=await owner.state(projectId), failed=false, evicted=false, attemptAuditFailed=false, attemptDeleteFailed=false, credentialAuditFailed=false, completionArmed=false, completionFailed=false, calls=0;
    const expectedAttempts=previous.attempts, expectedCredentials=previous.nonSessionTokens;
    while (calls++ < 400) {
      if (!failed && previous.sessions===1 && previous.checks===0 && previous.liveTokens===0) {
        await owner.failNextAudit(1);
        await reject(()=>owner.testRecoveryBatch('recovery-one'));
        const rolledBack=await owner.state(projectId);
        check(JSON.stringify(rolledBack)===JSON.stringify(previous),'audit failure committed partial recovery');
        failed=true;
      }
      if (failed && !completionArmed && previous.sessions===0 && previous.attempts===0) { await owner.failNextAudit(1); completionArmed=true; }
      if (!credentialAuditFailed && previous.nonSessionTokens>0 && await owner.phaseForTest()==='credentials') {
        await owner.failNextAudit(1); await reject(()=>owner.testRecoveryBatch('recovery-one'));
        check(JSON.stringify(await owner.state(projectId))===JSON.stringify(previous),'credential audit failure committed revocation');
        credentialAuditFailed=true;
      }
      if (!attemptDeleteFailed && previous.sessions===0 && await owner.nextAttemptHasNoChecks(projectId)) {
        await owner.failNextAudit(1); await reject(()=>owner.testRecoveryBatch('recovery-one'));
        check(JSON.stringify(await owner.state(projectId))===JSON.stringify(previous),'attempt deletion audit failure committed changes');
        attemptDeleteFailed=true;
      }
      let result;
      try { result=await owner.testRecoveryBatch('recovery-one'); } catch (error) {
        if (!completionArmed || completionFailed) throw error;
        check(JSON.stringify(await owner.state(projectId))===JSON.stringify(previous),'completion audit failure changed state');
        completionFailed=true; continue;
      }
      if (result.count!==undefined) check(result.count<=64,'batch bound exceeded');
      if (!attemptAuditFailed && result.phase==='attempt-checks') {
        const beforeAttemptFailure=await owner.state(projectId);
        await owner.failNextAudit(1); await reject(()=>owner.testRecoveryBatch('recovery-one'));
        check(JSON.stringify(await owner.state(projectId))===JSON.stringify(beforeAttemptFailure),'attempt audit failure committed partial cleanup');
        attemptAuditFailed=true;
      }
      if (!evicted && result.phase==='checks') {
        await reject(()=>owner.testRecoveryBatch('wrong-recovery'));
        await reject(()=>owner.evict()); owner=env.OWNER.getByName('one'); evicted=true;
      }
      const current=await owner.state(projectId);
      check(current.sessions<=previous.sessions && current.checks<=previous.checks && current.tokens<=previous.tokens && current.pending<=previous.pending,'recovery moved backwards');
      previous=current;
      if(result.done) break;
    }
    check(calls<400 && evicted && failed && attemptAuditFailed && attemptDeleteFailed && credentialAuditFailed && completionFailed,'recovery did not finish or test failure/restart');
    const final=await owner.state(projectId);
    check(final.sessions===0 && final.checks===0 && final.tokens===0 && final.nonSessionTokens===0 && final.pending===0 && final.attempts===0 && final.attemptChecks===0 && final.recovery===1,'invalidation incomplete');
    check(final.credentialAudit===expectedCredentials,'credential invalidation audit incomplete');
    check(final.attemptAudit===expectedAttempts && final.attemptChecksAudit>=3,'attempt or challenge invalidation audit incomplete');
    check((await owner.session(login.cookie,'read','')).status===401,'old session survived');
    check((await owner.testExchangeHandoff(handoff.handoff)).status>=400,'old handoff survived');
    check((await owner.testResumeVerifiedAttempt(verified.attemptId,verified.challengeId,'Batch-password-123!','handoff')).status>=400,'verified pre-handoff attempt resumed');
    check((await owner.testResumeVerifiedAttempt(verified.attemptId,verified.challengeId,'Batch-password-123!','challenge')).status>=400,'old challenge resumed');
    check((await other.session(otherLogin.cookie,'read','')).status===200,'other session was invalidated');
    check((await other.testExchangeHandoff(otherHandoff.handoff)).status===200,'other handoff was invalidated');
    check((await other.testResumeVerifiedAttempt(otherAttempt.attemptId,otherAttempt.challengeId,'Other-password-123!','handoff')).status===200,'other verified attempt was invalidated');
    await reject(()=>owner.testRecoveryBatch('recovery-two'), 'conflicting recovery checkpoint');
    check(!(await owner.testCredentialProof({Action:'introspect',Token:pat.token})).valid && !(await owner.testCredentialProof({Action:'introspect',Token:projectToken.token})).valid,'stored credentials survived invalidation');
    check((await owner.testCredentialProof({Action:'introspect',Token:legacyPat.token})).valid && (await owner.testCredentialProof({Action:'introspect',Token:legacyProject.token})).valid,'legacy no-JTI limitation did not reproduce');
    check((await other.testCredentialProof({Action:'introspect',Token:otherCredential.token})).valid,'other project credential was invalidated');
    const after=await owner.testRecoveryBatch('recovery-one');
    check(after.done && (await owner.state(projectId)).recovery===1,'retry duplicated completion audit');
    const sessionLogin=await owner.login('one@example.test','Batch-password-123!','192.0.2.31');
    check(sessionLogin.status===200,'legacy session fixture login failed');
    const legacySessionId=await owner.makeOnlySessionLegacy(projectId);
    const legacySession=await owner.testCredentialProof({Action:'legacy',Kind:'session',UserID:user.userId,SessionID:legacySessionId});
    const legacyCookie=`__Host-zitadel_session=${legacySession.token}`;
    check((await owner.testCredentialProof({Action:'introspect',Token:legacySession.token})).valid && (await owner.session(legacyCookie,'read','')).status===200,'legacy session did not work before epoch transition');
    const otherLegacySessionId=await other.makeFirstSessionLegacy(otherProject);
    const otherLegacySession=await other.testCredentialProof({Action:'legacy',Kind:'session',UserID:otherUser.userId,SessionID:otherLegacySessionId});
    const otherLegacyCookie=`__Host-zitadel_session=${otherLegacySession.token}`;
    check((await other.session(otherLegacyCookie,'read','')).status===200,'other project legacy session fixture failed');
    await owner.setEpochsForTest(['recovery-era-1']);
    for(const item of [legacyPat,legacyProject,legacyPreview,legacySession,legacyOIDC,legacySAML]) check(!(await owner.testCredentialProof({Action:'introspect',Token:item.token})).valid,'old legacy credential accepted after epoch transition');
    check((await owner.session(legacyCookie,'read','')).status===401,'legacy session handler accepted cookie after epoch transition');
    check((await owner.testLegacyBearer(legacyProject.token)).status>=400, 'legacy bearer accepted after epoch transition');
    const postRecoveryLegacy=await owner.testCredentialProof({Action:'legacy',Kind:'project'});
    check(!(await owner.testCredentialProof({Action:'introspect',Token:postRecoveryLegacy.token})).valid, 'new no-JTI credential accepted after recovery');
    check((await owner.testCredentialProof({Action:'introspect',Token:legacyFlow.token})).valid && (await owner.testCredentialProof({Action:'introspect',Token:legacyJwtProfile.token})).valid, 'non-revocable credential behavior unexpectedly changed');
    check(!(await owner.testCredentialProof({Action:'introspect',Token:otherCredential.token})).valid, 'foreign credential accepted');
    const replacement=await owner.testCredentialProof({Action:'mint',Kind:'project'});
    check((await owner.testCredentialProof({Action:'introspect',Token:replacement.token})).valid && (await owner.testLegacyBearer(replacement.token)).status===201,'new tracked credential rejected after recovery');
    check((await other.testCredentialProof({Action:'introspect',Token:otherCredential.token})).valid,'other project affected by epoch transition');
    for(const item of [otherLegacyOIDC,otherLegacySAML]) check((await other.testCredentialProof({Action:'introspect',Token:item.token})).valid,'other project legacy credential affected by epoch transition');
    check((await other.session(otherLegacyCookie,'read','')).status===200,'other project legacy session affected by epoch transition');
    for (const bad of [[], ['a','b'], ['']]) {
      await owner.setEpochsForTest(bad);
      check(!(await owner.testCredentialProof({Action:'introspect',Token:legacyProject.token})).valid, 'malformed epoch accepted legacy credential');
    }
    await owner.setEpochsForTest(['0']);
    for (const projects of [[], ['proj_foreign'], [projectId, 'proj_foreign']]) {
      await owner.setProjectsForTest(projects);
      check(!(await owner.testCredentialProof({Action:'introspect',ProjectID:projectId,Token:legacyProject.token})).valid, 'missing, foreign or ambiguous project authority accepted');
    }
    await owner.setProjectsForTest([projectId]);
    check((await owner.testCredentialProof({Action:'introspect',Token:legacyProject.token})).valid, 'legacy compatibility did not recover after valid authority restored');
    return Response.json({ok:true,calls,final});
  } catch(error) { return Response.json({error:String(error),stack:error?.stack},{status:500}); }
} };
