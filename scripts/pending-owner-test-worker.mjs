import application, { NextgenApplication } from "../worker/generated/pending-owner-test-app.js";
import { ProjectRegistry } from "../worker/registry.js";
import { reserveMoveDestination } from "../worker/owner-fence.js";

export class PendingRegistry extends ProjectRegistry {
  #candidates = [];
  evict() { this.ctx.abort("registry restart"); }
  testCandidates(values) { this.#candidates = values; }
  moveDestinationCandidate() { return this.#candidates.shift() ?? super.moveDestinationCandidate(); }
  testOldRecoveryLedger(projectId, recoveryId, epoch) {
    this.ctx.storage.sql.exec("INSERT INTO mapi_project_recoveries (project_id, recovery_id, origin, object_name, object_id, generation, epoch, phase, clock_highwater) VALUES (?, ?, 'https://historic.example', 'historic', 'historic-id', 1, ?, 'closing', NULL)", projectId, recoveryId, epoch);
  }
}
export class PendingOwner extends NextgenApplication {
  #hold = false; #held = false; #release;
  #holdRecovery = false; #recoveryHeld = false; #releaseRecovery;
  #holdFreeze = false; #freezeHeld = false; #releaseFreeze;
  constructor(ctx, env) {
    const noDrain = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'test_no_drain'").toArray().length;
    super(ctx, noDrain ? { ...env, MAPI_FENCE_WRITERS_DRAINED: "0" } : env);
  }
  holdActivation() { this.#hold = true; }
  activationHeld() { return this.#held; }
  releaseActivation() { this.#release(); }
  holdRecoveryProof() { this.#holdRecovery = true; }
  recoveryProofHeld() { return this.#recoveryHeld; }
  releaseRecoveryProof() { this.#releaseRecovery(); }
  holdRecoveryFreeze() { this.#holdFreeze = true; }
  recoveryFreezeHeld() { return this.#freezeHeld; }
  releaseRecoveryFreeze() { this.#releaseFreeze(); }
  async preFreezeRecovery(secret, route, recoveryId, epoch) {
    const proof = await super.preFreezeRecovery(secret, route, recoveryId, epoch);
    if (this.#holdFreeze) {
      this.#holdFreeze = false; this.#freezeHeld = true;
      await new Promise(resolve => { this.#releaseFreeze = resolve; });
      throw new Error("Injected lost recovery freeze acknowledgement");
    }
    return proof;
  }
  async activeRecoveryAttestation(secret, route, epoch) {
    const proof = super.activeRecoveryAttestation(secret, route, epoch);
    if (this.#holdRecovery) {
      this.#holdRecovery = false; this.#recoveryHeld = true;
      await new Promise(resolve => { this.#releaseRecovery = resolve; });
    }
    return proof;
  }
  async activateProvisioning(route) {
    if (this.#hold) {
      this.#hold = false; this.#held = true;
      await new Promise(resolve => { this.#release = resolve; });
      throw new Error("Injected lost activation");
    }
    return super.activateProvisioning(route);
  }
  tableNames() { return this.ctx.storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) <> '__' ORDER BY name").toArray().map(row => row.name); }
  fenceState() { return this.ctx.storage.sql.exec("SELECT state FROM mapi_owner_fence WHERE singleton = 1").one().state; }
  testReserveDestination() { return reserveMoveDestination(this.ctx.storage, { projectId: "proj_move", origin: "https://move.example", objectName: "collision", generation: 2 }, "move-collision"); }
  testClearDestination() { this.ctx.storage.sql.exec("DELETE FROM mapi_destination_reservation"); }
  testEpochRows(values) { this.ctx.storage.transactionSync(() => { this.ctx.storage.sql.exec("DELETE FROM mapi_recovery_epoch"); for (const value of values) this.ctx.storage.sql.exec("INSERT INTO mapi_recovery_epoch VALUES (?)", value); }); }
  testMakeLegacy(noDrain = false) {
    this.ctx.storage.sql.exec("DROP TABLE mapi_owner_fence");
    if (noDrain) this.ctx.storage.sql.exec("CREATE TABLE test_no_drain (value INTEGER)");
  }
}

export class LegacyTargetOwner extends NextgenApplication {
  constructor(ctx, env) {
    const target = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'legacy_target_test'").toArray().length;
    super(ctx, target ? { ...env, MAPI_SCHEMA_TARGET: "2" } : env);
  }
  inspectLegacy() {
    const sql = this.ctx.storage.sql;
    return { version: sql.exec("SELECT version FROM mapi_schema_version").one().version, users: sql.exec("SELECT count(*) AS n FROM legacy_users").one().n, events: sql.exec("SELECT count(*) AS n FROM legacy_events").one().n, history: sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_history'").toArray().length };
  }
  seedLegacy() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE mapi_schema_version(version INTEGER PRIMARY KEY)"); sql.exec("INSERT INTO mapi_schema_version VALUES (1)");
    sql.exec("CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)"); sql.exec("INSERT INTO mapi_project VALUES ('proj_legacy', 'schema')");
    sql.exec("CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)"); sql.exec("INSERT INTO mapi_project_origin VALUES ('https://legacy-version.example')");
    sql.exec("CREATE TABLE mapi_login_limits(key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)");
    sql.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)"); sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('0')");
    sql.exec("CREATE TABLE legacy_users(id TEXT PRIMARY KEY)"); sql.exec("INSERT INTO legacy_users VALUES ('user_legacy')");
    sql.exec("CREATE TABLE legacy_events(id TEXT PRIMARY KEY)"); sql.exec("INSERT INTO legacy_events VALUES ('event_legacy')");
    sql.exec("CREATE TABLE legacy_target_test(value INTEGER)");
  }
}

const check = (v, m) => { if (!v) throw Error(m); };
const rejects = async fn => { try { await fn(); } catch { return; } throw Error("Expected rejection"); };
export default {
 async fetch(_request, env) {
  try {
   let registry = env.PROJECT_REGISTRY.getByName("projects"), owner = env.NEXTGEN_APPLICATION.getByName("fresh");
   const origin = "https://one.example", otherOrigin = "https://two.example";
   const pending = { projectId: null, origin, objectName: "fresh", generation: 1 };
   check((await owner.tableNames()).length === 0, `Fresh constructor created schema: ${await owner.tableNames()}`);
   await rejects(() => owner.provision("bad", origin));
   await rejects(() => owner.provision("bad", origin, pending));
   check((await owner.tableNames()).length === 0, "Unreserved call created schema");
   await registry.reserve(origin, "fresh");
   await rejects(() => owner.provision("bad", origin, { ...pending, generation: 2 }));
   await rejects(() => owner.provision("bad", origin, { ...pending, objectName: "foreign" }));
   await rejects(() => owner.provision("bad", "https://foreign.example", pending));
   await rejects(() => registry.activate(origin, "fresh", "proj_forged"));
   check((await owner.tableNames()).length === 0, "Invalid tuple created schema");
   const { projectId } = await owner.provision("First", origin, pending);
   const route = { ...pending, projectId };
   check(await owner.fenceState() === "pending", "Owner did not stage its fence");
   await rejects(() => owner.addUser("early@example.test", "Early-password-123!", route));
   const retry = await owner.provision("First", origin, pending);
   check(retry.projectId === projectId, "Pending retry changed project ID");
   await rejects(() => owner.evict()); owner = env.NEXTGEN_APPLICATION.getByName("fresh");
   check(await owner.fenceState() === "pending", "Pending fence lost on restart");
   await rejects(() => owner.addUser("restart@example.test", "Restart-password-123!", route));
   await owner.holdActivation();
   const first = registry.activate(origin, "fresh", projectId).then(() => false, () => true);
   while (!await owner.activationHeld()) await new Promise(resolve => setTimeout(resolve, 5));
   check((await registry.resolve(origin)).state === "active", "Registry did not commit route");
   await rejects(() => registry.beginProjectRecovery("move-secret", origin, projectId, "pending-recovery", "pending-era"));
   check(await registry.recoveryStatus("move-secret", projectId) === null, "Recovery was recorded during pending activation");
   await rejects(() => owner.addUser("in-gap@example.test", "Gap-password-123!", route));
   await rejects(() => owner.activateProvisioning({ ...route, generation: 2 }));
   await owner.releaseActivation();
   check(await first, "Injected activation failure was not observed");
   await rejects(() => owner.evict()); owner = env.NEXTGEN_APPLICATION.getByName("fresh");
   await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName("projects");
   await rejects(() => owner.addUser("still-pending@example.test", "Pending-password-123!", route));
   await registry.activate(origin, "fresh", projectId);
   check(await owner.fenceState() === "active", "Activation did not resume");
   await rejects(() => owner.addUser("wrong@example.test", "Wrong-password-123!", { ...route, generation: 2 }));
   await owner.addUser("one@example.test", "One-password-123!", route);
   const other = env.NEXTGEN_APPLICATION.getByName("other");
   const otherPending = { projectId: null, origin: otherOrigin, objectName: "other", generation: 1 };
   await registry.reserve(otherOrigin, "other");
   const otherId = (await other.provision("Other", otherOrigin, otherPending)).projectId;
   await registry.activate(otherOrigin, "other", otherId);
   await other.addUser("two@example.test", "Two-password-123!", { ...otherPending, projectId: otherId });
   check((await owner.testCounts()).users === 1 && (await other.testCounts()).users === 1, "Projects are not isolated");
   let legacyTarget = env.LEGACY_TARGET.getByName("legacy-target");
   await legacyTarget.seedLegacy();
   await rejects(() => legacyTarget.evict()); legacyTarget = env.LEGACY_TARGET.getByName("legacy-target");
   const legacyRejected = async fn => {
     await rejects(fn);
     check(JSON.stringify(await legacyTarget.inspectLegacy()) === JSON.stringify({ version: 1, users: 1, events: 1, history: 0 }), 'Legacy owner changed data before authorized migration');
   };
   await legacyRejected(() => legacyTarget.addUser("bad@example.test", "Bad-password-123!"));
   await legacyRejected(() => legacyTarget.provision("Legacy", "https://legacy-version.example", { projectId: null, origin: "https://legacy-version.example", objectName: "legacy-target", generation: 1 }));
   await legacyRejected(() => legacyTarget.login("user@example.test", "Legacy-password-123!", "127.0.0.1"));
   await other.addUser("two-again@example.test", "Two-password-123!", { ...otherPending, projectId: otherId });
   check((await other.testCounts()).users === 2, "Legacy rejection affected another project");
   const crashOrigin = "https://crash.example";
   let crashOwner = env.NEXTGEN_APPLICATION.getByName("crash");
   const crashRoute = { projectId: null, origin: crashOrigin, objectName: "crash", generation: 1 };
   await registry.reserve(crashOrigin, "crash");
   await crashOwner.failPendingAfterGo();
   await rejects(() => crashOwner.provision("Crash", crashOrigin, crashRoute));
   const committedId = await crashOwner.projectId();
   check(!!committedId && (await crashOwner.tableNames()).includes("mapi_pending_owner"), "Go commit or pending marker missing after interruption");
   check(await crashOwner.identity() === "", "Incomplete owner exposed its project identity");
   const committedCounts = await crashOwner.testCounts();
   await rejects(() => crashOwner.addUser("interrupted@example.test", "Interrupted-password-123!", { ...crashRoute, projectId: committedId }));
   await rejects(() => registry.activate(crashOrigin, "crash", committedId));
   await rejects(() => crashOwner.evict()); crashOwner = env.NEXTGEN_APPLICATION.getByName("crash");
   await rejects(() => crashOwner.addUser("restart@example.test", "Restart-password-123!", { ...crashRoute, projectId: committedId }));
   const resumedId = (await crashOwner.provision("Crash", crashOrigin, crashRoute)).projectId;
   check(resumedId === committedId && JSON.stringify(await crashOwner.testCounts()) === JSON.stringify(committedCounts), "Provisioning retry changed committed rows");
   await registry.activate(crashOrigin, "crash", resumedId);
   await crashOwner.addUser("resumed@example.test", "Resumed-password-123!", { ...crashRoute, projectId: resumedId });
   const webEnv = { ...env, MAPI_APP_ORIGIN: "https://legacy.example", MAPI_OPERATOR_TOKEN: "operator-secret" };
   const request = (path, body) => new Request(`https://legacy.example${path}`, { method: "POST", headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: JSON.stringify(body) });
   let legacyOwner = env.NEXTGEN_APPLICATION.getByName("application");
   await legacyOwner.failPendingAfterGo();
   const interrupted = await application.fetch(request("/_mapi/admin/init", { name: "Legacy entry" }), webEnv);
   check(interrupted.status === 503, `Interrupted legacy init returned ${interrupted.status}`);
   const legacyId = await legacyOwner.projectId(), legacyCounts = await legacyOwner.testCounts();
   check(!!legacyId && await legacyOwner.identity() === "", "Interrupted HTTP init exposed an incomplete owner");
   await rejects(() => legacyOwner.evict()); legacyOwner = env.NEXTGEN_APPLICATION.getByName("application");
   const legacy = await application.fetch(request("/_mapi/admin/init", { name: "Legacy entry" }), webEnv);
   check(legacy.status === 200 && (await legacy.json()).projectId === legacyId, `Legacy init retry failed: ${legacy.status}`);
   check(JSON.stringify(await legacyOwner.testCounts()) === JSON.stringify(legacyCounts) && await legacyOwner.fenceState() === "active", "HTTP retry changed committed rows or failed to activate the fence");
   const multi = await application.fetch(request("/_mapi/admin/projects", { name: "New entry", origin: "https://new.example" }), webEnv);
   check(multi.status === 200 && (await multi.json()).projectId, `Multi-project init failed: ${multi.status}`);
   const goOrigin = "https://multi-go.example", goArgs = { name: "Multi Go retry", origin: goOrigin };
   await registry.reserve(goOrigin, "multi-go");
   let goOwner = env.NEXTGEN_APPLICATION.getByName("multi-go");
   await goOwner.failPendingAfterGo();
   const goFailure = await application.fetch(request("/_mapi/admin/projects", goArgs), webEnv);
   check(goFailure.status === 503, `Interrupted multi-project Go commit returned ${goFailure.status}`);
   const goId = await goOwner.projectId(), goCounts = await goOwner.testCounts();
   check(!!goId && await goOwner.identity() === "", "Interrupted multi-project identity exposed");
   await rejects(() => goOwner.evict()); goOwner = env.NEXTGEN_APPLICATION.getByName("multi-go");
   const goRetry = await application.fetch(request("/_mapi/admin/projects", goArgs), webEnv);
   check(goRetry.status === 200 && (await goRetry.json()).projectId === goId, `Multi-project Go retry failed: ${goRetry.status}`);
   check(await goOwner.fenceState() === "active" && JSON.stringify(await goOwner.testCounts()) === JSON.stringify(goCounts), "Multi-project Go retry changed records or fence");
   const activationOrigin = "https://multi-activation.example", activationArgs = { name: "Multi activation retry", origin: activationOrigin };
   await registry.reserve(activationOrigin, "multi-activation");
   let activationOwner = env.NEXTGEN_APPLICATION.getByName("multi-activation");
   await activationOwner.holdActivation();
   const activationAttempt = application.fetch(request("/_mapi/admin/projects", activationArgs), webEnv);
   while (!await activationOwner.activationHeld()) await new Promise(resolve => setTimeout(resolve, 5));
   const activationId = await activationOwner.projectId(), activationCounts = await activationOwner.testCounts();
   await rejects(() => activationOwner.addUser("early@example.test", "Early-password-123!", { projectId: activationId, origin: activationOrigin, objectName: "multi-activation", generation: 1 }));
   await activationOwner.releaseActivation();
   check((await activationAttempt).status === 503, "Interrupted multi-project activation did not fail");
   await rejects(() => activationOwner.evict()); activationOwner = env.NEXTGEN_APPLICATION.getByName("multi-activation");
   await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName("projects");
   const activationRetry = await application.fetch(request("/_mapi/admin/projects", activationArgs), webEnv);
   check(activationRetry.status === 200 && (await activationRetry.json()).projectId === activationId, `Multi-project activation retry failed: ${activationRetry.status}`);
   check(await activationOwner.fenceState() === "active" && JSON.stringify(await activationOwner.testCounts()) === JSON.stringify(activationCounts), "Multi-project activation retry changed records or fence");
   check((await other.testCounts()).users === 2, "HTTP retry affected another project");
   const collisionOrigin = "https://collision.example";
   await registry.reserve(collisionOrigin, "collision");
   let collisionOwner = env.NEXTGEN_APPLICATION.getByName("collision");
   await collisionOwner.testReserveDestination();
   const collisionRoute = { projectId: null, origin: collisionOrigin, objectName: "collision", generation: 1 };
   const collisionBefore = JSON.stringify(await collisionOwner.tableNames());
   await rejects(() => collisionOwner.provision("Collision", collisionOrigin, collisionRoute));
   check(JSON.stringify(await collisionOwner.tableNames()) === collisionBefore, "Pending provisioning changed a reserved destination");
   await rejects(() => collisionOwner.evict()); collisionOwner = env.NEXTGEN_APPLICATION.getByName("collision");
   await rejects(() => collisionOwner.provision("Collision", collisionOrigin, collisionRoute));
   check(JSON.stringify(await collisionOwner.tableNames()) === collisionBefore, "Destination collision changed data after restart");
   await collisionOwner.testClearDestination();
   const collisionId = (await collisionOwner.provision("Collision", collisionOrigin, collisionRoute)).projectId;
   await registry.activate(collisionOrigin, "collision", collisionId);
   check(await collisionOwner.fenceState() === "active", "Provisioning did not retry after clearing reservation");
   const preflightOrigin = "https://recovery-preflight.example", preflightPending = { projectId: null, origin: preflightOrigin, objectName: "recovery-preflight", generation: 1 };
   await registry.reserve(preflightOrigin, "recovery-preflight");
   let preflightOwner = env.NEXTGEN_APPLICATION.getByName("recovery-preflight");
   const preflightId = (await preflightOwner.provision("Recovery preflight", preflightOrigin, preflightPending)).projectId;
   await registry.activate(preflightOrigin, "recovery-preflight", preflightId);
   const preflightCounts = await preflightOwner.testCounts();
   // A ledger row predating the intent table must still reserve both fields.
   await registry.testOldRecoveryLedger("proj_historical", "historical-id", "historical-era");
   await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName("projects");
   const preflightUnchanged = async () => {
     check(await registry.recoveryIntentStatus("move-secret", preflightId) === null && await registry.recoveryStatus("move-secret", preflightId) === null && (await registry.resolve(preflightOrigin)).state === "active", "Rejected recovery left registry state");
     check(await preflightOwner.fenceState() === "active" && JSON.stringify(await preflightOwner.testCounts()) === JSON.stringify(preflightCounts), "Rejected recovery froze or changed owner");
   };
   await rejects(() => registry.beginProjectRecovery("move-secret", preflightOrigin, preflightId, "historical-id", "fresh-era")); await preflightUnchanged();
   await rejects(() => registry.beginProjectRecovery("move-secret", preflightOrigin, preflightId, "fresh-id", "historical-era")); await preflightUnchanged();
   await preflightOwner.testEpochRows(["already-era"]);
   await rejects(() => registry.beginProjectRecovery("move-secret", preflightOrigin, preflightId, "same-epoch-id", "already-era")); await preflightUnchanged();
   await preflightOwner.testEpochRows([]);
   await rejects(() => registry.beginProjectRecovery("move-secret", preflightOrigin, preflightId, "missing-epoch-id", "new-era")); await preflightUnchanged();
   await preflightOwner.testEpochRows(["0", "0"]);
   await rejects(() => registry.beginProjectRecovery("move-secret", preflightOrigin, preflightId, "ambiguous-epoch-id", "new-era")); await preflightUnchanged();
   await preflightOwner.testEpochRows(["0"]);
   await preflightOwner.holdRecoveryProof();
   const ledgerRace = registry.beginProjectRecovery("move-secret", preflightOrigin, preflightId, "racing-ledger-id", "racing-ledger-era").then(() => false, () => true);
   while (!await preflightOwner.recoveryProofHeld()) await new Promise(resolve => setTimeout(resolve, 5));
   await registry.testOldRecoveryLedger("proj_racing_historical", "racing-ledger-id", "racing-ledger-era");
   await preflightOwner.releaseRecoveryProof();
   check(await ledgerRace, "Ledger collision inserted after proof was ignored"); await preflightUnchanged();
   await rejects(() => preflightOwner.evict()); preflightOwner = env.NEXTGEN_APPLICATION.getByName("recovery-preflight");
   await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName("projects");
   await rejects(() => registry.beginProjectRecovery("move-secret", preflightOrigin, preflightId, "racing-ledger-id", "racing-ledger-era")); await preflightUnchanged();
   const corrected = await registry.beginProjectRecovery("move-secret", preflightOrigin, preflightId, "corrected-id", "corrected-era");
   check(corrected.phase === "closing" && await preflightOwner.fenceState() === "frozen" && JSON.stringify(await preflightOwner.testCounts()) === JSON.stringify(preflightCounts), "Corrected recovery did not resume safely");
   const recovery = await registry.beginProjectRecovery("move-secret", collisionOrigin, collisionId, "checked-recovery", "checked-era");
   check(recovery.phase === "closing", "Active owner recovery did not start");
   check((await registry.beginProjectRecovery("move-secret", collisionOrigin, collisionId, "checked-recovery", "checked-era")).recovery_id === "checked-recovery", "Recovery retry failed");
   await rejects(() => registry.beginProjectRecovery("move-secret", collisionOrigin, collisionId, "other-recovery", "other-era"));
   const raceOrigin = "https://race.example", racePending = { projectId: null, origin: raceOrigin, objectName: "race", generation: 1 };
   await registry.reserve(raceOrigin, "race");
   const raceOwner = env.NEXTGEN_APPLICATION.getByName("race");
   const raceId = (await raceOwner.provision("Race", raceOrigin, racePending)).projectId;
   await registry.activate(raceOrigin, "race", raceId);
   await raceOwner.holdRecoveryProof();
   const raceRecovery = registry.beginProjectRecovery("move-secret", raceOrigin, raceId, "racing-recovery", "racing-era").then(() => false, () => true);
   while (!await raceOwner.recoveryProofHeld()) await new Promise(resolve => setTimeout(resolve, 5));
   await registry.beginRelocation("move-secret", raceOrigin, raceId, "racing-move");
   await raceOwner.releaseRecoveryProof();
   check(await raceRecovery, "Stale recovery proof bypassed relocation intent");
   check(await registry.recoveryStatus("move-secret", raceId) === null, "Stale recovery proof wrote a recovery record");
   const legacyRecoveryOrigin = "https://legacy-recovery.example";
   const legacyPending = { projectId: null, origin: legacyRecoveryOrigin, objectName: "legacy-recovery", generation: 1 };
   await registry.reserve(legacyRecoveryOrigin, "legacy-recovery");
   let legacyRecovery = env.NEXTGEN_APPLICATION.getByName("legacy-recovery");
   const legacyRecoveryId = (await legacyRecovery.provision("Legacy recovery", legacyRecoveryOrigin, legacyPending)).projectId;
   const legacyRecoveryRoute = { ...legacyPending, projectId: legacyRecoveryId };
   await registry.activate(legacyRecoveryOrigin, "legacy-recovery", legacyRecoveryId);
   await legacyRecovery.addUser("legacy@example.test", "Legacy-password-123!", legacyRecoveryRoute);
   await legacyRecovery.testMakeLegacy();
   await rejects(() => legacyRecovery.evict()); legacyRecovery = env.NEXTGEN_APPLICATION.getByName("legacy-recovery");
   const legacyRecoveryCounts = await legacyRecovery.testCounts();
   await legacyRecovery.holdRecoveryFreeze();
   const legacyStart = registry.beginProjectRecovery("move-secret", legacyRecoveryOrigin, legacyRecoveryId, "legacy-recovery-id", "legacy-era").then(() => false, () => true);
   while (!await legacyRecovery.recoveryFreezeHeld()) await new Promise(resolve => setTimeout(resolve, 5));
   check(await registry.recoveryStatus("move-secret", legacyRecoveryId) === null && (await registry.recoveryIntentStatus("move-secret", legacyRecoveryId))?.recovery_id === "legacy-recovery-id", "Legacy recovery intent was not durable before freeze acknowledgement");
   await rejects(() => legacyRecovery.addUser("direct@example.test", "Direct-password-123!"));
   await rejects(() => legacyRecovery.addUser("cached@example.test", "Cached-password-123!", legacyRecoveryRoute));
   await rejects(() => legacyRecovery.addUser("stale@example.test", "Stale-password-123!", { ...legacyRecoveryRoute, generation: 2 }));
   await rejects(() => registry.beginRelocation("move-secret", legacyRecoveryOrigin, legacyRecoveryId, "overlap-move"));
   check(JSON.stringify(await legacyRecovery.testCounts()) === JSON.stringify(legacyRecoveryCounts), "Frozen legacy owner changed records");
   await legacyRecovery.releaseRecoveryFreeze();
   check(await legacyStart, "Lost legacy recovery acknowledgement was not observed");
   await rejects(() => legacyRecovery.evict()); legacyRecovery = env.NEXTGEN_APPLICATION.getByName("legacy-recovery");
   await rejects(() => registry.evict()); registry = env.PROJECT_REGISTRY.getByName("projects");
   await rejects(() => legacyRecovery.addUser("restart@example.test", "Restart-password-123!", legacyRecoveryRoute));
   await rejects(() => registry.beginProjectRecovery("move-secret", legacyRecoveryOrigin, legacyRecoveryId, "different-recovery", "different-era"));
   const legacyRecoveryState = await registry.beginProjectRecovery("move-secret", legacyRecoveryOrigin, legacyRecoveryId, "legacy-recovery-id", "legacy-era");
   check(legacyRecoveryState.phase === "closing", "Legacy recovery did not resume");
   await legacyRecovery.armRecovery("move-secret", legacyRecoveryId, "legacy-recovery-id");
   await legacyRecovery.freezeRecovery("move-secret", legacyRecoveryId, "legacy-recovery-id");
   check(JSON.stringify(await legacyRecovery.testCounts()) === JSON.stringify(legacyRecoveryCounts), "Legacy recovery retry changed data");
   const undrainedOrigin = "https://undrained.example", undrainedPending = { projectId: null, origin: undrainedOrigin, objectName: "undrained", generation: 1 };
   await registry.reserve(undrainedOrigin, "undrained");
   let undrained = env.NEXTGEN_APPLICATION.getByName("undrained");
   const undrainedId = (await undrained.provision("Undrained", undrainedOrigin, undrainedPending)).projectId;
   await registry.activate(undrainedOrigin, "undrained", undrainedId);
   await undrained.testMakeLegacy(true);
   await rejects(() => undrained.evict()); undrained = env.NEXTGEN_APPLICATION.getByName("undrained");
   await rejects(() => registry.beginProjectRecovery("move-secret", undrainedOrigin, undrainedId, "undrained-id", "undrained-era"));
   check(await registry.recoveryIntentStatus("move-secret", undrainedId) === null && await registry.recoveryStatus("move-secret", undrainedId) === null && (await registry.resolve(undrainedOrigin)).state === "active", "Undrained legacy owner began recovery");
   await registry.reserve("https://occupied.example", "project:collision");
   const occupied = env.NEXTGEN_APPLICATION.getByName("project:collision"), occupiedBefore = JSON.stringify(await occupied.tableNames());
   await registry.testCandidates(["project:collision", "project:chosen"]);
   const moving = await registry.beginRelocation("move-secret", origin, projectId, "collision-move");
   check(moving.destination_object === "project:chosen", "Move allocated an occupied project object");
   check(JSON.stringify(await occupied.tableNames()) === occupiedBefore && (await registry.resolve("https://occupied.example")).state === "pending", "Move changed occupied project object");
   await rejects(() => registry.reserve("https://duplicate.example", "project:chosen"));
   check(await registry.resolve("https://duplicate.example") === null, "Pending route reserved a move destination");
   check((await registry.resolve(otherOrigin)).state === "active", "Collision affected another project");
   return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: String(error), stack: error.stack }, { status: 500 }); }
 }
};
