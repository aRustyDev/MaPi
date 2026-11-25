import app, { NextgenApplication } from "../worker/app.js";
import { ProjectRegistry } from "../worker/registry.js";
import { validateRelocationSourceSchema } from "../worker/relocation-manifest.js";

export class TestRegistry extends ProjectRegistry {
  evict() { this.ctx.abort("registry restart"); }
  setLegacyPreflight(projectId, version, done, tableCount) {
    const sql = this.ctx.storage.sql;
    const row = sql.exec('SELECT * FROM mapi_move_text_preflight WHERE project_id = ?', projectId).one();
    const cursor = { version, table: done ? tableCount : 0, after: null, row: null, column: 0, length: null, offset: 0, remaining: 0, minimum: 128, maximum: 191, done };
    // v2 was an intermediate local format, reconstructed from its known fields.
    if (version >= 2) cursor.rowBytes = 0;
    if (version >= 3) cursor.cursorBytes = 2;
    sql.exec('UPDATE mapi_move_text_preflight SET cursor = ?, done = ? WHERE project_id = ?', JSON.stringify(cursor), done ? 1 : 0, projectId);
    return row;
  }
  setLegacyJournal(projectId, moveId, present) {
    if (present) this.ctx.storage.sql.exec('INSERT INTO mapi_move_journals VALUES (?, ?, 0)', moveId, projectId);
    else this.ctx.storage.sql.exec('DELETE FROM mapi_move_journals WHERE move_id = ? AND project_id = ?', moveId, projectId);
  }
  setTestGeneration(projectId, generation) {
    this.ctx.storage.sql.exec('UPDATE project_routes SET generation = CAST(? AS INTEGER) WHERE project_id = ?', generation, projectId);
  }
}

export class TestOwner extends NextgenApplication {
  constructor(ctx, env) {
    const target = env.NEXTGEN_APPLICATION.idFromName('configured-epoch-source').toString();
    const collisionTarget = env.NEXTGEN_APPLICATION.idFromName('epoch-utf8-source').toString();
    super(ctx, ctx.id.toString() === target ? { ...env, MAPI_RECOVERY_TARGET_OBJECT: target, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [target]: 'fixture-era' }) } : ctx.id.toString() === collisionTarget ? { ...env, MAPI_RECOVERY_EPOCH: '\uFFFD' } : env);
  }
  #hold = false;
  #held = false;
  #release;
  #holdAdd = false;
  #addHeld = false;
  #releaseAdd;
  #failAdd = false;
  #heldAdmins = new Set();
  #holdAdmins = new Set();
  #releaseAdmins = new Map();
  #holdLogin = false;
  #loginHeld = false;
  #releaseLogin;
  #holdSessions = new Set();
  #heldSessions = new Set();
  #releaseSessions = new Map();
  #nextLoginStatus = null;
  #nextSessionStatus = new Map();
  addUnsupportedSchema() { this.ctx.storage.sql.exec("CREATE TABLE unsupported_source_schema (id INTEGER PRIMARY KEY)"); }
  addLegacyTransferState() { this.ctx.storage.sql.exec('CREATE TABLE mapi_chunk_export (test INTEGER)'); this.ctx.storage.sql.exec('INSERT INTO mapi_chunk_export VALUES (1)'); }
  removeLegacyTransferState() { this.ctx.storage.sql.exec('DROP TABLE mapi_chunk_export'); }
  removeUnsupportedSchema() { this.ctx.storage.sql.exec("DROP TABLE unsupported_source_schema"); }
  addOversizedSchemaDefinition() { this.ctx.storage.sql.exec(`CREATE TABLE oversized_source_schema (id INTEGER /* ${'x'.repeat(17000)} */ PRIMARY KEY)`); }
  removeOversizedSchemaDefinition() { this.ctx.storage.sql.exec('DROP TABLE oversized_source_schema'); }
  addOversizedSchemaIdentifier() { this.ctx.storage.sql.exec(`CREATE TABLE "${'é'.repeat(513)}" (id INTEGER PRIMARY KEY)`); }
  removeOversizedSchemaIdentifier() { this.ctx.storage.sql.exec(`DROP TABLE "${'é'.repeat(513)}"`); }
  addManyUnsupportedSchemaObjects() { for (let i = 0; i < 300; i++) this.ctx.storage.sql.exec(`CREATE TABLE test_extra_schema_${i} (id INTEGER PRIMARY KEY)`); }
  removeManyUnsupportedSchemaObjects() { for (let i = 0; i < 300; i++) this.ctx.storage.sql.exec(`DROP TABLE test_extra_schema_${i}`); }
  setTestSchemaVersion(version) { this.ctx.storage.sql.exec("UPDATE mapi_schema_version SET version = ?", version); }
  addTestSchemaVersion(version) { this.ctx.storage.sql.exec("INSERT INTO mapi_schema_version VALUES (?)", version); }
  removeTestSchemaVersion(version) { this.ctx.storage.sql.exec("DELETE FROM mapi_schema_version WHERE version = ?", version); }
  testRecoveryEpoch() { return this.ctx.storage.sql.exec("SELECT epoch FROM mapi_recovery_epoch").one().epoch; }
  seedConfiguredTestEpoch() { this.ctx.storage.sql.exec("CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL)"); this.ctx.storage.sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('fixture-era')"); }
  setTestRecoveryEpoch(value) { this.ctx.storage.sql.exec("UPDATE mapi_recovery_epoch SET epoch = ?", value); }
  setMalformedTestRecoveryEpoch() { this.ctx.storage.sql.exec("UPDATE mapi_recovery_epoch SET epoch = CAST(X'80' AS TEXT)"); }
  testRecoveryEpochBytes() { return this.ctx.storage.sql.exec('SELECT hex(CAST(epoch AS BLOB)) AS bytes FROM mapi_recovery_epoch').one().bytes; }
  addTestRecoveryEpoch(value) { this.ctx.storage.sql.exec("INSERT INTO mapi_recovery_epoch (epoch) VALUES (?)", value); }
  removeTestRecoveryEpoch(value) { this.ctx.storage.sql.exec("DELETE FROM mapi_recovery_epoch WHERE epoch = ?", value); }
  addTestOrigin(value) { this.ctx.storage.sql.exec("INSERT INTO mapi_project_origin (origin) VALUES (?)", value); }
  removeTestOrigin(value) { this.ctx.storage.sql.exec("DELETE FROM mapi_project_origin WHERE origin = ?", value); }
  setOversizedOwnerIdentity() { this.ctx.storage.sql.exec('UPDATE mapi_project SET project_id = ?', 'x'.repeat(256 * 1024)); }
  restoreOwnerIdentity(projectId) { this.ctx.storage.sql.exec('UPDATE mapi_project SET project_id = ?', projectId); }
  setBlobOwnerIdentity() { this.ctx.storage.sql.exec("UPDATE mapi_project SET project_id = X'70726f6a' "); }
  setOversizedOrigin() { this.ctx.storage.sql.exec('UPDATE mapi_project_origin SET origin = ?', 'x'.repeat(256 * 1024)); }
  restoreOrigin(origin) { this.ctx.storage.sql.exec('UPDATE mapi_project_origin SET origin = ?', origin); }
  addForeignProject() { this.ctx.storage.sql.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_foreign_test', 'Foreign', 1, 1)"); }
  removeForeignProject() { this.ctx.storage.sql.exec("DELETE FROM projects WHERE id = 'proj_foreign_test'"); }
  removeOwnerIdentity() {
    const row = this.ctx.storage.sql.exec("SELECT project_id, schema_url FROM mapi_project").one();
    this.ctx.storage.sql.exec("DELETE FROM mapi_project WHERE project_id = ?", row.project_id);
    return row;
  }
  deleteOwnerIdentity(projectId) { this.ctx.storage.sql.exec("DELETE FROM mapi_project WHERE project_id = ?", projectId); }
  insertOwnerIdentity(row) { this.ctx.storage.sql.exec("INSERT INTO mapi_project (project_id, schema_url) VALUES (?, ?)", row.project_id, row.schema_url); }
  ownerFence() {
    const sql = this.ctx.storage.sql;
    return sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length ? sql.exec("SELECT * FROM mapi_owner_fence").toArray() : null;
  }
  setTestOwnerGeneration(generation) { this.ctx.storage.sql.exec('UPDATE mapi_owner_fence SET generation = CAST(? AS INTEGER) WHERE singleton = 1', generation); }
  removeTestRevisionClock() {
    const row = this.ctx.storage.sql.exec("SELECT printf('%lld', stamp) AS stamp FROM mapi_revision_clock WHERE id = 1").one();
    this.ctx.storage.sql.exec("DELETE FROM mapi_revision_clock WHERE id = 1");
    return row.stamp;
  }
  restoreTestRevisionClock(stamp) { this.ctx.storage.sql.exec("INSERT INTO mapi_revision_clock (id, stamp) VALUES (1, CAST(? AS INTEGER))", stamp); }
  setTestRevisionValue(kind) {
    const values = { zero: '0', maximum: '9223372036854775807', real: '1.5', text: "'not-an-integer'", blob: "X'01'" };
    if (!Object.hasOwn(values, kind)) throw Error('Unknown clock test value');
    this.ctx.storage.sql.exec(`UPDATE mapi_revision_clock SET stamp = ${values[kind]} WHERE id = 1`);
  }
  validateTestSourceSchema(route) { validateRelocationSourceSchema(this.ctx.storage, route); }
  textPreflightTableCount(route) { return validateRelocationSourceSchema(this.ctx.storage, route, { textGuard: true }).length; }
  dropTestRevisionScopes() { this.ctx.storage.sql.exec("DROP TABLE mapi_revision_scopes"); }
  holdNextProof() { this.#hold = true; }
  proofHeld() { return this.#held; }
  releaseProof() { this.#release(); }
  holdNextAdd() { this.#holdAdd = true; }
  addHeld() { return this.#addHeld; }
  releaseAdd() { this.#releaseAdd(); }
  failNextAdd() { this.#failAdd = true; }
  holdAdmin(kind) { this.#holdAdmins.add(kind); }
  adminHeld(kind) { return this.#heldAdmins.has(kind); }
  releaseAdmin(kind) { this.#releaseAdmins.get(kind)(); }
  async #maybeHoldAdmin(kind) {
    if (this.#holdAdmins.delete(kind)) {
      this.#heldAdmins.add(kind);
      await new Promise(resolve => this.#releaseAdmins.set(kind, resolve));
    }
  }
  async oauthAdmin(...args) { await this.#maybeHoldAdmin("oauth"); return super.oauthAdmin(...args); }
  async flowRelease(...args) { await this.#maybeHoldAdmin("flow"); return super.flowRelease(...args); }
  holdLogin() { this.#holdLogin = true; }
  loginHeld() { return this.#loginHeld; }
  releaseLogin() { this.#releaseLogin(); }
  holdSession(kind) { this.#holdSessions.add(kind); }
  sessionHeld(kind) { return this.#heldSessions.has(kind); }
  releaseSession(kind) { this.#releaseSessions.get(kind)(); }
  nextLoginStatus(status) { this.#nextLoginStatus = status; }
  nextSessionStatus(kind, status) { this.#nextSessionStatus.set(kind, status); }
  async login(...args) {
    if (this.#holdLogin) { this.#holdLogin = false; this.#loginHeld = true; await new Promise(resolve => { this.#releaseLogin = resolve; }); }
    if (this.#nextLoginStatus !== null) { const status = this.#nextLoginStatus; this.#nextLoginStatus = null; return { status }; }
    return super.login(...args);
  }
  async session(...args) {
    const kind = args[1];
    if (this.#holdSessions.delete(kind)) { this.#heldSessions.add(kind); await new Promise(resolve => this.#releaseSessions.set(kind, resolve)); }
    if (this.#nextSessionStatus.has(kind)) { const status = this.#nextSessionStatus.get(kind); this.#nextSessionStatus.delete(kind); return { status, headers: {}, data: null }; }
    return super.session(...args);
  }
  businessSnapshot() {
    const sql = this.ctx.storage.sql;
    return {
      counts: this.testCounts(),
      sessions: sql.exec("SELECT id, printf('%lld',created_at) AS created, printf('%lld',updated_at) AS updated, printf('%lld',time_to_live) AS ttl, token_id, user_id FROM sessions ORDER BY id").toArray(),
      attempts: sql.exec("SELECT COUNT(*) AS n FROM auth_attempts").one().n,
      throttle: sql.exec("SELECT key, window, count FROM mapi_login_limits ORDER BY key").toArray(),
    };
  }
  async addUser(...args) {
    if (this.#holdAdd) {
      this.#holdAdd = false;
      this.#addHeld = true;
      await new Promise(resolve => { this.#releaseAdd = resolve; });
    }
    if (this.#failAdd) { this.#failAdd = false; throw Error("Injected non-fence application failure"); }
    return super.addUser(...args);
  }
  async preFreezeRelocation(secret, route, moveId, marker) {
    const proof = await super.preFreezeRelocation(secret, route, moveId, marker);
    if (this.#hold) {
      this.#hold = false;
      this.#held = true;
      await new Promise(resolve => { this.#release = resolve; });
      throw new Error("Injected lost freeze acknowledgement");
    }
    return proof;
  }
}

const check = (value, message) => { if (!value) throw Error(message); };
const rejects = async fn => { try { await fn(); } catch { return; } throw Error("Expected rejection"); };
export default {
  async fetch(_request, env) {
    try {
      let registry = env.PROJECT_REGISTRY.getByName("projects");
      const beginRelocation = async (...args) => {
        for (let page = 0; page < 10000; page++) {
          const result = await registry.beginRelocation(...args);
          if (result.phase !== 'preflighting') return result;
        }
        throw Error('TEXT preflight exceeded test page limit');
      };
      let owner = env.NEXTGEN_APPLICATION.getByName("source");
      const other = env.NEXTGEN_APPLICATION.getByName("other");
      const origin = "https://source.example", otherOrigin = "https://other.example";
      await registry.reserve(origin, "source"); await registry.reserve(otherOrigin, "other");
      const projectId = (await owner.provision("Source", origin, { projectId: null, origin, objectName: "source", generation: 1 })).projectId;
      const otherId = (await other.provision("Other", otherOrigin, { projectId: null, origin: otherOrigin, objectName: "other", generation: 1 })).projectId;
      await registry.activate(origin, "source", projectId); await registry.activate(otherOrigin, "other", otherId);
      const route = { projectId, origin, objectName: "source", generation: 1 };
      const otherRoute = { projectId: otherId, origin: otherOrigin, objectName: "other", generation: 1 };
      const postUser = (target, email) => app.fetch(new Request(`${target}/_mapi/admin/users`, { method: "POST", headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: JSON.stringify({ email, password: "Synthetic-password-123!" }) }), env);
      const postAdmin = (target, path, body = {}) => app.fetch(new Request(`${target}${path}`, { method: "POST", headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: JSON.stringify(body) }), env);
      const ready = target => app.fetch(new Request(`${target}/api/v1/readyz`), env);
      const login = (target, email, password) => app.fetch(new Request(`${target}/login`, { method: "POST", headers: { origin: target, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password }) }), env);
      const appPage = (target, cookie = "") => app.fetch(new Request(`${target}/app`, { headers: { cookie } }), env);
      const logout = (target, cookie, csrf) => app.fetch(new Request(`${target}/logout`, { method: "POST", headers: { origin: target, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) }), env);
      // Invalid UTF-8 can otherwise decode to the same replacement character
      // as a valid configured epoch. Neither readiness nor login may accept it.
      const collisionOrigin = 'https://epoch-utf8.example', collisionName = 'epoch-utf8-source';
      const collisionOwner = env.NEXTGEN_APPLICATION.getByName(collisionName);
      await registry.reserve(collisionOrigin, collisionName);
      const collisionId = (await collisionOwner.provision('Epoch UTF-8', collisionOrigin, { projectId: null, origin: collisionOrigin, objectName: collisionName, generation: 1 })).projectId;
      await registry.activate(collisionOrigin, collisionName, collisionId);
      const collisionRoute = { projectId: collisionId, origin: collisionOrigin, objectName: collisionName, generation: 1 };
      await collisionOwner.setTestRecoveryEpoch('\uFFFD');
      check((await collisionOwner.status(false, collisionRoute)).recoveryReady && await collisionOwner.admitLogin(collisionRoute), 'Valid UTF-8 recovery epoch was rejected');
      const collisionFence = await collisionOwner.ownerFence(), collisionBusiness = await collisionOwner.businessSnapshot();
      await collisionOwner.setMalformedTestRecoveryEpoch();
      check(!(await collisionOwner.status(false, collisionRoute)).recoveryReady, 'Malformed UTF-8 recovery epoch reported ready');
      check(!(await collisionOwner.admitLogin(collisionRoute)), 'Malformed UTF-8 recovery epoch admitted login');
      check(await collisionOwner.testRecoveryEpochBytes() === '80' && JSON.stringify(await collisionOwner.ownerFence()) === JSON.stringify(collisionFence) && JSON.stringify(await collisionOwner.businessSnapshot()) === JSON.stringify(collisionBusiness), 'Malformed epoch check changed owner state');
      // A route at the maximum exactly representable generation cannot be
      // moved again; reject before freezing the only live owner.
      const maximumOrigin = 'https://max-generation.example', maximumName = 'max-generation-source';
      const maximumOwner = env.NEXTGEN_APPLICATION.getByName(maximumName);
      await registry.reserve(maximumOrigin, maximumName);
      const maximumId = (await maximumOwner.provision('Maximum generation', maximumOrigin, { projectId: null, origin: maximumOrigin, objectName: maximumName, generation: 1 })).projectId;
      await registry.activate(maximumOrigin, maximumName, maximumId);
      await registry.setTestGeneration(maximumId, '9007199254740991');
      await maximumOwner.setTestOwnerGeneration('9007199254740991');
      // Progress remains valid across both object evictions, and a real Go
      // mutation invalidates the marker before a later page can reuse it.
      const progressOrigin = 'https://progress.example', progressName = 'progress-source';
      let progressOwner = env.NEXTGEN_APPLICATION.getByName(progressName);
      await registry.reserve(progressOrigin, progressName);
      const progressId = (await progressOwner.provision('Progress', progressOrigin, { projectId: null, origin: progressOrigin, objectName: progressName, generation: 1 })).projectId;
      await registry.activate(progressOrigin, progressName, progressId);
      const progressRoute = { projectId: progressId, origin: progressOrigin, objectName: progressName, generation: 1 };
      check((await registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move')).phase === 'preflighting', 'First page did not preserve active route');
      const beforeEviction = await registry.relocationTextPreflightStatus('move-secret', progressId, 'progress-move');
      check(beforeEviction && !beforeEviction.done, 'Initial progress missing');
      await rejects(() => progressOwner.evict()); progressOwner = env.NEXTGEN_APPLICATION.getByName(progressName);
      await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName('projects');
      check(JSON.stringify(await registry.relocationTextPreflightStatus('move-secret', progressId, 'progress-move')) === JSON.stringify(beforeEviction), 'Checkpoint changed after eviction');
      await registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move');
      const afterEviction = await registry.relocationTextPreflightStatus('move-secret', progressId, 'progress-move');
      check(afterEviction.marker === beforeEviction.marker && JSON.stringify(afterEviction.cursor) !== JSON.stringify(beforeEviction.cursor), 'Preflight did not resume after eviction');
      await progressOwner.addUser('progress@example.test', 'Synthetic-password-123!', progressRoute);
      await registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move');
      const afterMutation = await registry.relocationTextPreflightStatus('move-secret', progressId, 'progress-move');
      check(afterMutation && afterMutation.marker !== afterEviction.marker, 'Go mutation did not invalidate preflight');
      const beforeLegacyFence = await progressOwner.ownerFence(), beforeLegacyBusiness = await progressOwner.businessSnapshot();
      const progressTableCount = await progressOwner.textPreflightTableCount(progressRoute);
      for (const [version, done] of [[1, false], [1, true], [2, false], [2, true], [3, false], [3, true]]) {
        const prior = await registry.relocationTextPreflightStatus('move-secret', progressId, 'progress-move');
        await registry.setLegacyPreflight(progressId, version, done, progressTableCount);
        const results = await Promise.allSettled([
          registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move'),
          registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move'),
        ]);
        check(results.some(result => result.status === 'fulfilled' && result.value.phase === 'preflighting') && results.every(result => result.status === 'fulfilled' ? result.value.phase === 'preflighting' : String(result.reason).includes('Stale legacy TEXT preflight')), 'Legacy recovery did not remain in preflight');
        check(await registry.relocationTextPreflightStatus('move-secret', progressId, 'progress-move') === null, 'Legacy checkpoint was not reset');
        check(JSON.stringify(await progressOwner.ownerFence()) === JSON.stringify(beforeLegacyFence) && JSON.stringify(await progressOwner.businessSnapshot()) === JSON.stringify(beforeLegacyBusiness), 'Legacy recovery changed source state');
        await registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move');
        const restarted = await registry.relocationTextPreflightStatus('move-secret', progressId, 'progress-move');
        check(restarted && restarted.cursor.version === 4 && restarted.marker !== prior.marker, 'Legacy recovery did not start a fresh scan');
      }
      await registry.setLegacyPreflight(progressId, 1, true, progressTableCount);
      const legacyBefore = await registry.legacyRelocationTextPreflightStatus('move-secret', progressId, 'progress-move');
      await progressOwner.addLegacyTransferState();
      let blocked = '';
      try { await registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move'); } catch (error) { blocked = String(error); }
      check(blocked.includes('Legacy transfer state requires manual review') && JSON.stringify(await registry.legacyRelocationTextPreflightStatus('move-secret', progressId, 'progress-move')) === JSON.stringify(legacyBefore) && JSON.stringify(await progressOwner.ownerFence()) === JSON.stringify(beforeLegacyFence) && JSON.stringify(await progressOwner.businessSnapshot()) === JSON.stringify(beforeLegacyBusiness), 'Legacy transfer evidence was changed');
      await progressOwner.removeLegacyTransferState();
      await registry.setLegacyJournal(progressId, 'progress-move', true);
      blocked = '';
      try { await registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move'); } catch (error) { blocked = String(error); }
      check(blocked.includes('Legacy transfer state requires manual review') && JSON.stringify(await registry.legacyRelocationTextPreflightStatus('move-secret', progressId, 'progress-move')) === JSON.stringify(legacyBefore) && JSON.stringify(await progressOwner.ownerFence()) === JSON.stringify(beforeLegacyFence) && JSON.stringify(await progressOwner.businessSnapshot()) === JSON.stringify(beforeLegacyBusiness), 'Legacy registry evidence was changed');
      await registry.setLegacyJournal(progressId, 'progress-move', false);
      await registry.beginRelocation('move-secret', progressOrigin, progressId, 'progress-move');
      check((await beginRelocation('move-secret', progressOrigin, progressId, 'progress-move')).phase === 'moving', 'Invalidated preflight did not complete');
      const lostOrigin = 'https://legacy-frozen.example', lostName = 'legacy-frozen-source', lostMove = 'legacy-frozen-move';
      const lostOwner = env.NEXTGEN_APPLICATION.getByName(lostName);
      await registry.reserve(lostOrigin, lostName);
      const lostId = (await lostOwner.provision('Legacy frozen', lostOrigin, { projectId: null, origin: lostOrigin, objectName: lostName, generation: 1 })).projectId;
      await registry.activate(lostOrigin, lostName, lostId);
      for (let page = 0; page < 10000; page++) {
        const current = await registry.relocationTextPreflightStatus('move-secret', lostId, lostMove).catch(() => null);
        if (current?.done) break;
        const result = await registry.beginRelocation('move-secret', lostOrigin, lostId, lostMove);
        check(result.phase === 'preflighting' && page < 9999, 'Legacy frozen scan did not reach its last page');
      }
      await lostOwner.holdNextProof();
      const lost = registry.beginRelocation('move-secret', lostOrigin, lostId, lostMove).then(() => false, () => true);
      for (let attempt = 0; attempt < 1000 && !await lostOwner.proofHeld(); attempt++) await new Promise(resolve => setTimeout(resolve, 1));
      check(await lostOwner.proofHeld(), 'Freeze acknowledgement was not held');
      const frozenBefore = await lostOwner.ownerFence(), frozenBusiness = await lostOwner.businessSnapshot();
      check(frozenBefore[0]?.state === 'frozen', 'Lost-ack source was not frozen');
      await registry.setLegacyPreflight(lostId, 2, true, (await registry.relocationTextPreflightStatus('move-secret', lostId, lostMove)).cursor.table);
      await lostOwner.releaseProof();
      check(await lost, 'Injected lost acknowledgement did not fail');
      check((await registry.beginRelocation('move-secret', lostOrigin, lostId, lostMove)).phase === 'preflighting', 'Frozen legacy recovery did not restart');
      check(JSON.stringify(await lostOwner.ownerFence()) === JSON.stringify(frozenBefore) && JSON.stringify(await lostOwner.businessSnapshot()) === JSON.stringify(frozenBusiness), 'Frozen recovery changed source state');
      check((await beginRelocation('move-secret', lostOrigin, lostId, lostMove)).phase === 'moving', 'Frozen legacy recovery failed to resume');
      await registry.setLegacyPreflight(lostId, 1, true, (await registry.relocationTextPreflightStatus('move-secret', lostId, lostMove)).cursor.table);
      const movingBefore = await registry.relocationStatus('move-secret', lostId), movingFence = await lostOwner.ownerFence();
      let movingError = '';
      try { await registry.beginRelocation('move-secret', lostOrigin, lostId, lostMove); } catch (error) { movingError = String(error); }
      check(movingError.includes('Legacy TEXT preflight requires manual review') && JSON.stringify(await registry.relocationStatus('move-secret', lostId)) === JSON.stringify(movingBefore) && JSON.stringify(await lostOwner.ownerFence()) === JSON.stringify(movingFence), 'Moving legacy recovery did not fail closed');
      const maximumRoute = { projectId: maximumId, origin: maximumOrigin, objectName: maximumName, generation: Number.MAX_SAFE_INTEGER };
      const maximumFence = await maximumOwner.ownerFence(), maximumBefore = await maximumOwner.testCounts();
      let maximumError = '';
      try { await beginRelocation('move-secret', maximumOrigin, maximumId, 'max-generation-move'); } catch (error) { maximumError = String(error); }
      const maximumStatus = await registry.relocationStatus('move-secret', maximumId);
      const maximumFenceAfter = await maximumOwner.ownerFence();
      check(maximumError.includes('Project generation cannot advance'), `Unexpected maximum-generation rejection: ${maximumError}, owner state ${maximumFenceAfter?.[0]?.state}, intent present ${!!maximumStatus.intent}`);
      check(maximumStatus.route?.state === 'active' && maximumStatus.route.generation === Number.MAX_SAFE_INTEGER && !maximumStatus.intent && !maximumStatus.move, 'Maximum generation changed route or reserved a move');
      check(JSON.stringify(maximumFenceAfter) === JSON.stringify(maximumFence) && JSON.stringify(await maximumOwner.testCounts()) === JSON.stringify(maximumBefore), 'Maximum generation changed owner fence, business rows or audit');
      await maximumOwner.addUser('max-generation@example.test', 'Synthetic-password-123!', maximumRoute);
      check((await ready(otherOrigin)).status === 200, 'Maximum-generation rejection affected another project');
      const nearOrigin = 'https://near-max-generation.example', nearName = 'near-max-generation-source';
      const nearOwner = env.NEXTGEN_APPLICATION.getByName(nearName);
      await registry.reserve(nearOrigin, nearName);
      const nearId = (await nearOwner.provision('Near maximum generation', nearOrigin, { projectId: null, origin: nearOrigin, objectName: nearName, generation: 1 })).projectId;
      await registry.activate(nearOrigin, nearName, nearId);
      await registry.setTestGeneration(nearId, '9007199254740990');
      await nearOwner.setTestOwnerGeneration('9007199254740990');
      const nearMove = await beginRelocation('move-secret', nearOrigin, nearId, 'near-max-generation-move');
      check(nearMove.phase === 'moving' && nearMove.generation === Number.MAX_SAFE_INTEGER - 1, 'Last representable generation could not begin a move');
      check((await beginRelocation('move-secret', nearOrigin, nearId, 'near-max-generation-move')).generation === nearMove.generation, 'Near-maximum move retry changed generation');
      // A separately configured recovery era must also block pre-freeze when
      // the durable epoch is missing, changed, or duplicated. The test-only
      // fixture seeds the matching epoch before normal provisioning.
      const epochOrigin = 'https://configured-epoch.example', epochName = 'configured-epoch-source';
      let epochOwner = env.NEXTGEN_APPLICATION.getByName(epochName);
      await epochOwner.seedConfiguredTestEpoch();
      await registry.reserve(epochOrigin, epochName);
      const epochId = (await epochOwner.provision('Configured epoch', epochOrigin, { projectId: null, origin: epochOrigin, objectName: epochName, generation: 1 })).projectId;
      await registry.activate(epochOrigin, epochName, epochId);
      const epochRoute = { projectId: epochId, origin: epochOrigin, objectName: epochName, generation: 1 };
      await epochOwner.addUser('configured-epoch@example.test', 'Synthetic-password-123!', epochRoute);
      const epochFence = await epochOwner.ownerFence(), epochBusiness = await epochOwner.businessSnapshot();
      const rejectEpochMove = async label => {
        let error = '';
        try { await beginRelocation('move-secret', epochOrigin, epochId, 'configured-epoch-move'); } catch (caught) { error = String(caught); }
        check(error.includes('Project recovery is not reconciled'), `${label} configured epoch rejection: ${error}`);
        const status = await registry.relocationStatus('move-secret', epochId);
        check(!status.move && status.intent?.move_id === 'configured-epoch-move' && (await registry.resolve(epochOrigin)).state === 'active', `${label} configured epoch closed the route`);
        check(JSON.stringify(await epochOwner.ownerFence()) === JSON.stringify(epochFence), `${label} configured epoch changed the fence`);
        check(JSON.stringify(await epochOwner.businessSnapshot()) === JSON.stringify(epochBusiness), `${label} configured epoch changed business or audit state`);
      };
      await epochOwner.setTestRecoveryEpoch('mismatched-era');
      await rejectEpochMove('Mismatched');
      await rejects(() => epochOwner.evict()); epochOwner = env.NEXTGEN_APPLICATION.getByName(epochName);
      await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName('projects');
      await rejectEpochMove('Mismatched after restart');
      await epochOwner.setTestRecoveryEpoch('fixture-era');
      await epochOwner.addTestRecoveryEpoch('extra-era');
      await rejectEpochMove('Duplicate');
      await epochOwner.removeTestRecoveryEpoch('extra-era');
      await epochOwner.removeTestRecoveryEpoch('fixture-era');
      await rejectEpochMove('Missing');
      await epochOwner.addTestRecoveryEpoch('fixture-era');
      const epochMove = await beginRelocation('move-secret', epochOrigin, epochId, 'configured-epoch-move');
      check(epochMove.phase === 'moving', 'Matching configured epoch did not allow the same move intent to resume');
      check((await ready(otherOrigin)).status === 200, 'Configured epoch checks affected the other project');
      const schemaOrigin = "https://schema.example", schemaName = "schema-source";
      let schemaOwner = env.NEXTGEN_APPLICATION.getByName(schemaName);
      await registry.reserve(schemaOrigin, schemaName);
      const schemaId = (await schemaOwner.provision("Schema", schemaOrigin, { projectId: null, origin: schemaOrigin, objectName: schemaName, generation: 1 })).projectId;
      await registry.activate(schemaOrigin, schemaName, schemaId);
      const schemaRoute = { projectId: schemaId, origin: schemaOrigin, objectName: schemaName, generation: 1 };
      await schemaOwner.addUnsupportedSchema();
      let schemaError = "";
      try { await beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move"); } catch (error) { schemaError = String(error); }
      check(schemaError.includes("Unreviewed schema object"), `Unexpected schema rejection: ${schemaError}`);
      let schemaStatus = await registry.relocationStatus("move-secret", schemaId);
      check(!schemaStatus.move && schemaStatus.intent?.move_id === "schema-move" && (await registry.resolve(schemaOrigin)).state === "active", "Schema failure did not leave active route and same intent");
      await schemaOwner.addUser("schema@example.test", "Schema-password-123!", schemaRoute);
      await rejects(() => beginRelocation("move-secret", schemaOrigin, schemaId, "other-schema-move"));
      check((await ready(otherOrigin)).status === 200, "Other owner unavailable after schema failure");
      const destination = schemaStatus.intent.destination_object;
      await rejects(() => schemaOwner.evict()); schemaOwner = env.NEXTGEN_APPLICATION.getByName(schemaName);
      await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName("projects");
      schemaStatus = await registry.relocationStatus("move-secret", schemaId);
      check(!schemaStatus.move && schemaStatus.intent?.move_id === "schema-move" && schemaStatus.intent.destination_object === destination, "Intent did not survive restart");
      await schemaOwner.removeUnsupportedSchema();
      const beforeSchemaBounds = await schemaOwner.testCounts(), fenceBeforeSchemaBounds = await schemaOwner.ownerFence();
      const rejectSchemaBounds = async label => {
        let error = '';
        try { await beginRelocation('move-secret', schemaOrigin, schemaId, 'schema-move'); } catch (caught) { error = String(caught); }
        check(error.includes('Schema exceeds inspection bounds'), `${label} schema bound rejection: ${error}`);
        const status = await registry.relocationStatus('move-secret', schemaId);
        check(!status.move && status.intent?.move_id === 'schema-move' && (await registry.resolve(schemaOrigin)).state === 'active', `${label} schema bound closed route`);
        check(JSON.stringify(await schemaOwner.ownerFence()) === JSON.stringify(fenceBeforeSchemaBounds), `${label} schema bound changed owner fence`);
        check(JSON.stringify(await schemaOwner.testCounts()) === JSON.stringify(beforeSchemaBounds), `${label} schema bound changed business or audit state`);
      };
      await schemaOwner.addOversizedSchemaDefinition();
      await rejectSchemaBounds('Oversized definition');
      await schemaOwner.removeOversizedSchemaDefinition();
      await schemaOwner.addOversizedSchemaIdentifier();
      await rejectSchemaBounds('Oversized UTF-8 identifier');
      await schemaOwner.removeOversizedSchemaIdentifier();
      await schemaOwner.addManyUnsupportedSchemaObjects();
      await rejectSchemaBounds('Excess object count');
      await schemaOwner.removeManyUnsupportedSchemaObjects();
      for (const [version, expected] of [[999, "Unsupported application schema version"], [2, "Application schema history differs"]]) {
        await schemaOwner.setTestSchemaVersion(version);
        let error = "";
        try { await beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move"); } catch (caught) { error = String(caught); }
        check(error.includes(expected), `Unexpected schema metadata rejection: ${error}`);
        schemaStatus = await registry.relocationStatus("move-secret", schemaId);
        check(!schemaStatus.move && schemaStatus.intent?.move_id === "schema-move" && (await registry.resolve(schemaOrigin)).state === "active", "Schema metadata rejection closed active route");
      }
      await schemaOwner.setTestSchemaVersion(1);
      await schemaOwner.addTestSchemaVersion(999);
      await rejects(() => beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move"));
      check((await registry.resolve(schemaOrigin)).state === "active", "Multiple schema versions closed active route");
      await schemaOwner.removeTestSchemaVersion(999);
      const originalEpoch = await schemaOwner.testRecoveryEpoch();
      await schemaOwner.setTestRecoveryEpoch('');
      let recoveryError = '';
      try { await beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move"); } catch (caught) { recoveryError = String(caught); }
      check(recoveryError.includes('Invalid recovery epoch'), `Unexpected empty recovery epoch rejection: ${recoveryError}`);
      check((await registry.resolve(schemaOrigin)).state === 'active', 'Invalid epoch closed active route');
      await schemaOwner.setTestRecoveryEpoch(originalEpoch);
      await schemaOwner.addTestRecoveryEpoch('extra-epoch');
      await rejects(() => beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move"));
      check((await registry.resolve(schemaOrigin)).state === 'active', 'Multiple epochs closed active route');
      await schemaOwner.removeTestRecoveryEpoch('extra-epoch');
      await schemaOwner.addTestOrigin('https://unexpected.example');
      await rejects(() => beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move"));
      check((await registry.resolve(schemaOrigin)).state === 'active', 'Multiple origins closed active route');
      await schemaOwner.removeTestOrigin('https://unexpected.example');
      await schemaOwner.addForeignProject();
      let projectError = '';
      try { await beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move"); } catch (caught) { projectError = String(caught); }
      check(projectError.includes('Project object contains an unexpected project'), `Unexpected foreign-project rejection: ${projectError}`);
      schemaStatus = await registry.relocationStatus("move-secret", schemaId);
      check(!schemaStatus.move && schemaStatus.intent?.move_id === 'schema-move' && (await registry.resolve(schemaOrigin)).state === 'active', 'Foreign project closed the active route');
      await schemaOwner.removeForeignProject();
      const beforeIdentityCases = await schemaOwner.testCounts();
      const fenceBeforeIdentityCases = await schemaOwner.ownerFence();
      const originalIdentity = await schemaOwner.removeOwnerIdentity();
      const assertIdentityRejected = async label => {
        let error = '';
        try { await beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move"); } catch (caught) { error = String(caught); }
        const expected = label.includes('origin') ? 'Project origin differs' : 'Owner project identity differs';
        check(error.includes(expected), `${label} identity rejection: ${error}`);
        const status = await registry.relocationStatus("move-secret", schemaId);
        check(!status.move && status.intent?.move_id === 'schema-move' && (await registry.resolve(schemaOrigin)).state === 'active', `${label} closed the active route`);
        check(JSON.stringify(await schemaOwner.ownerFence()) === JSON.stringify(fenceBeforeIdentityCases), `${label} changed the owner fence`);
        check(JSON.stringify(await schemaOwner.testCounts()) === JSON.stringify(beforeIdentityCases), `${label} changed business rows or audit`);
      };
      await assertIdentityRejected('Missing owner');
      await schemaOwner.insertOwnerIdentity({ ...originalIdentity, project_id: 'proj_other_identity_test' });
      await assertIdentityRejected('Mismatched owner');
      await schemaOwner.insertOwnerIdentity(originalIdentity);
      await assertIdentityRejected('Multiple owner');
      await schemaOwner.deleteOwnerIdentity('proj_other_identity_test');
      await schemaOwner.setOversizedOwnerIdentity();
      await assertIdentityRejected('Oversized owner');
      await schemaOwner.restoreOwnerIdentity(schemaId);
      await schemaOwner.setBlobOwnerIdentity();
      await assertIdentityRejected('BLOB owner');
      await schemaOwner.restoreOwnerIdentity(schemaId);
      await schemaOwner.setOversizedOrigin();
      await assertIdentityRejected('Oversized origin');
      await schemaOwner.restoreOrigin(schemaOrigin);
      const schemaMove = await beginRelocation("move-secret", schemaOrigin, schemaId, "schema-move");
      check(schemaMove.phase === "moving" && schemaMove.destination_object === destination, "Same-move retry failed after schema repair");
      await rejects(() => schemaOwner.addUser("schema-frozen@example.test", "Schema-password-123!", schemaRoute));
      // A negative aggregate is not a valid recovery anchor. Detect it before
      // freezing, retain the same move intent, and permit repair and retry.
      const negativeOrigin = "https://negative-clock.example", negativeName = "negative-clock-source";
      let negativeOwner = env.NEXTGEN_APPLICATION.getByName(negativeName);
      await registry.reserve(negativeOrigin, negativeName);
      const negativeId = (await negativeOwner.provision("Negative clock", negativeOrigin, { projectId: null, origin: negativeOrigin, objectName: negativeName, generation: 1 })).projectId;
      await registry.activate(negativeOrigin, negativeName, negativeId);
      const negativeCounts = await negativeOwner.testCounts(), negativeFence = await negativeOwner.ownerFence(), otherCounts = await other.testCounts();
      const negativeRoute = { projectId: negativeId, origin: negativeOrigin, objectName: negativeName, generation: 1 };
      const originalStamp = await negativeOwner.removeTestRevisionClock();
      await negativeOwner.restoreTestRevisionClock(originalStamp);
      // These are schema-preflight checks, not assertions that a 0 clock is
      // consistent with this project's existing revision scopes.
      for (const kind of ['zero', 'maximum']) {
        await negativeOwner.setTestRevisionValue(kind);
        await negativeOwner.validateTestSourceSchema(negativeRoute);
      }
      for (const kind of ['real', 'text', 'blob']) {
        await negativeOwner.setTestRevisionValue(kind);
        let error = '';
        try { await negativeOwner.validateTestSourceSchema(negativeRoute); } catch (caught) { error = String(caught); }
        check(error.includes('Invalid revision clock'), `${kind} clock accepted: ${error}`);
      }
      await negativeOwner.removeTestRevisionClock();
      await negativeOwner.restoreTestRevisionClock('-1');
      const assertNegativeClockRejected = async () => {
        let error = '';
        try { await beginRelocation("move-secret", negativeOrigin, negativeId, "negative-clock-move"); } catch (caught) { error = String(caught); }
        check(error.includes('Invalid revision clock'), `Unexpected negative clock rejection: ${error}`);
        const status = await registry.relocationStatus("move-secret", negativeId);
        check(!status.move && status.intent?.move_id === 'negative-clock-move' && (await registry.resolve(negativeOrigin)).state === 'active', 'Negative clock closed active route');
        check(JSON.stringify(await negativeOwner.ownerFence()) === JSON.stringify(negativeFence) && JSON.stringify(await negativeOwner.testCounts()) === JSON.stringify(negativeCounts), 'Negative clock changed owner, business or audit state');
        check(JSON.stringify(await other.testCounts()) === JSON.stringify(otherCounts) && (await ready(otherOrigin)).status === 200, 'Negative clock affected the other project');
      };
      await assertNegativeClockRejected();
      await rejects(() => negativeOwner.evict()); negativeOwner = env.NEXTGEN_APPLICATION.getByName(negativeName);
      await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName('projects');
      await assertNegativeClockRejected();
      check(await negativeOwner.removeTestRevisionClock() === '-1', 'Negative test clock changed unexpectedly');
      await negativeOwner.restoreTestRevisionClock(originalStamp);
      const negativeMove = await beginRelocation("move-secret", negativeOrigin, negativeId, "negative-clock-move");
      check(negativeMove.phase === 'moving', 'Same move did not resume after revision-clock repair');
      const brokenClockOrigin = "https://broken-clock.example", brokenClockName = "broken-clock-source";
      const brokenClockOwner = env.NEXTGEN_APPLICATION.getByName(brokenClockName);
      await registry.reserve(brokenClockOrigin, brokenClockName);
      const brokenClockId = (await brokenClockOwner.provision("Broken clock", brokenClockOrigin, { projectId: null, origin: brokenClockOrigin, objectName: brokenClockName, generation: 1 })).projectId;
      await registry.activate(brokenClockOrigin, brokenClockName, brokenClockId);
      const clockStamp = await brokenClockOwner.removeTestRevisionClock();
      let clockError = "";
      try { await beginRelocation("move-secret", brokenClockOrigin, brokenClockId, "broken-clock-move"); } catch (caught) { clockError = String(caught); }
      check(clockError.includes("Invalid revision clock"), `Unexpected missing clock rejection: ${clockError}`);
      check((await registry.resolve(brokenClockOrigin)).state === "active", "Missing revision clock closed active route");
      await brokenClockOwner.restoreTestRevisionClock(clockStamp);
      await brokenClockOwner.dropTestRevisionScopes();
      clockError = "";
      try { await beginRelocation("move-secret", brokenClockOrigin, brokenClockId, "broken-clock-move"); } catch (caught) { clockError = String(caught); }
      check(clockError.includes("Revision clock tables must coexist"), `Unexpected revision-clock rejection: ${clockError}`);
      check((await registry.resolve(brokenClockOrigin)).state === "active", "Revision-clock rejection closed active route");
      check((await ready(otherOrigin)).status === 200, "Other owner unavailable after metadata failure");
      await owner.addUser("source@example.test", "Source-password-123!", route);
      const before = await owner.testCounts();
      await rejects(() => owner.preFreezeRelocation("move-secret", route, "move-1"));
      await rejects(() => other.preFreezeRelocation("move-secret", route, "move-1"));
      await owner.holdNextProof();
      const first = beginRelocation("move-secret", origin, projectId, "move-1").then(() => false, () => true);
      while (!await owner.proofHeld()) await new Promise(resolve => setTimeout(resolve, 5));
      const pending = await registry.relocationStatus("move-secret", projectId);
      check(!pending.move && pending.intent?.move_id === "move-1" && (await registry.resolve(origin)).state === "active", "Intent not durable before moving");
      const sourceResponse = await postUser(origin, "held@example.test");
      check(sourceResponse.status === 503, `Frozen source admin returned ${sourceResponse.status}, expected 503`);
      check(sourceResponse.headers.get("cache-control") === "no-store", "Maintenance response was cacheable");
      const heldOauth = await postAdmin(origin, "/_mapi/admin/oidc/init");
      check(heldOauth.status === 503, `Frozen source OAuth admin returned ${heldOauth.status}, expected 503`);
      const heldFlow = await postAdmin(origin, "/_mapi/admin/oidc/flow/status");
      check(heldFlow.status === 503, `Frozen source flow admin returned ${heldFlow.status}, expected 503`);
      const heldReady = await ready(origin);
      check(heldReady.status === 503, `Frozen source readiness returned ${heldReady.status}, expected 503`);
      await rejects(() => owner.addUser("bad@example.test", "Bad-password-123!"));
      await rejects(() => owner.addUser("bad2@example.test", "Bad-password-123!", route));
      await rejects(() => owner.addUser("bad3@example.test", "Bad-password-123!", { ...route, generation: 2 }));
      await rejects(() => owner.preFreezeRelocation("move-secret", { ...route, generation: 2 }, "move-1"));
      await rejects(() => beginRelocation("move-secret", origin, projectId, "move-2"));
      await rejects(() => registry.beginProjectRecovery("move-secret", origin, projectId, "recovery-1", "era-1"));
      const otherResponse = await postUser(otherOrigin, "other@example.test");
      check(otherResponse.status === 200, `Other project admin returned ${otherResponse.status}`);
      const invalidRequest = await app.fetch(new Request(`${otherOrigin}/_mapi/admin/users`, { method: "POST", headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: "{}" }), env);
      check(invalidRequest.status === 400, `Invalid active request returned ${invalidRequest.status}`);
      const invalidOauth = await postAdmin(otherOrigin, "/_mapi/admin/oidc/clients", {});
      check(invalidOauth.status === 400, `Invalid active OAuth request returned ${invalidOauth.status}`);
      const duplicateResponse = await postUser(otherOrigin, "other@example.test");
      check([400, 409].includes(duplicateResponse.status), `Duplicate active user returned ${duplicateResponse.status}`);
      const beforeApplicationFailure = await other.testCounts();
      await other.failNextAdd();
      const applicationFailure = await postUser(otherOrigin, "failure@example.test");
      check(applicationFailure.status === 400, `Active non-fence error returned ${applicationFailure.status}`);
      check(JSON.stringify(await other.testCounts()) === JSON.stringify(beforeApplicationFailure), "Failed other-project request changed rows or audit");
      check(JSON.stringify(await owner.testCounts()) === JSON.stringify(before), "Rejected writes changed source rows or audit");
      await owner.releaseProof();
      check(await first, "Injected acknowledgement loss was not observed");
      await rejects(() => owner.evict()); owner = env.NEXTGEN_APPLICATION.getByName("source");
      await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName("projects");
      await rejects(() => owner.addUser("restart@example.test", "Restart-password-123!", route));
      const resumed = await beginRelocation("move-secret", origin, projectId, "move-1");
      check(resumed.phase === "moving" && resumed.destination_object === pending.intent.destination_object, "Restart did not resume same intent");
      await rejects(() => owner.addUser("late@example.test", "Late-password-123!", route));
      check(JSON.stringify(await owner.testCounts()) === JSON.stringify(before), "Source changed after restart");
      check((await registry.resolve(otherOrigin)).state === "active" && (await other.testCounts()).users === 1, "Other project changed or closed");

      const raceOrigin = "https://race.example", raceName = "race-source";
      const race = env.NEXTGEN_APPLICATION.getByName(raceName);
      await registry.reserve(raceOrigin, raceName);
      const raceId = (await race.provision("Race", raceOrigin, { projectId: null, origin: raceOrigin, objectName: raceName, generation: 1 })).projectId;
      await registry.activate(raceOrigin, raceName, raceId);
      const raceRoute = { projectId: raceId, origin: raceOrigin, objectName: raceName, generation: 1 };
      await race.addUser("race@example.test", "Race-password-123!", raceRoute);
      const raceBefore = await race.testCounts();
      await race.holdNextAdd();
      await race.holdAdmin("oauth");
      await race.holdAdmin("flow");
      const pendingResponse = postUser(raceOrigin, "racing@example.test");
      const pendingOauth = postAdmin(raceOrigin, "/_mapi/admin/oidc/init");
      const pendingFlow = postAdmin(raceOrigin, "/_mapi/admin/oidc/flow/status");
      for (let attempts = 0; !(await race.addHeld()); attempts++) { if (attempts > 1000) throw Error("Admin request did not reach mutation"); await new Promise(resolve => setTimeout(resolve, 5)); }
      for (let attempts = 0; !(await race.adminHeld("oauth")) || !(await race.adminHeld("flow")); attempts++) { if (attempts > 1000) throw Error("OIDC admin requests did not reach mutation"); await new Promise(resolve => setTimeout(resolve, 5)); }
      await race.holdNextProof();
      const raceMove = beginRelocation("move-secret", raceOrigin, raceId, "race-move").then(() => false, () => true);
      for (let attempts = 0; !(await race.proofHeld()); attempts++) { if (attempts > 1000) throw Error("Race source did not freeze"); await new Promise(resolve => setTimeout(resolve, 5)); }
      check((await registry.resolve(raceOrigin)).state === "active", "Race route changed before held proof");
      await race.releaseAdd();
      await race.releaseAdmin("oauth");
      await race.releaseAdmin("flow");
      const [raced, racedOauth, racedFlow] = await Promise.all([pendingResponse, pendingOauth, pendingFlow]);
      check(raced.status === 503, `Race admin returned ${raced.status}, expected 503`);
      check(racedOauth.status === 503 && racedFlow.status === 503, `Race OAuth/flow admin returned ${racedOauth.status}/${racedFlow.status}, expected 503`);
      check(raced.headers.get("cache-control") === "no-store" && racedOauth.headers.get("cache-control") === "no-store" && racedFlow.headers.get("cache-control") === "no-store", "Race maintenance response was cacheable");
      check(JSON.stringify(await race.testCounts()) === JSON.stringify(raceBefore), "Racing write changed source rows or audit");
      await race.releaseProof();
      check(await raceMove, "Injected race acknowledgement loss was not observed");
      check((await beginRelocation("move-secret", raceOrigin, raceId, "race-move")).phase === "moving", "Race move did not resume");
      const stillOther = await postUser(otherOrigin, "still-other@example.test");
      check(stillOther.status === 200 && (await other.testCounts()).users === 2, "Other project did not remain available");

      const sessionOrigin = "https://session-race.example", sessionName = "session-race-source";
      const sessionOwner = env.NEXTGEN_APPLICATION.getByName(sessionName);
      await registry.reserve(sessionOrigin, sessionName);
      const sessionId = (await sessionOwner.provision("Session race", sessionOrigin, { projectId: null, origin: sessionOrigin, objectName: sessionName, generation: 1 })).projectId;
      await registry.activate(sessionOrigin, sessionName, sessionId);
      const sessionRoute = { projectId: sessionId, origin: sessionOrigin, objectName: sessionName, generation: 1 };
      await sessionOwner.addUser("session@example.test", "Session-password-123!", sessionRoute);
      const signedIn = await login(sessionOrigin, "session@example.test", "Session-password-123!");
      check(signedIn.status === 303, `Valid active login returned ${signedIn.status}`);
      const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0]; check(cookie, "Active login returned no session cookie");
      const activeApp = await appPage(sessionOrigin, cookie);
      check(activeApp.status === 200, `Valid active session returned ${activeApp.status}`);
      const csrf = (await activeApp.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; check(csrf, "Active session returned no CSRF token");
      check((await login(sessionOrigin, "session@example.test", "wrong-password")).status === 401, "Invalid password did not remain 401");
      check((await appPage(sessionOrigin)).status === 303, "Unauthenticated session did not remain a login redirect");
      const badOrigin = await app.fetch(new Request(`${sessionOrigin}/logout`, { method: "POST", headers: { origin: "https://other.example", cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) }), env);
      check(badOrigin.status === 403, "Invalid logout origin did not remain forbidden");
      await sessionOwner.nextLoginStatus(503); check((await login(sessionOrigin, "session@example.test", "Session-password-123!")).status === 503, "Login 503 was not preserved");
      await sessionOwner.nextSessionStatus("read", 503); check((await appPage(sessionOrigin, cookie)).status === 503, "Session-read 503 was not preserved");
      await sessionOwner.nextSessionStatus("csrf", 503); check((await appPage(sessionOrigin, cookie)).status === 503, "CSRF 503 was not preserved");
      await sessionOwner.nextSessionStatus("logout", 503); check((await logout(sessionOrigin, cookie, csrf)).status === 503, "Logout 503 was not preserved");
      await sessionOwner.holdLogin();
      const pendingLogin = login(sessionOrigin, "session@example.test", "Session-password-123!");
      for (let attempts = 0; !(await sessionOwner.loginHeld()); attempts++) { if (attempts > 1000) throw Error("Login did not reach owner"); await new Promise(resolve => setTimeout(resolve, 5)); }
      await sessionOwner.holdSession("read");
      const pendingRead = appPage(sessionOrigin, cookie);
      for (let attempts = 0; !(await sessionOwner.sessionHeld("read")); attempts++) { if (attempts > 1000) throw Error("Session read did not reach owner"); await new Promise(resolve => setTimeout(resolve, 5)); }
      await sessionOwner.holdSession("csrf");
      const pendingCsrf = appPage(sessionOrigin, cookie);
      for (let attempts = 0; !(await sessionOwner.sessionHeld("csrf")); attempts++) { if (attempts > 1000) throw Error("Session CSRF did not reach owner"); await new Promise(resolve => setTimeout(resolve, 5)); }
      await sessionOwner.holdSession("logout");
      const pendingLogout = logout(sessionOrigin, cookie, csrf);
      for (let attempts = 0; !(await sessionOwner.sessionHeld("logout")); attempts++) { if (attempts > 1000) throw Error("Logout did not reach owner"); await new Promise(resolve => setTimeout(resolve, 5)); }
      const beforeSessionRace = await sessionOwner.businessSnapshot();
      await sessionOwner.holdNextProof();
      const sessionMove = beginRelocation("move-secret", sessionOrigin, sessionId, "session-race-move").then(() => false, () => true);
      for (let attempts = 0; !(await sessionOwner.proofHeld()); attempts++) { if (attempts > 1000) throw Error("Session race owner did not freeze"); await new Promise(resolve => setTimeout(resolve, 5)); }
      check((await registry.resolve(sessionOrigin)).state === "active", "Session race route changed before held acknowledgement");
      await sessionOwner.releaseLogin();
      await sessionOwner.releaseSession("read");
      await sessionOwner.releaseSession("csrf");
      await sessionOwner.releaseSession("logout");
      const sessionOutcomes = await Promise.allSettled([pendingLogin, pendingRead, pendingCsrf, pendingLogout]);
      check(sessionOutcomes.every(result => result.status === "fulfilled" && result.value.status === 503 && result.value.headers.get("cache-control") === "no-store"), `Frozen login/session request did not return no-store 503: ${sessionOutcomes.map(result => result.status === "fulfilled" ? result.value.status : "threw").join(",")}`);
      check(JSON.stringify(await sessionOwner.businessSnapshot()) === JSON.stringify(beforeSessionRace), "Frozen login/session race changed rows, audit or throttle");
      check((await postUser(otherOrigin, "other-after-session-race@example.test")).status === 200, "Other project was unavailable during session freeze");
      await sessionOwner.releaseProof(); check(await sessionMove, "Session race lost acknowledgement was not observed");
      check((await beginRelocation("move-secret", sessionOrigin, sessionId, "session-race-move")).phase === "moving", "Session race move did not resume");
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error), stack: error.stack }, { status: 500 }); }
  },
};
