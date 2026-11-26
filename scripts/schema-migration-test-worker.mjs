import application, { NextgenApplication } from '../worker/generated/schema-migration-test-app.js';
import { ProjectRegistry } from '../worker/registry.js';
import { RelocationCoordinator } from '../worker/relocation-coordinator.js';
export { RelocationCoordinator };

export class TestRegistry extends ProjectRegistry {
  evict() { this.ctx.abort('registry restart'); }
  seedExistingIntentForTest(route, moveId) {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local relocation test required');
    const current = this.resolve(route.origin);
    if (!current || current.state !== 'active' || current.project_id !== route.projectId || current.object_name !== route.objectName || current.generation !== route.generation) throw Error('Invalid synthetic route');
    this.ctx.storage.sql.exec('INSERT INTO mapi_move_intents VALUES (?, ?, ?, ?, ?, ?)', route.projectId, moveId, route.origin, route.objectName, `project:${crypto.randomUUID()}`, route.generation);
  }
}
export class SchemaOwner extends NextgenApplication {
  #holdApply = false; #applyHeld = false; #releaseApply;
  #holdActivate = false; #activateHeld = false; #releaseActivate;
  #holdBeforeActivate = false; #beforeActivateHeld = false; #releaseBeforeActivate;
  constructor(ctx, env) {
    const sql = ctx.storage.sql;
    const legacyTarget = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'test_schema_v1'").toArray().length;
    const undrained = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'test_schema_undrained'").toArray().length;
    super(ctx, { ...env, ...(legacyTarget ? { MAPI_SCHEMA_TARGET: '1' } : {}), ...(undrained ? { MAPI_FENCE_WRITERS_DRAINED: '0' } : {}) });
  }
  forceVersionOne() { this.ctx.storage.sql.exec('CREATE TABLE test_schema_v1 (value INTEGER)'); }
  prepareVersionTwo(legacy = false, undrained = false) {
    return this.ctx.storage.transactionSync(() => {
      if (legacy) this.ctx.storage.sql.exec('DROP TABLE mapi_owner_fence');
      this.ctx.storage.sql.exec('DROP TABLE test_schema_v1');
      if (undrained) this.ctx.storage.sql.exec('CREATE TABLE test_schema_undrained (value INTEGER)');
    });
  }
  inspectSchema() {
    const sql = this.ctx.storage.sql;
    const version = sql.exec('SELECT version FROM mapi_schema_version').one().version;
    const hasHistory = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_history'").toArray().length;
    const hasFence = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
    const fence = hasFence ? sql.exec('SELECT project_id, origin, object_name, generation, state, move_id FROM mapi_owner_fence').toArray() : [];
    const history = hasHistory ? sql.exec('SELECT version FROM mapi_schema_history ORDER BY version').toArray() : [];
    return { version, fence, history, counts: this.testCounts() };
  }
  holdApply() { this.#holdApply = true; }
  applyHeld() { return this.#applyHeld; }
  releaseApply() { this.#releaseApply(); }
  async applySchemaMigration(...args) {
    const proof = await super.applySchemaMigration(...args);
    if (this.#holdApply) { this.#holdApply = false; this.#applyHeld = true; await new Promise(resolve => { this.#releaseApply = resolve; }); throw Error('Injected lost schema acknowledgement'); }
    return proof;
  }
  holdActivation() { this.#holdActivate = true; }
  activationHeld() { return this.#activateHeld; }
  releaseActivation() { this.#releaseActivate(); }
  holdBeforeActivation() { this.#holdBeforeActivate = true; }
  beforeActivationHeld() { return this.#beforeActivateHeld; }
  releaseBeforeActivation() { this.#releaseBeforeActivate(); }
  async activateSchemaMigration(...args) {
    if (this.#holdBeforeActivate) { this.#holdBeforeActivate = false; this.#beforeActivateHeld = true; await new Promise(resolve => { this.#releaseBeforeActivate = resolve; }); }
    const proof = await super.activateSchemaMigration(...args);
    if (this.#holdActivate) { this.#holdActivate = false; this.#activateHeld = true; await new Promise(resolve => { this.#releaseActivate = resolve; }); throw Error('Injected lost schema activation'); }
    return proof;
  }
}

const check = (v, message) => { if (!v) throw Error(message); };
const rejects = async fn => { try { await fn(); } catch { return; } throw Error('Expected rejection'); };
export default {
  async fetch(_request, env) {
    try {
      let registry = env.PROJECT_REGISTRY.getByName('projects');
      const makeProject = async (name, origin, email) => {
        let owner = env.NEXTGEN_APPLICATION.getByName(name);
        await owner.forceVersionOne(); await rejects(() => owner.evict()); owner = env.NEXTGEN_APPLICATION.getByName(name);
        await registry.reserve(origin, name);
        const projectId = (await owner.provision(name, origin, { projectId: null, origin, objectName: name, generation: 1 })).projectId;
        await registry.activate(origin, name, projectId);
        const route = { projectId, origin, objectName: name, generation: 1 };
        await owner.addUser(email, 'Example-password-123!', route);
        return { owner, route };
      };
      const legacyOrigin = 'https://schema-legacy.example', otherOrigin = 'https://schema-other.example';
      let { owner: legacy, route: legacyRoute } = await makeProject('legacy', legacyOrigin, 'legacy@example.test');
      let { owner: other, route: otherRoute } = await makeProject('other', otherOrigin, 'other@example.test');
      await other.prepareVersionTwo(); await rejects(() => other.evict()); other = env.NEXTGEN_APPLICATION.getByName('other');
      const before = await legacy.inspectSchema();
      await legacy.prepareVersionTwo(true);
      await rejects(() => legacy.evict()); legacy = env.NEXTGEN_APPLICATION.getByName('legacy');
      const blocked = await legacy.inspectSchema();
      check(blocked.version === 1 && blocked.fence.length === 0 && blocked.history.length === 0 && JSON.stringify(blocked.counts) === JSON.stringify(before.counts), 'Legacy constructor changed data or schema');
      const ready = await application.fetch(new Request(`${legacyOrigin}/readyz`), { ...env, MAPI_APP_ORIGIN: legacyOrigin });
      check(ready.status === 200, `Supported v1 owner HTTP returned ${ready.status}`);
      await rejects(() => legacy.schemaMigrationReadiness('wrong', legacyRoute, '0'));
      await rejects(() => legacy.schemaMigrationReadiness('schema-secret', { ...legacyRoute, generation: 2 }, '0'));
      await rejects(() => legacy.schemaMigrationReadiness('schema-secret', legacyRoute, 'wrong-epoch'));
      await rejects(() => legacy.applySchemaMigration('schema-secret', legacyRoute.projectId, 'no-intent'));
      await rejects(() => registry.advanceSchemaMigration('wrong', legacyOrigin, legacyRoute.projectId, 'legacy-schema'));
      check(await registry.schemaMigrationStatus('schema-secret', legacyRoute.projectId) === null, 'Denied request created an intent');
      await legacy.failSchemaAfterDDL();
      await rejects(() => registry.advanceSchemaMigration('schema-secret', legacyOrigin, legacyRoute.projectId, 'legacy-schema'));
      const rolledBack = await legacy.inspectSchema();
      check(rolledBack.version === 1 && rolledBack.fence.length === 0 && rolledBack.history.length === 0 && JSON.stringify(rolledBack.counts) === JSON.stringify(before.counts), 'Schema DDL or fence did not roll back');
      check((await registry.resolve(legacyOrigin)).state === 'active' && (await registry.schemaMigrationStatus('schema-secret', legacyRoute.projectId)).phase === 'reserved', 'Rolled-back schema reservation closed ingress');
      await rejects(() => registry.beginRelocation('relocation-secret', legacyOrigin, legacyRoute.projectId, 'conflicting-move'));
      await rejects(() => registry.beginProjectRecovery('relocation-secret', legacyOrigin, legacyRoute.projectId, 'conflicting-recovery', 'era-new'));
      await rejects(() => legacy.evict()); legacy = env.NEXTGEN_APPLICATION.getByName('legacy');
      await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName('projects');
      const completed = await registry.advanceSchemaMigration('schema-secret', legacyOrigin, legacyRoute.projectId, 'legacy-schema');
      check(completed.phase === 'complete' && (await registry.resolve(legacyOrigin)).state === 'active', 'Legacy migration did not resume');
      const after = await legacy.inspectSchema();
      check(after.version === 2 && after.history.length === 1 && after.history[0].version === 2 && after.fence.length === 1 && after.fence[0].state === 'active' && JSON.stringify(after.counts) === JSON.stringify(before.counts), 'Legacy migration changed identity data or audit');
      const legacyNext = { ...legacyRoute, generation: 2 };
      check((await legacy.login('legacy@example.test', 'Example-password-123!', '127.0.0.1', legacyNext)).status === 200, 'Legacy credentials did not survive');
      await rejects(() => legacy.addUser('stale@example.test', 'Stale-password-123!', legacyRoute));
      check((await registry.advanceSchemaMigration('schema-secret', legacyOrigin, legacyRoute.projectId, 'legacy-schema')).phase === 'complete', 'Completed migration retry failed');
      await rejects(() => registry.advanceSchemaMigration('schema-secret', legacyOrigin, legacyRoute.projectId, 'other-schema'));

      const fencedOrigin = 'https://schema-fenced.example';
      let { owner: fenced, route: fencedRoute } = await makeProject('fenced', fencedOrigin, 'fenced@example.test');
      const fencedBefore = await fenced.inspectSchema();
      await fenced.prepareVersionTwo(); await rejects(() => fenced.evict()); fenced = env.NEXTGEN_APPLICATION.getByName('fenced');
      await fenced.holdApply();
      const migrating = registry.advanceSchemaMigration('schema-secret', fencedOrigin, fencedRoute.projectId, 'fenced-schema').then(() => false, () => true);
      while (!await fenced.applyHeld()) await new Promise(resolve => setTimeout(resolve, 5));
      const frozen = await fenced.inspectSchema();
      check(frozen.version === 2 && frozen.fence[0].state === 'frozen' && (await registry.resolve(fencedOrigin)).state === 'active', 'Schema owner was not frozen before registry commit');
      await rejects(() => fenced.addUser('cached@example.test', 'Cached-password-123!', fencedRoute));
      await other.addUser('other-again@example.test', 'Example-password-123!', otherRoute);
      await fenced.releaseApply(); check(await migrating, 'Lost schema acknowledgement was not observed');
      await rejects(() => fenced.evict()); fenced = env.NEXTGEN_APPLICATION.getByName('fenced');
      await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName('projects');
      await rejects(() => fenced.addUser('restart@example.test', 'Restart-password-123!', fencedRoute));
      check((await registry.advanceSchemaMigration('schema-secret', fencedOrigin, fencedRoute.projectId, 'fenced-schema')).phase === 'complete', 'Fenced migration did not resume');
      const fencedAfter = await fenced.inspectSchema();
      check(fencedAfter.version === 2 && fencedAfter.fence[0].state === 'active' && fencedAfter.history.length === 1 && JSON.stringify(fencedAfter.counts) === JSON.stringify(fencedBefore.counts), 'Fenced migration changed business or audit rows');
      check((await other.testCounts()).users === 2 && (await other.inspectSchema()).version === 1, 'Other v1 project was affected under global target 2');

      const activationOrigin = 'https://schema-activation.example';
      let { owner: activation, route: activationRoute } = await makeProject('activation', activationOrigin, 'activation@example.test');
      const activationBefore = await activation.inspectSchema();
      await activation.prepareVersionTwo(); await rejects(() => activation.evict()); activation = env.NEXTGEN_APPLICATION.getByName('activation');
      await activation.holdBeforeActivation(); await activation.holdActivation();
      const activating = registry.advanceSchemaMigration('schema-secret', activationOrigin, activationRoute.projectId, 'activation-schema').then(() => false, () => true);
      while (!await activation.beforeActivationHeld()) await new Promise(resolve => setTimeout(resolve, 5));
      const activationNext = { ...activationRoute, generation: 2 };
      const published = await registry.resolve(activationOrigin);
      check((await registry.schemaMigrationStatus('schema-secret', activationRoute.projectId)).phase === 'committed' && published.state === 'active' && published.generation === 2, 'New route was not published before activation');
      await rejects(() => activation.addUser('old-before@example.test', 'Stale-password-123!', activationRoute));
      await rejects(() => activation.addUser('new-before@example.test', 'Stale-password-123!', activationNext));
      await rejects(() => registry.beginRelocation('relocation-secret', activationOrigin, activationRoute.projectId, 'during-activation-move'));
      await rejects(() => registry.beginProjectRecovery('relocation-secret', activationOrigin, activationRoute.projectId, 'during-activation-recovery', 'during-activation-era'));
      check(JSON.stringify((await activation.inspectSchema()).counts) === JSON.stringify(activationBefore.counts), 'Frozen activation gap changed rows');
      check((await application.fetch(new Request(`${activationOrigin}/readyz`), { ...env, MAPI_APP_ORIGIN: activationOrigin })).status === 503, 'Frozen published route did not fail unavailable');
      await activation.releaseBeforeActivation();
      while (!await activation.activationHeld()) await new Promise(resolve => setTimeout(resolve, 5));
      check((await registry.schemaMigrationStatus('schema-secret', activationRoute.projectId)).phase === 'committed' && (await registry.resolve(activationOrigin)).state === 'active', 'Activated route was not authoritative');
      await rejects(() => activation.addUser('stale@example.test', 'Stale-password-123!', activationRoute));
      await activation.addUser('valid-after@example.test', 'Valid-password-123!', activationNext);
      await rejects(() => registry.beginRelocation('relocation-secret', activationOrigin, activationRoute.projectId, 'after-activation-move'));
      await rejects(() => registry.beginProjectRecovery('relocation-secret', activationOrigin, activationRoute.projectId, 'after-activation-recovery', 'after-activation-era'));
      const activationAccepted = await activation.inspectSchema();
      check(activationAccepted.counts.users === activationBefore.counts.users + 1 && activationAccepted.counts.events > activationBefore.counts.events, 'Published route did not admit the new tuple');
      await activation.releaseActivation(); check(await activating, 'Lost activation acknowledgement was not observed');
      await rejects(() => activation.evict()); activation = env.NEXTGEN_APPLICATION.getByName('activation');
      await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName('projects');
      await rejects(() => activation.addUser('stale-restart@example.test', 'Stale-password-123!', activationRoute));
      check(await activation.admitLogin(activationNext), 'Published generation was rejected after restart');
      await rejects(() => registry.beginRelocation('relocation-secret', activationOrigin, activationRoute.projectId, 'restart-activation-move'));
      await rejects(() => registry.beginProjectRecovery('relocation-secret', activationOrigin, activationRoute.projectId, 'restart-activation-recovery', 'restart-activation-era'));
      check((await registry.advanceSchemaMigration('schema-secret', activationOrigin, activationRoute.projectId, 'activation-schema')).phase === 'complete', 'Activation retry failed');
      check(JSON.stringify((await activation.inspectSchema()).counts) === JSON.stringify(activationAccepted.counts), 'Activation retry changed rows');

      const undrainedOrigin = 'https://schema-undrained.example';
      let { owner: undrained, route: undrainedRoute } = await makeProject('undrained', undrainedOrigin, 'undrained@example.test');
      await undrained.prepareVersionTwo(true, true); await rejects(() => undrained.evict()); undrained = env.NEXTGEN_APPLICATION.getByName('undrained');
      await rejects(() => registry.advanceSchemaMigration('schema-secret', undrainedOrigin, undrainedRoute.projectId, 'undrained-schema'));
      check(await registry.schemaMigrationStatus('schema-secret', undrainedRoute.projectId) === null && (await undrained.inspectSchema()).version === 1, 'Undrained owner began migration');
      const otherSession = await other.login('other@example.test', 'Example-password-123!', '127.0.0.1', otherRoute);
      check(otherSession.status === 200, 'Other project login failed under global target 2');
      const coordinator = env.COORDINATOR.getByName('schema-global-move');
      const moveProject = async (source, route, moveId, expectedVersion, email) => {
        const sourceBefore = await source.inspectSchema();
        await registry.seedExistingIntentForTest(route, moveId);
        let archiveRejected = false;
        for (let i = 0; i < 2000; i++) {
          const [step, traffic] = await Promise.allSettled([
            coordinator.advance('relocation-secret', route.origin, route.projectId, moveId),
            other.session(otherSession.cookie, 'read', '', otherRoute),
          ]);
          check(traffic.status === 'fulfilled' && traffic.value.status === 200, 'Other project session failed during global-target move');
          if (step.status === 'rejected') {
            if (!String(step.reason).includes('independent archive proof is not configured')) throw step.reason;
            archiveRejected = true; break;
          }
          check(!step.value.done, 'Relocation unexpectedly bypassed archive gate');
        }
        check(archiveRejected, 'Global-target relocation did not reach archive gate');
        const status = await registry.relocationStatus('relocation-secret', route.projectId);
        check(status.move?.phase === 'moving' && (await registry.resolve(route.origin)).state === 'moving', 'Archive refusal changed route');
        const frozen = await source.inspectSchema();
        check(frozen.fence.length === 1 && frozen.fence[0].state === 'frozen' && JSON.stringify(frozen.counts) === JSON.stringify(sourceBefore.counts), 'Archive refusal changed source data or fence');
        const destination = env.NEXTGEN_APPLICATION.getByName(status.move.destination_object);
        const destinationRoute = { ...route, objectName: status.move.destination_object, generation: route.generation + 1 };
        const moved = await destination.inspectSchema();
        check(moved.version === expectedVersion && moved.history.length === (expectedVersion === 2 ? 1 : 0) && JSON.stringify(moved.counts) === JSON.stringify(sourceBefore.counts), 'Destination schema or business data differs from source');
        check(await destination.identity() === route.projectId, 'Relocation changed project ID');
        await rejects(() => destination.login(email, 'Example-password-123!', '127.0.0.1', destinationRoute));
      };
      await moveProject(legacy, legacyNext, 'global-v2-move', 2, 'legacy@example.test');
      const v1Origin = 'https://schema-unmigrated.example';
      let { owner: v1Source, route: v1Route } = await makeProject('unmigrated', v1Origin, 'unmigrated@example.test');
      await v1Source.prepareVersionTwo(); await rejects(() => v1Source.evict()); v1Source = env.NEXTGEN_APPLICATION.getByName('unmigrated');
      check((await v1Source.inspectSchema()).version === 1, 'Unmigrated source changed version under global target');
      await moveProject(v1Source, v1Route, 'global-v1-move', 1, 'unmigrated@example.test');
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error), stack: error.stack }, { status: 500 }); }
  },
};
