import { DurableObject } from 'cloudflare:workers';
import { installMutationGeneration, mutationGeneration, missingGenerationCoverage } from './mutation-generation.mjs';
import { installPreflightGeneration, preflightGeneration, missingPreflightGenerationCoverage } from './preflight-mutation-generation.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };
export class RevisionProbe extends DurableObject {
  run(profile) {
    if (this.env.MAPI_LOCAL_TEST !== '1' || !['split', 'preflight'].includes(profile)) throw Error('Local test disabled');
    const s = this.ctx.storage, sql = s.sql;
    const install = profile === 'preflight' ? installPreflightGeneration : installMutationGeneration;
    const read = profile === 'preflight' ? preflightGeneration : mutationGeneration;
    const missing = profile === 'preflight' ? missingPreflightGenerationCoverage : missingGenerationCoverage;
    const counterTable = profile === 'preflight' ? 'mapi_preflight_generation' : 'mapi_mutation_generation';
    const triggerPrefix = profile === 'preflight' ? 'mapi_preflight_gen' : 'mapi_gen';
    sql.exec('PRAGMA foreign_keys = ON');
    s.transactionSync(() => {
      sql.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES users(id) ON DELETE CASCADE, value TEXT NOT NULL)');
      sql.exec('CREATE TABLE audit (id INTEGER PRIMARY KEY, description TEXT)');
      sql.exec('CREATE TRIGGER audit_user_update AFTER UPDATE ON users BEGIN INSERT INTO audit(description) VALUES (NEW.value); END');
      sql.exec('CREATE TABLE mapi_login_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)');
      sql.exec('CREATE TABLE split_jobs (id INTEGER PRIMARY KEY)');
      sql.exec('CREATE TABLE sqlitex (id INTEGER PRIMARY KEY)');
      sql.exec('CREATE TABLE mapi_preflight_progress (singleton INTEGER PRIMARY KEY, page INTEGER NOT NULL)');
      sql.exec('INSERT INTO mapi_preflight_progress VALUES (1, 0)');
      sql.exec('CREATE TABLE mapi_owner_fence (singleton INTEGER PRIMARY KEY, state TEXT NOT NULL)');
      sql.exec("INSERT INTO mapi_owner_fence VALUES (1, 'active')");
      sql.exec("INSERT INTO users VALUES (1, NULL, 'parent'), (2, 1, 'child')");
      install(s);
    });
    check(!missing(s).length, 'initial coverage failed');
    const generation = () => read(s);
    const beforeCheckpoint = generation();
    sql.exec('UPDATE mapi_preflight_progress SET page=1 WHERE singleton=1');
    const checkpointSelfInvalidates = generation() !== beforeCheckpoint;
    check(checkpointSelfInvalidates === (profile === 'split'), 'checkpoint generation behavior differs from profile');
    let checkpointMutationUntracked = false;
    if (profile === 'preflight') {
      const before = generation();
      sql.exec('UPDATE mapi_preflight_progress SET page=999 WHERE singleton=1');
      checkpointMutationUntracked = generation() === before;
      check(checkpointMutationUntracked, 'checkpoint authority counterexample changed');
    }
    const initial = generation();
    sql.exec('INSERT INTO sqlitex VALUES (1)');
    const prefixCovered = generation() !== initial;
    check(prefixCovered, 'non-internal sqlite-like table was not covered');
    const beforeThrottle = generation();
    sql.exec("INSERT INTO mapi_login_limits VALUES ('ip', 1, 1)");
    const throttleChanged = generation() !== beforeThrottle;
    check(throttleChanged === (profile === 'preflight'), 'throttle coverage differs from profile');
    const beforeJob = generation();
    sql.exec('INSERT INTO split_jobs VALUES (1)');
    check((generation() !== beforeJob) === (profile === 'preflight'), 'job coverage differs from profile');
    const beforeRollback = generation();
    try { s.transactionSync(() => { sql.exec("UPDATE users SET value='rollback' WHERE id=1"); sql.exec("UPDATE mapi_login_limits SET count=3 WHERE key='ip'"); throw Error('rollback'); }); }
    catch (error) { if (error.message !== 'rollback') throw error; }
    check(generation() === beforeRollback && sql.exec('SELECT value FROM users WHERE id=1').one().value === 'parent' && sql.exec('SELECT COUNT(*) AS n FROM audit').one().n === 0, 'rollback changed rows or counter');
    const beforeUpdate = generation();
    sql.exec("UPDATE users SET value='updated' WHERE id=1");
    check(BigInt(generation()) >= BigInt(beforeUpdate) + 2n && sql.exec('SELECT COUNT(*) AS n FROM audit').one().n === 1, 'update or nested audit was not counted');
    const beforeCascade = generation();
    sql.exec('DELETE FROM users WHERE id=1');
    check(BigInt(generation()) >= BigInt(beforeCascade) + 2n && sql.exec('SELECT COUNT(*) AS n FROM users').one().n === 0, 'foreign-key cascade was not counted');
    const snapshot = generation();
    if (profile === 'preflight') {
      sql.exec("UPDATE mapi_login_limits SET count=count+1 WHERE key='ip'");
      let stale = false;
      try { s.transactionSync(() => { if (generation() !== snapshot) throw Error('stale scan'); sql.exec("UPDATE mapi_owner_fence SET state='frozen' WHERE singleton=1"); }); }
      catch (error) { stale = error.message === 'stale scan'; }
      check(stale && sql.exec('SELECT state FROM mapi_owner_fence').one().state === 'active', 'stale throttle scan accepted');
      const fresh = generation();
      s.transactionSync(() => { if (generation() !== fresh) throw Error('stale scan'); sql.exec("UPDATE mapi_owner_fence SET state='frozen' WHERE singleton=1"); });
      check(sql.exec('SELECT state FROM mapi_owner_fence').one().state === 'frozen' && BigInt(generation()) > BigInt(fresh), 'fresh compare and freeze failed');
    }
    sql.exec('CREATE TABLE late_table(id INTEGER PRIMARY KEY)');
    check(missing(s).includes('late_table:table-untracked'), 'new schema was not detected');
    s.transactionSync(() => install(s));
    check(!missing(s).length, 'new table was not instrumented');
    sql.exec(`DROP TRIGGER ${triggerPrefix}_update_late_table`);
    check(missing(s).includes('late_table:update'), 'missing trigger was not detected');
    // These two counterexamples are deliberate: the local prototype does not
    // defend its counter against privileged SQL or a rewind by restore.
    let invalidCounterRejected = false;
    {
      const validCounter = generation();
      invalidCounterRejected = true;
      for (const value of [1.5, 'abc']) {
        sql.exec(`UPDATE ${counterTable} SET counter=? WHERE singleton=1`, value);
        try { generation(); invalidCounterRejected = false; } catch {}
        let writeRejected = false;
        try { sql.exec('INSERT INTO sqlitex VALUES (2)'); } catch { writeRejected = true; }
        if (!writeRejected || sql.exec('SELECT COUNT(*) AS n FROM sqlitex WHERE id=2').one().n !== 0) invalidCounterRejected = false;
      }
      sql.exec(`UPDATE ${counterTable} SET counter=CAST(? AS INTEGER) WHERE singleton=1`, validCounter);
      check(invalidCounterRejected, 'non-integer counter was accepted');
    }
    sql.exec(`UPDATE ${counterTable} SET counter=0 WHERE singleton=1`);
    const directCounterRewind = generation() === '0';
    sql.exec(`DELETE FROM ${counterTable} WHERE singleton=1`);
    let rejectedWhileMissing = false;
    try { sql.exec('INSERT INTO late_table VALUES (1)'); } catch { rejectedWhileMissing = true; }
    let refusedMissingCounter = false;
    try { s.transactionSync(() => install(s)); } catch { refusedMissingCounter = true; }
    const missingCounterRecreated = !refusedMissingCounter && generation() === '0';
    check(directCounterRewind && rejectedWhileMissing && missingCounterRecreated === (profile === 'split') && refusedMissingCounter === (profile === 'preflight'), 'counter behavior changed');
    return { profile, throttleChanged, prefixCovered, invalidCounterRejected, rollback: true, nestedAudit: true, cascade: true, staleThrottleRejected: profile === 'preflight', schemaDetection: true, checkpointSelfInvalidates, checkpointMutationUntracked, directCounterRewind, missingCounterRecreated, refusedMissingCounter };
  }
}
export default { async fetch(request, env) {
  if (env.MAPI_LOCAL_TEST !== '1' || new URL(request.url).hostname !== '127.0.0.1') return new Response(null, {status: 404});
  try { const profile = new URL(request.url).searchParams.get('profile'); return Response.json(await env.OWNER.getByName(profile).run(profile)); }
  catch (error) { return Response.json({error: String(error)}, {status: 500}); }
} };
