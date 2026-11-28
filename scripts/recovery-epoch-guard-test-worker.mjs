import { NextgenApplication } from '../worker/app.js';
import { initializeOwnerFence } from '../worker/owner-fence.js';
import { ProjectRegistry } from '../worker/registry.js';
import { assertRecoveryEnvelope, readAnchoredRecoveryScopes, readOwnerRecoveryScopes, validRecoveryStamp } from '../worker/recovery-scopes.js';
import { recoveryEpochConfiguration } from '../worker/recovery-epochs.js';
import { canonicalScopeVectors, noncanonicalScopeVectors } from './recovery-scope-vectors.mjs';

export class RecoveryRegistry extends ProjectRegistry {
  constructor(ctx, env) {
    const marker = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_test_registry_loss'").toArray().length > 0;
    const switched = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_test_registry_switched'").toArray().length > 0;
    const omitted = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_test_registry_omitted'").toArray().length > 0;
    const target = env.NEXTGEN_APPLICATION.idFromName('primary').toString();
    const nextTarget = env.NEXTGEN_APPLICATION.idFromName('stuck').toString();
    super(ctx, omitted ? { ...env, MAPI_RECOVERY_TARGET_OBJECT: nextTarget, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [nextTarget]: 'era-stuck' }) } : switched ? { ...env, MAPI_RECOVERY_TARGET_OBJECT: nextTarget, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [target]: 'era-new', [nextTarget]: 'era-stuck' }) } : marker ? { ...env, MAPI_RECOVERY_TARGET_OBJECT: target, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [target]: 'era-new' }) } : env);
  }
  evict() { this.ctx.abort('simulate registry restart'); }
  tamperScopeForTest(recoveryId, scope, stamp) { this.ctx.storage.sql.exec('UPDATE mapi_recovery_scope_anchors SET stamp = ? WHERE recovery_id = ? AND scope = ?', stamp, recoveryId, scope); }
  tamperScopeKeyForTest(recoveryId, scope, nextScope) { this.ctx.storage.sql.exec('UPDATE mapi_recovery_scope_anchors SET scope = ? WHERE recovery_id = ? AND scope = ?', nextScope, recoveryId, scope); }
  inspectCorruptAnchorForTest(recoveryId, projectId, cursor = null) {
    let largestScope = 0, largestStamp = 0, rejected = false;
    const sql = this.ctx.storage.sql;
    const measured = { exec(query, ...args) {
      const result = sql.exec(query, ...args);
      if (!query.includes('FROM mapi_recovery_scope_anchors')) return result;
      return { toArray() {
        const rows = result.toArray();
        for (const row of rows) {
          if (typeof row.scope === 'string') largestScope = Math.max(largestScope, new TextEncoder().encode(row.scope).length);
          if (typeof row.stamp === 'string') largestStamp = Math.max(largestStamp, new TextEncoder().encode(row.stamp).length);
        }
        return rows;
      } };
    } };
    try { readAnchoredRecoveryScopes(measured, recoveryId, projectId, cursor); } catch { rejected = true; }
    return { rejected, largestScope, largestStamp };
  }
  async simulateAnchorLoss() {
    this.ctx.storage.sql.exec('CREATE TABLE mapi_test_registry_loss (id INTEGER PRIMARY KEY)');
    await this.ctx.storage.sync();
    this.ctx.abort('simulate independent registry restore');
  }
  async simulateTargetSwitch() { this.ctx.storage.sql.exec('CREATE TABLE mapi_test_registry_switched (id INTEGER PRIMARY KEY)'); await this.ctx.storage.sync(); this.ctx.abort('simulate target deployment'); }
  async removeAnchorForTest(projectId) { this.ctx.storage.sql.exec('DELETE FROM mapi_project_recoveries WHERE project_id = ?', projectId); await this.ctx.storage.sync(); this.ctx.abort('simulate missing earlier anchor'); }
  async simulateOmissionForTest() { this.ctx.storage.sql.exec('INSERT INTO mapi_recovery_epoch_deployments VALUES (?, ?)', this.env.NEXTGEN_APPLICATION.idFromName('primary').toString(), 'era-new'); this.ctx.storage.sql.exec('CREATE TABLE mapi_test_registry_omitted (id INTEGER PRIMARY KEY)'); await this.ctx.storage.sync(); this.ctx.abort('simulate omitted epoch'); }
  seedStatusEnvelopeForTest(projectId, recoveryId, epoch, objectId, size) {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("INSERT INTO mapi_project_recoveries (project_id,recovery_id,origin,object_name,object_id,generation,epoch,phase,clock_highwater,clock_kind) VALUES (?, ?, ?, ?, ?, 1, ?, 'anchored', '9007199254740995', 'revision')", projectId, recoveryId, 'https://' + 'x'.repeat(size), 'o'.repeat(size), objectId, epoch);
      sql.exec("INSERT INTO mapi_recovery_scope_progress VALUES (?, ?, ?, 1, ?, 1)", projectId, recoveryId, syntheticScope(projectId, 0), 'a'.repeat(64));
    });
  }
}

export class RecoveryEpochOwner extends NextgenApplication {
  constructor(ctx, env) {
    const sql = ctx.storage.sql;
    const hasMarker = sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_test_recovery_arm'").toArray().length > 0;
    const switched = sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_test_target_switched'").toArray().length > 0;
    const isStuck = ctx.id.toString() === env.OWNER.idFromName('stuck').toString();
    const target = env.OWNER.idFromName(isStuck ? 'stuck' : 'primary').toString();
    const epoch = isStuck ? 'era-stuck' : 'era-new';
    const scoped = ctx.id.toString() !== target || hasMarker;
    const oldTarget = env.OWNER.idFromName('primary').toString(), nextTarget = env.OWNER.idFromName('stuck').toString();
    super(ctx, switched || (isStuck && hasMarker) ? { ...env, MAPI_RECOVERY_TARGET_OBJECT: nextTarget, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [oldTarget]: 'era-new', [nextTarget]: 'era-stuck' }) } : scoped ? { ...env, MAPI_RECOVERY_TARGET_OBJECT: target, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [target]: epoch }) } : env);
  }
  armFence(route) { initializeOwnerFence(this.ctx.storage, route); }
  setEpochForTest(epoch) { this.ctx.storage.sql.exec('UPDATE mapi_recovery_epoch SET epoch = ?', epoch); }
  seedClock() {
    this.ctx.storage.sql.exec('CREATE TABLE mapi_timestamp_clock (id INTEGER PRIMARY KEY, stamp INTEGER NOT NULL)');
    this.ctx.storage.sql.exec("INSERT INTO mapi_timestamp_clock VALUES (1, CAST('9007199254740993' AS INTEGER))");
  }
  seedRevisionClock() {
    this.ctx.storage.sql.exec('CREATE TABLE mapi_revision_clock (id INTEGER PRIMARY KEY CHECK (id = 1), stamp INTEGER NOT NULL)');
    this.ctx.storage.sql.exec("INSERT INTO mapi_revision_clock VALUES (1, CAST('9007199254740995' AS INTEGER))");
    this.ctx.storage.sql.exec('CREATE TABLE mapi_revision_scopes (scope TEXT PRIMARY KEY, stamp INTEGER NOT NULL)');
    this.ctx.storage.sql.exec("INSERT INTO mapi_revision_scopes VALUES (?, CAST('9007199254740994' AS INTEGER))", JSON.stringify({v:1,kind:'project-create',args:null}));
  }
  seedExistingRevisionClock() {
    this.ctx.storage.transactionSync(() => {
      const projectId = this.ctx.storage.sql.exec('SELECT project_id FROM mapi_project').one().project_id;
      this.ctx.storage.sql.exec("UPDATE mapi_revision_clock SET stamp=CAST('9000000000000000000' AS INTEGER) WHERE id=1");
      for (let i = 0; i < 130; i++) this.ctx.storage.sql.exec("INSERT INTO mapi_revision_scopes VALUES (?, CAST('9007199254740995' AS INTEGER))", syntheticScope(projectId, i));
      for (let i = 0; i < 3; i++) this.ctx.storage.sql.exec("INSERT INTO mapi_revision_scopes VALUES (?, CAST('9007199254740997' AS INTEGER))", longScope(projectId, i));
    });
  }
  removeRevisionClocksForTest() { this.ctx.storage.sql.exec('DROP TABLE mapi_revision_scopes'); this.ctx.storage.sql.exec('DROP TABLE mapi_revision_clock'); }
  insertScopeForTest(scope) { this.ctx.storage.sql.exec("INSERT INTO mapi_revision_scopes VALUES (?, CAST('9007199254740994' AS INTEGER))", scope); }
  removeScopeForTest(scope) { this.ctx.storage.sql.exec('DELETE FROM mapi_revision_scopes WHERE scope = ?', scope); }
  addMaximumScopesForTest() {
    const projectId = this.ctx.storage.sql.exec('SELECT project_id FROM mapi_project').one().project_id;
    this.ctx.storage.transactionSync(() => { for (let i = 0; i < 65; i++) this.ctx.storage.sql.exec("INSERT INTO mapi_revision_scopes VALUES (?, CAST('9007199254740994' AS INTEGER))", maximumScope(projectId, i)); });
  }
  measureScopeReadForTest(projectId) {
    const underlying = this.ctx.storage.sql;
    let maxRows = 0;
    const sql = { exec(statement, ...args) {
      const result = underlying.exec(statement, ...args);
      return { one: () => result.one(), toArray: () => { const rows = result.toArray(); if (statement.includes('FROM mapi_revision_scopes')) maxRows = Math.max(maxRows, rows.length); return rows; } };
    } };
    return { maxRows: (() => { readOwnerRecoveryScopes(sql, projectId); return maxRows; })() };
  }
  deleteLegacyClockForTest() { this.ctx.storage.sql.exec('DROP TABLE mapi_timestamp_clock'); }
  clock() { return this.ctx.storage.sql.exec("SELECT printf('%lld', stamp) AS value FROM mapi_revision_clock WHERE id=1").one().value; }
  async simulateRecoveryDeployment() {
    this.ctx.storage.sql.exec('CREATE TABLE mapi_test_recovery_arm (id INTEGER PRIMARY KEY)');
    await this.ctx.storage.sync();
    this.ctx.abort('simulate deployment drain');
  }
  async simulateTargetSwitch() { this.ctx.storage.sql.exec('CREATE TABLE mapi_test_target_switched (id INTEGER PRIMARY KEY)'); await this.ctx.storage.sync(); this.ctx.abort('simulate target deployment'); }
  async simulateRestoredState() {
    this.ctx.storage.transactionSync(() => {
      const projectId = this.ctx.storage.sql.exec('SELECT project_id FROM mapi_project').one().project_id;
      this.ctx.storage.sql.exec("UPDATE mapi_recovery_epoch SET epoch='0'");
      this.ctx.storage.sql.exec("UPDATE mapi_owner_fence SET state='active', generation=1");
      this.ctx.storage.sql.exec('UPDATE mapi_revision_scopes SET stamp=7');
      for (let i = 0; i < 130; i++) this.ctx.storage.sql.exec('DELETE FROM mapi_revision_scopes WHERE scope=?', syntheticScope(projectId, i));
      for (let i = 0; i < 3; i++) this.ctx.storage.sql.exec('DELETE FROM mapi_revision_scopes WHERE scope=?', longScope(projectId, i));
      this.ctx.storage.sql.exec("INSERT INTO mapi_revision_scopes VALUES (?, CAST('8000000000000000000' AS INTEGER))", syntheticScope(projectId, 51));
      this.ctx.storage.sql.exec("UPDATE mapi_revision_clock SET stamp=CAST('8000000000000000000' AS INTEGER)");
    });
    await this.ctx.storage.sync();
    this.ctx.abort('simulate restored owner restart');
  }
  readScopeForTest(index) { const id = this.ctx.storage.sql.exec('SELECT project_id FROM mapi_project').one().project_id; return this.ctx.storage.sql.exec("SELECT printf('%lld', stamp) AS value FROM mapi_revision_scopes WHERE scope=?", syntheticScope(id, index)).toArray()[0]?.value ?? null; }
  readLongScopeForTest(index) { const id = this.ctx.storage.sql.exec('SELECT project_id FROM mapi_project').one().project_id; return this.ctx.storage.sql.exec("SELECT printf('%lld', stamp) AS value FROM mapi_revision_scopes WHERE scope=?", longScope(id, index)).toArray()[0]?.value ?? null; }
  seedInvalidationForTest(projectId) {
    const sql = this.ctx.storage.sql;
    const session = sql.exec('SELECT id FROM sessions WHERE project_id = ? ORDER BY id LIMIT 1', projectId).one().id;
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < 130; i++) {
        const id = String(i).padStart(4, '0');
        sql.exec('INSERT INTO checks (project_id,id,session_id,type) VALUES (?,?,?,?)', projectId, 'check_batch_' + id, session, 1);
        sql.exec("INSERT INTO tokens (project_id,token_id,token_type,session_id,scope,created_at) VALUES (?,?,'session_token',?,'[]',1)", projectId, 'token_batch_' + id, session);
        sql.exec('INSERT INTO auth_attempts (project_id,id,handoff_token,handed_off_at,created_at) VALUES (?,?,?,?,1)', projectId, 'attempt_batch_' + id, new Uint8Array([i,73,84]), 1000000000000);
      }
      for (let i = 0; i < 66; i++) sql.exec("INSERT INTO tokens (project_id,token_id,token_type,session_id,scope,created_at) VALUES (?,?,'session_token','sess_orphan','[]',1)", projectId, 'orphan_' + i);
    });
  }
  invalidationStatsForTest(projectId) {
    const sql = this.ctx.storage.sql, count = q => sql.exec(q, projectId).one().n;
    return { sessions: count('SELECT COUNT(*) n FROM sessions WHERE project_id=?'), checks: count('SELECT COUNT(*) n FROM checks WHERE project_id=? AND session_id IS NOT NULL'), tokens: count('SELECT COUNT(*) n FROM tokens WHERE project_id=? AND session_id IS NOT NULL'), liveTokens: count('SELECT COUNT(*) n FROM tokens t WHERE t.project_id=? AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=t.project_id AND s.id=t.session_id)'), pending: count('SELECT COUNT(*) n FROM auth_attempts WHERE project_id=? AND handed_off_at IS NOT NULL AND handoff_token IS NOT NULL AND handed_off_at <> 1'), attempts: count('SELECT COUNT(*) n FROM auth_attempts WHERE project_id=?'), attemptChecks: count('SELECT COUNT(*) n FROM checks WHERE project_id=? AND auth_attempt_id IS NOT NULL'), events: count('SELECT COUNT(*) n FROM events WHERE project_id=?'), recovery: count("SELECT COUNT(*) n FROM events WHERE project_id=? AND event_type='mapi.recovery.completed'") };
  }
  counts() { return this.testCounts(); }
}
export class BadRecoveryEpochOwner extends NextgenApplication {
  constructor(ctx, env) {
    const target = ctx.id.toString();
    const missing = ctx.id.toString() === env.BAD_OWNER.idFromName('missing').toString();
    super(ctx, { ...env, MAPI_RECOVERY_TARGET_OBJECT: target, MAPI_RECOVERY_OBJECT_EPOCHS: missing ? undefined : '{}' });
  }
}
export class ProductionBlockedRecoveryOwner extends NextgenApplication {
  constructor(ctx, env) { super(ctx, { ...env, MAPI_LOCAL_TEST: '0' }); }
}
const reject = async (fn, expected) => { try { await fn(); } catch (error) { if (!expected || String(error).includes(expected)) return; throw error; } throw Error('Expected rejection'); };
const syntheticScope = (projectId, index) => JSON.stringify({ v: 1, kind: 'team-update', args: [projectId, `synthetic-${String(index).padStart(3, '0')}`] });
const longScope = (projectId, index) => JSON.stringify({ v: 1, kind: 'team-update', args: [projectId, `long-${index}-${'é'.repeat(22000)}`] });
const maximumScope = (projectId, index) => JSON.stringify({ v: 1, kind: 'team-update', args: [projectId, `max-${String(index).padStart(2, '0')}-${'x'.repeat(61000)}`] });
export default {
  async fetch(_request, env) {
    try {
      for (const stamp of ['0', '1', '9223372036854775807']) if (!validRecoveryStamp(stamp)) throw Error('Valid recovery stamp was rejected');
      for (const stamp of ['', '-1', '01', '9223372036854775808', '9'.repeat(100000), null, 1]) if (validRecoveryStamp(stamp)) throw Error('Invalid recovery stamp was accepted');
      const origin = 'https://recovery.example', otherOrigin = 'https://other.example';
      let primary = env.OWNER.getByName('primary');
      const other = env.OWNER.getByName('other');
      let registry = env.PROJECT_REGISTRY.getByName('projects');
      await registry.reserve(origin, 'primary'); await registry.reserve(otherOrigin, 'other');
      const projectId = (await primary.provision('Primary', origin, { projectId: null, origin, objectName: 'primary', generation: 1 })).projectId;
      const otherId = (await other.provision('Other', otherOrigin, { projectId: null, origin: otherOrigin, objectName: 'other', generation: 1 })).projectId;
      const route = { projectId, origin, objectName: 'primary', generation: 1 };
      const otherRoute = { projectId: otherId, origin: otherOrigin, objectName: 'other', generation: 1 };
      await registry.activate(origin, 'primary', projectId); await registry.activate(otherOrigin, 'other', otherId);
      await primary.addUser('primary@example.test', 'Primary-password-123!', route);
      await other.addUser('other@example.test', 'Other-password-123!', otherRoute);
      const session = await primary.login('primary@example.test', 'Primary-password-123!', '127.0.0.1', route);
      if (session.status !== 200) throw Error('Recovery session fixture failed');
      await primary.seedInvalidationForTest(projectId);
      await reject(() => primary.restore('bookmark'), 'Coordinated recovery is required');
      await reject(() => primary.recover(route), 'Coordinated recovery is required');
      await primary.seedExistingRevisionClock();
      await reject(() => primary.restore('bookmark'), 'Coordinated recovery is required');
      await reject(() => primary.recover(route), 'Coordinated recovery is required');
      await other.armFence(otherRoute);
      await reject(() => registry.beginProjectRecovery('wrong', origin, projectId, 'recovery-1', 'era-new'));
      await registry.beginProjectRecovery('secret', origin, projectId, 'recovery-1', 'era-new');
      if ((await registry.resolve(origin)).state !== 'recovering' || (await registry.resolve(otherOrigin)).state !== 'active') throw Error('Recovery did not isolate its route');
      await reject(() => registry.beginRelocation('secret', origin, projectId, 'move-1'), 'Project route is not active');
      await reject(() => other.armRecovery('secret', projectId, 'recovery-1'), 'Recovery is not reserved by registry');
      await reject(() => primary.armRecovery('wrong', projectId, 'recovery-1'), 'Recovery fence adoption is not enabled');
      await primary.setEpochForTest('era-new');
      await reject(() => primary.armRecovery('secret', projectId, 'recovery-1'), 'Recovery epoch is not fresh');
      await primary.setEpochForTest('0');
      await primary.armRecovery('secret', projectId, 'recovery-1');
      await primary.freezeRecovery('secret', projectId, 'recovery-1');
      await primary.armRecovery('secret', projectId, 'recovery-1');
      const anchor = await registry.captureRecoveryClock('secret', projectId, 'recovery-1');
      if (anchor.clock_highwater !== '9000000000000000000' || anchor.phase !== 'anchored' || anchor.clock_kind !== 'revision') throw Error('Recovery clock lost precision');
      let sourceCursor = null, sourcePage;
      do {
        sourcePage = await primary.recoveryScopePage('secret', projectId, 'recovery-1', sourceCursor);
        if (new TextEncoder().encode(JSON.stringify(sourcePage)).length > 128 * 1024 || sourcePage.rows.length > 64) throw Error('Recovery scope page exceeded bounds');
        sourceCursor = sourcePage.cursor;
      } while (!sourcePage.done);
      await reject(() => registry.recoveryScopeSnapshot('secret', projectId, 'recovery-1'), 'Invalid recovery scope checkpoint');
      await reject(() => registry.captureRecoveryScopes('wrong', projectId, 'recovery-1'), 'Relocation control denied');
      const firstCapture = await registry.captureRecoveryScopes('secret', projectId, 'recovery-1');
      if (firstCapture.done || firstCapture.count < 1 || firstCapture.count > 64) throw Error('Recovery capture was not bounded');
      await reject(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName('projects');
      await reject(() => primary.evict()); primary = env.OWNER.getByName('primary');
      let capture;
      do { capture = await registry.captureRecoveryScopes('secret', projectId, 'recovery-1'); } while (!capture.done);
      if (capture.count < 130 || !/^[a-f0-9]{64}$/.test(capture.digest)) throw Error('Recovery scopes were not captured');
      if (JSON.stringify(await registry.captureRecoveryScopes('secret', projectId, 'recovery-1')) !== JSON.stringify(capture)) throw Error('Recovery scope capture retry changed result');
      let snapshotCursor = null, snapshot;
      do { snapshot = await registry.recoveryScopeSnapshot('secret', projectId, 'recovery-1', snapshotCursor); snapshotCursor = snapshot.page.cursor; } while (!snapshot.page.done);
      const tamperTarget = snapshot.page.rows.at(-1);
      if (!tamperTarget) throw Error('Final recovery scope page is empty');
      const firstTarget = (await registry.recoveryScopeSnapshot('secret', projectId, 'recovery-1')).page.rows[0];
      if (!firstTarget) throw Error('First recovery scope page is empty');
      await registry.tamperScopeForTest('recovery-1', firstTarget.scope, '9'.repeat(100000));
      const longStamp = await registry.inspectCorruptAnchorForTest('recovery-1', projectId);
      if (!longStamp.rejected || longStamp.largestStamp > 19) throw Error('Oversized anchor stamp was materialized');
      await reject(() => registry.recoveryScopeSnapshot('secret', projectId, 'recovery-1'), 'Invalid recovery scope stamp');
      await registry.tamperScopeForTest('recovery-1', firstTarget.scope, firstTarget.stamp);
      await registry.tamperScopeForTest('recovery-1', firstTarget.scope, new Uint8Array([49]).buffer);
      if (!(await registry.inspectCorruptAnchorForTest('recovery-1', projectId)).rejected) throw Error('Binary anchor stamp was accepted');
      await reject(() => registry.recoveryScopeSnapshot('secret', projectId, 'recovery-1'), 'Invalid recovery scope stamp');
      await registry.tamperScopeForTest('recovery-1', firstTarget.scope, firstTarget.stamp);
      const hugeKey = '!' + 'x'.repeat(100000);
      await registry.tamperScopeKeyForTest('recovery-1', firstTarget.scope, hugeKey);
      const longScope = await registry.inspectCorruptAnchorForTest('recovery-1', projectId);
      if (!longScope.rejected || longScope.largestScope > 62 * 1024) throw Error('Oversized anchor scope was materialized');
      await reject(() => registry.recoveryScopeSnapshot('secret', projectId, 'recovery-1'), 'Invalid or foreign revision scope');
      await registry.tamperScopeKeyForTest('recovery-1', hugeKey, firstTarget.scope);
      const multibyteKey = '!' + 'é'.repeat(40000);
      await registry.tamperScopeKeyForTest('recovery-1', firstTarget.scope, multibyteKey);
      const longMultibyteScope = await registry.inspectCorruptAnchorForTest('recovery-1', projectId);
      if (!longMultibyteScope.rejected || longMultibyteScope.largestScope > 62 * 1024) throw Error('Oversized multibyte anchor scope was materialized');
      await registry.tamperScopeKeyForTest('recovery-1', multibyteKey, firstTarget.scope);
      const binaryKey = new Uint8Array([120]).buffer;
      await registry.tamperScopeKeyForTest('recovery-1', tamperTarget.scope, binaryKey);
      if (!(await registry.inspectCorruptAnchorForTest('recovery-1', projectId, tamperTarget.scope)).rejected) throw Error('Binary anchor scope was accepted');
      await registry.tamperScopeKeyForTest('recovery-1', binaryKey, tamperTarget.scope);
      if ((await registry.resolve(origin)).state !== 'recovering') throw Error('Invalid anchor reopened recovery route');
      if ((await registry.captureRecoveryClock('secret', projectId, 'recovery-1')).clock_highwater !== anchor.clock_highwater) throw Error('Recovery anchor did not survive registry restart');
      const before = await primary.counts();
      await reject(() => primary.simulateRecoveryDeployment());
      primary = env.OWNER.getByName('primary');
      await reject(() => primary.addUser('old@example.test', 'Old-password-123!', route), 'Project recovery is not reconciled');
      await reject(() => primary.login('primary@example.test', 'Primary-password-123!', '127.0.0.1', route), 'Project recovery is not reconciled');
      await reject(() => primary.simulateRestoredState());
      primary = env.OWNER.getByName('primary');
      await reject(() => primary.addUser('stale@example.test', 'Stale-password-123!', route), 'Project recovery is not reconciled');
      if (JSON.stringify(await primary.counts()) !== JSON.stringify(before)) throw Error('Stale route changed restored data');
      if ((await other.login('other@example.test', 'Other-password-123!', '127.0.0.1', otherRoute)).status !== 200) throw Error('Independent project was affected');
      const noClock = env.OWNER.getByName('no-clock');
      const noClockOrigin = 'https://no-clock.example';
      await registry.reserve(noClockOrigin, 'no-clock');
      const noClockId = (await noClock.provision('No clock', noClockOrigin, { projectId: null, origin: noClockOrigin, objectName: 'no-clock', generation: 1 })).projectId;
      const maxRecoveryId = 'r'.repeat(128), maxEpoch = 'e'.repeat(128);
      await noClock.removeRevisionClocksForTest();
      await registry.activate(noClockOrigin, 'no-clock', noClockId);
      await reject(() => registry.beginProjectRecovery('secret', noClockOrigin, 'p'.repeat(129), maxRecoveryId, maxEpoch), 'Invalid recovery identity');
      await reject(() => registry.beginProjectRecovery('secret', noClockOrigin, noClockId, 'r'.repeat(129), maxEpoch), 'Invalid recovery identity');
      await reject(() => registry.beginProjectRecovery('secret', noClockOrigin, noClockId, maxRecoveryId, 'e'.repeat(129)), 'Invalid recovery identity');
      await registry.beginProjectRecovery('secret', noClockOrigin, noClockId, maxRecoveryId, maxEpoch);
      await noClock.armRecovery('secret', noClockId, maxRecoveryId);
      await noClock.freezeRecovery('secret', noClockId, maxRecoveryId);
      await reject(() => registry.captureRecoveryClock('secret', noClockId, maxRecoveryId), 'Recovery clock is not initialized');
      if ((await registry.resolve(noClockOrigin)).state !== 'recovering') throw Error('Unanchored recovery reopened');
      await reject(() => noClock.restore('bookmark'), 'Coordinated recovery is required');
      await noClock.seedClock();
      await noClock.seedRevisionClock();
      await reject(() => registry.captureRecoveryClock('secret', noClockId, maxRecoveryId), 'Recovery clock is not initialized or is ambiguous');
      await noClock.deleteLegacyClockForTest();
      const revisionAnchor = await registry.captureRecoveryClock('secret', noClockId, maxRecoveryId);
      if (revisionAnchor.clock_kind !== 'revision' || revisionAnchor.clock_highwater !== '9007199254740995') throw Error('Revision clock anchor lost precision');
      if ((await registry.captureRecoveryClock('secret', noClockId, maxRecoveryId)).clock_highwater !== revisionAnchor.clock_highwater) throw Error('Revision clock anchor is not idempotent');
      for (const invalid of [
        JSON.stringify({ v: 1, kind: 'team-update', args: ['proj_foreign', 'x'] }),
        JSON.stringify({ v: 1, kind: 'unknown', args: [noClockId, 'x'] }),
        JSON.stringify({ v: 1, kind: 'team-update', args: [noClockId] }),
        '{"v":1,"v":1,"kind":"project-create","args":null}',
      ]) {
        await noClock.insertScopeForTest(invalid);
        await reject(() => registry.captureRecoveryScopes('secret', noClockId, maxRecoveryId), 'Invalid or foreign revision scope');
        await noClock.removeScopeForTest(invalid);
      }
      for (const invalid of noncanonicalScopeVectors(noClockId)) {
        await noClock.insertScopeForTest(invalid);
        await reject(() => registry.captureRecoveryScopes('secret', noClockId, maxRecoveryId), 'Noncanonical revision scope');
        await noClock.removeScopeForTest(invalid);
      }
      await noClock.insertScopeForTest(String.raw`{"v":1,"kind":"team-update","args":[${JSON.stringify(noClockId)},"\ud800"]}`);
      await reject(() => registry.captureRecoveryScopes('secret', noClockId, maxRecoveryId), 'Invalid or foreign revision scope');
      await noClock.removeScopeForTest(String.raw`{"v":1,"kind":"team-update","args":[${JSON.stringify(noClockId)},"\ud800"]}`);
      for (const canonical of canonicalScopeVectors(noClockId)) await noClock.insertScopeForTest(canonical);
      await noClock.addMaximumScopesForTest();
      if ((await noClock.measureScopeReadForTest(noClockId)).maxRows !== 1) throw Error('Scope query materialized more than one key');
      let maxCapture;
      do { maxCapture = await registry.captureRecoveryScopes('secret', noClockId, maxRecoveryId); } while (!maxCapture.done);
      if (maxCapture.count !== 70) throw Error('Maximum-key recovery capture lost scopes');
      const maxSnapshot = await registry.recoveryScopeSnapshot('secret', noClockId, maxRecoveryId);
      if (new TextEncoder().encode(JSON.stringify(maxSnapshot)).length > 128 * 1024) throw Error('Recovery snapshot RPC envelope exceeded bound');
      const maximumProject = 'proj_' + 'p'.repeat(123), maximumKey = maximumScope(maximumProject, 0);
      const fullEnvelope = { recovery: { object_id: 'a'.repeat(64), epoch: maxEpoch, generation: Number.MAX_SAFE_INTEGER, clock_highwater: '9223372036854775807' }, count: Number.MAX_SAFE_INTEGER, digest: 'a'.repeat(64), page: { rows: [{ scope: maximumKey, stamp: '9223372036854775807' }], cursor: maximumKey, done: false } };
      assertRecoveryEnvelope(fullEnvelope);
      const envelopeRegistry = env.PROJECT_REGISTRY.getByName('status-envelope');
      const envelopeProject = 'proj_' + 'p'.repeat(122) + '1', envelopeRecovery = 'r'.repeat(127) + '1', envelopeEpoch = 'e'.repeat(127) + '1';
      await envelopeRegistry.seedStatusEnvelopeForTest(envelopeProject, envelopeRecovery, envelopeEpoch, 'a'.repeat(63) + '1', 64000);
      const statusEnvelope = await envelopeRegistry.recoveryScopeStatus('secret', envelopeProject, envelopeRecovery);
      const statusBytes = new TextEncoder().encode(JSON.stringify(statusEnvelope)).length;
      if (statusEnvelope.recovery.origin.length < 64000 || statusEnvelope.recovery.object_name.length !== 64000 || statusBytes <= 124 * 1024 || statusBytes > 128 * 1024) throw Error('Maximum recovery status envelope was not preserved');
      const tooLargeProject = 'proj_' + 'p'.repeat(122) + '2', tooLargeRecovery = 'r'.repeat(127) + '2', tooLargeEpoch = 'e'.repeat(127) + '2';
      await envelopeRegistry.seedStatusEnvelopeForTest(tooLargeProject, tooLargeRecovery, tooLargeEpoch, 'a'.repeat(63) + '2', 66000);
      await reject(() => envelopeRegistry.recoveryScopeStatus('secret', tooLargeProject, tooLargeRecovery), 'Recovery RPC envelope exceeds limit');
      await reject(() => primary.stageRecoveryScopes('wrong', projectId, 'recovery-1'), 'Recovery staging is not enabled');
      await reject(() => primary.stageRecoveryScopes('secret', 'proj_missing', 'recovery-1'), 'Recovery staging authority mismatch');
      const firstStage = await primary.stageRecoveryScopes('secret', projectId, 'recovery-1');
      if (firstStage.done || firstStage.phase !== 'validating' || firstStage.count !== 0 || firstStage.digest !== capture.digest) throw Error('Recovery staging was not bounded');
      await reject(() => primary.evict()); primary = env.OWNER.getByName('primary');
      await registry.tamperScopeForTest('recovery-1', tamperTarget.scope, '1');
      let detected = false;
      for (let i = 0; i < 10; i++) {
        try { if ((await primary.stageRecoveryScopes('secret', projectId, 'recovery-1')).done) throw Error('Corrupt anchor was accepted'); }
        catch (error) { if (!String(error).includes('Recovery scope count or digest mismatch')) throw error; detected = true; break; }
      }
      if (!detected || (await registry.resolve(origin)).state !== 'recovering') throw Error('Corrupt anchor did not stay fenced');
      await registry.tamperScopeForTest('recovery-1', tamperTarget.scope, tamperTarget.stamp);
      let staged;
      do { staged = await primary.stageRecoveryScopes('secret', projectId, 'recovery-1'); } while (!staged.done);
      if (staged.count !== capture.count || staged.digest !== capture.digest) throw Error('Recovery scope rehydration was incomplete');
      if ((await primary.stageRecoveryScopes('secret', projectId, 'recovery-1')).count !== staged.count) throw Error('Recovery staging retry changed result');
      if ((await primary.clock()) !== anchor.clock_highwater) throw Error('Recovery clock high-water not restored');
      if ((await primary.readScopeForTest(50)) !== '9007199254740995' || (await primary.readScopeForTest(51)) !== '8000000000000000000') throw Error('Deleted scope was not restored or newer value was overwritten');
      if ((await primary.readLongScopeForTest(2)) !== '9007199254740997') throw Error('Large scope was not restored');
      await reject(() => primary.advanceRecoveryInvalidation('wrong', projectId, 'recovery-1'), 'Recovery invalidation is not enabled');
      await reject(() => primary.advanceRecoveryInvalidation('secret', projectId, 'wrong-id'), 'Recovery scope anchor is incomplete');
      let previousInvalidation = await primary.invalidationStatsForTest(projectId), failedAudit = false, evictedInvalidation = false, doneInvalidation = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        if (!failedAudit && previousInvalidation.sessions === 1 && previousInvalidation.checks === 0 && previousInvalidation.liveTokens === 0) {
          await primary.failNextAudit(1);
          await reject(() => primary.advanceRecoveryInvalidation('secret', projectId, 'recovery-1'));
          if (JSON.stringify(await primary.invalidationStatsForTest(projectId)) !== JSON.stringify(previousInvalidation)) throw Error('Recovery audit failure was not atomic');
          failedAudit = true;
        }
        const step = await primary.advanceRecoveryInvalidation('secret', projectId, 'recovery-1');
        if (step.count !== undefined && step.count > 64) throw Error('Invalidation page exceeded row limit');
        if (!evictedInvalidation && step.phase === 'checks') { await reject(() => primary.evict()); primary = env.OWNER.getByName('primary'); evictedInvalidation = true; }
        previousInvalidation = await primary.invalidationStatsForTest(projectId);
        if (step.done) { doneInvalidation = true; break; }
      }
      if (!doneInvalidation || !failedAudit || !evictedInvalidation || previousInvalidation.sessions || previousInvalidation.checks || previousInvalidation.tokens || previousInvalidation.pending || previousInvalidation.attempts || previousInvalidation.attemptChecks || previousInvalidation.recovery !== 1) throw Error('Recovery invalidation proof failed');
      if (!(await primary.advanceRecoveryInvalidation('secret', projectId, 'recovery-1')).done || (await primary.invalidationStatsForTest(projectId)).recovery !== 1) throw Error('Recovery invalidation was not idempotent');
      await reject(() => primary.addUser('stale-after@example.test', 'Stale-password-123!', route), 'Project recovery is not reconciled');
      await reject(() => primary.addUser('current@example.test', 'Current-password-123!', { ...route, generation: 2 }), 'Project recovery is not reconciled');
      if ((await registry.resolve(origin)).state !== 'recovering') throw Error('Scope rehydration reopened recovery route');
      let stuck = env.OWNER.getByName('stuck');
      const stuckOrigin = 'https://stuck.example';
      await registry.reserve(stuckOrigin, 'stuck');
      const stuckId = (await stuck.provision('Stuck recovery', stuckOrigin, { projectId: null, origin: stuckOrigin, objectName: 'stuck', generation: 1 })).projectId;
      await stuck.seedExistingRevisionClock();
      await registry.activate(stuckOrigin, 'stuck', stuckId);
      await registry.beginProjectRecovery('secret', stuckOrigin, stuckId, 'recovery-stuck', 'era-stuck');
      await stuck.armRecovery('secret', stuckId, 'recovery-stuck'); await stuck.freezeRecovery('secret', stuckId, 'recovery-stuck');
      await registry.captureRecoveryClock('secret', stuckId, 'recovery-stuck');
      let stuckCapture;
      do { stuckCapture = await registry.captureRecoveryScopes('secret', stuckId, 'recovery-stuck'); } while (!stuckCapture.done);
      await reject(() => registry.simulateTargetSwitch()); registry = env.PROJECT_REGISTRY.getByName('projects');
      if ((await registry.resolve(origin)).state !== 'recovering' || (await registry.resolve(stuckOrigin)).state !== 'recovering') throw Error('Recovery target switch lost an anchored route');
      await reject(() => primary.simulateTargetSwitch()); primary = env.OWNER.getByName('primary');
      await reject(() => primary.simulateRestoredState()); primary = env.OWNER.getByName('primary');
      await reject(() => primary.addUser('old-after-switch@example.test', 'Old-password-123!', route), 'Project recovery is not reconciled');
      const firstAnchoredPage = await registry.recoveryScopeSnapshot('secret', stuckId, 'recovery-stuck');
      const earlyTarget = firstAnchoredPage.page.rows[0];
      if (!earlyTarget || earlyTarget.stamp === '1') throw Error('Invalid early corruption target');
      await reject(() => stuck.simulateRecoveryDeployment()); stuck = env.OWNER.getByName('stuck');
      await reject(() => stuck.simulateRestoredState()); stuck = env.OWNER.getByName('stuck');
      if ((await stuck.stageRecoveryScopes('secret', stuckId, 'recovery-stuck')).phase !== 'validating') throw Error('Restored scopes were not validated');
      await registry.tamperScopeForTest('recovery-stuck', earlyTarget.scope, '1');
      let stuckDetected = false;
      for (let i = 0; i < 12; i++) {
        try { if ((await stuck.stageRecoveryScopes('secret', stuckId, 'recovery-stuck')).done) throw Error('Earlier corrupted page was accepted'); }
        catch (error) { if (!String(error).includes('Recovery scope count or digest mismatch')) throw error; stuckDetected = true; break; }
      }
      if (!stuckDetected) throw Error('Earlier corrupted page was not detected');
      await registry.tamperScopeForTest('recovery-stuck', earlyTarget.scope, earlyTarget.stamp);
      await reject(() => stuck.stageRecoveryScopes('secret', stuckId, 'recovery-stuck'), 'Recovery scope count or digest mismatch');
      if ((await registry.resolve(stuckOrigin)).state !== 'recovering') throw Error('Poisoned staging reopened the route');
      await reject(() => stuck.addUser('blocked@example.test', 'Blocked-password-123!', { projectId: stuckId, origin: stuckOrigin, objectName: 'stuck', generation: 2 }), 'Project recovery is not reconciled');
      if ((await other.login('other@example.test', 'Other-password-123!', '127.0.0.2', otherRoute)).status !== 200) throw Error('Recovery corruption affected another project');
      await reject(() => env.BAD_OWNER.getByName('missing').identity(), 'Invalid recovery epoch configuration');
      await reject(() => env.BAD_OWNER.getByName('inconsistent').identity(), 'Invalid recovery epoch configuration');
      await reject(() => env.PRODUCTION_OWNER.getByName('blocked').advanceRecoveryInvalidation('secret', projectId, 'recovery-1'), 'Recovery invalidation is not enabled');
      const lowerId = 'a'.repeat(64), upperId = lowerId.toUpperCase();
      if (recoveryEpochConfiguration({ MAPI_RECOVERY_TARGET_OBJECT: lowerId, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [lowerId]: 'era' }) })[lowerId] !== 'era') throw Error('Canonical object ID was rejected');
      await reject(() => recoveryEpochConfiguration({ MAPI_RECOVERY_TARGET_OBJECT: upperId, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [upperId]: 'era' }) }), 'Invalid recovery epoch configuration');
      await reject(() => recoveryEpochConfiguration({ MAPI_RECOVERY_TARGET_OBJECT: lowerId, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [lowerId]: 'era', [upperId]: 'other' }) }), 'Invalid recovery epoch configuration');
      let lostRegistry = env.PROJECT_REGISTRY.getByName('lost');
      await reject(() => lostRegistry.simulateAnchorLoss());
      lostRegistry = env.PROJECT_REGISTRY.getByName('lost');
      await reject(() => lostRegistry.resolve(origin), 'Registry recovery anchor missing');
      await reject(() => registry.removeAnchorForTest(projectId)); registry = env.PROJECT_REGISTRY.getByName('projects');
      await reject(() => registry.resolve(stuckOrigin), 'Registry recovery anchor missing');
      let omissionRegistry = env.PROJECT_REGISTRY.getByName('omission');
      await reject(() => omissionRegistry.simulateOmissionForTest()); omissionRegistry = env.PROJECT_REGISTRY.getByName('omission');
      await reject(() => omissionRegistry.resolve(stuckOrigin), 'Registry recovery epoch entry missing');
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error), stack: error?.stack }, { status: 500 }); }
  },
};
