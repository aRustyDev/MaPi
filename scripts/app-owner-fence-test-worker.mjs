import { NextgenApplication } from "../worker/app.js";
import { initializeOwnerFence, freezeOwnerFence } from "../worker/owner-fence.js";
import { ProjectRegistry } from "../worker/registry.js";
export { ProjectRegistry };
export class MaintenanceRegistry extends ProjectRegistry {
  constructor(ctx, env) { super(ctx, { ...env, NEXTGEN_APPLICATION: env.MAINTENANCE_OWNER }); }
}

export class AppOwnerFenceTest extends NextgenApplication {
  async arm(route) { initializeOwnerFence(this.ctx.storage, route); await this.ctx.storage.sync(); }
  freeze(route) { freezeOwnerFence(this.ctx.storage, route, "test-move"); }
  changeFenceTableCase() {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("ALTER TABLE mapi_owner_fence RENAME TO test_fence_tmp");
      sql.exec("ALTER TABLE test_fence_tmp RENAME TO MAPI_OWNER_FENCE");
    });
  }
  throttleCount() { return this.ctx.storage.sql.exec("SELECT COALESCE(SUM(count), 0) AS count FROM mapi_login_limits").one().count; }
  setThrottleAuthorityFault(enabled) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    if (enabled) {
      this.ctx.storage.sql.exec(`CREATE TRIGGER test_throttle_authority_change AFTER INSERT ON mapi_login_limits
        BEGIN UPDATE mapi_owner_fence SET generation = generation + 1 WHERE singleton = 1; END`);
    } else {
      this.ctx.storage.sql.exec("DROP TRIGGER test_throttle_authority_change");
    }
  }
  fenceSideEffects() {
    const sql = this.ctx.storage.sql;
    const columns = sql.exec("PRAGMA table_info(events)").toArray().map(({ name }) => `quote("${name.replaceAll('"', '""')}")`);
    return {
      throttle: sql.exec("SELECT key, CAST(window AS TEXT) AS window, count FROM mapi_login_limits ORDER BY key").toArray(),
      events: sql.exec(`SELECT ${columns.join(", ")} FROM events ORDER BY rowid`).toArray(),
    };
  }
}
export class MaintenanceOwner extends AppOwnerFenceTest {
  constructor(ctx, env) { super(ctx, { ...env, PROJECT_REGISTRY: env.MAINTENANCE_REGISTRY, NEXTGEN_APPLICATION: env.MAINTENANCE_OWNER, MAPI_MAINTENANCE: "1", MAPI_RECOVERY_EPOCH: "new-era" }); }
}
const reject = async (fn) => { try { await fn(); } catch { return; } throw Error("Expected rejection"); };
const rejectRecovery = async (fn) => {
  try { await fn(); } catch (error) { if (String(error).includes("Coordinated recovery is required")) return; throw error; }
  throw Error("Recovery bypassed the owner fence");
};
export default {
  async fetch(_request, env) {
    try {
      const origin = "https://owner.example";
      let owner = env.OWNER.getByName("application");
      const registry = env.PROJECT_REGISTRY.getByName("projects");
      await registry.reserve(origin, "application");
      const projectId = (await owner.provision("Owner fence test", origin, { projectId: null, origin, objectName: "application", generation: 1 })).projectId;
      await registry.activate(origin, "application", projectId);
      const route = { projectId, origin, objectName: "application", generation: 1 };
      await owner.addUser("before@example.com", "Password-before-123!", route);
      const before = await owner.testCounts();
      await owner.arm(route);
      const armedEffects = JSON.stringify(await owner.fenceSideEffects());
      await reject(() => owner.allowLogin("192.0.2.17"));
      if (JSON.stringify(await owner.fenceSideEffects()) !== armedEffects || JSON.stringify(await owner.testCounts()) !== JSON.stringify(before)) throw Error("Direct throttle call changed state on an armed owner");
      await reject(() => owner.addUser("cached-stale@example.com", "Password-stale-123!", { ...route, generation: 2 }));
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(before)) throw Error("Cached owner accepted a stale write after arming");
      if (!(await owner.status(true, route)).ready || (await owner.status(true, { ...route, generation: 2 })).ready) throw Error("Runtime readiness did not enforce the route");
      await reject(() => owner.provision("Owner fence test", origin, { ...route, generation: 2 }));
      if ((await owner.provision("Owner fence test", origin, route)).projectId !== projectId) throw Error("Current route could not verify provisioning");
      await reject(() => owner.evict());
      owner = env.OWNER.getByName("application");
      if (!(await owner.admitLogin(route))) throw Error("Current route rejected");
      if (await owner.admitLogin({ ...route, generation: 2 })) throw Error("Stale route accepted");
      await reject(() => owner.addUser("bad@example.com", "Password-bad-123!", { ...route, generation: 2 }));
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(before)) throw Error("Stale write changed data or audit");
      await owner.addUser("after@example.com", "Password-after-123!", route);
      const beforeThrottleFault = JSON.stringify(await owner.fenceSideEffects());
      await owner.setThrottleAuthorityFault(true);
      await reject(() => owner.login("before@example.com", "Password-before-123!", "192.0.2.20", route));
      await owner.setThrottleAuthorityFault(false);
      if (JSON.stringify(await owner.fenceSideEffects()) !== beforeThrottleFault || !(await owner.admitLogin(route))) {
        throw Error("A throttle write committed after changing owner authority");
      }
      const beforeLoginThrottle = await owner.throttleCount();
      const signedIn = await owner.login("before@example.com", "Password-before-123!", "192.0.2.1", route);
      if (signedIn.status !== 200 || !signedIn.cookie) throw Error("Authorized Go login failed");
      if (await owner.throttleCount() !== beforeLoginThrottle + 2) throw Error("Authorized login did not persist both throttle buckets");
      const session = await owner.session(signedIn.cookie, "read", "", route);
      if (session.status !== 200) throw Error("Authorized session read failed");
      const beforeStaleAuth = await owner.testCounts();
      const beforeStaleEffects = JSON.stringify(await owner.fenceSideEffects());
      await reject(() => owner.login("before@example.com", "Password-before-123!", "192.0.2.1", { ...route, generation: 2 }));
      await reject(() => owner.session(signedIn.cookie, "read", "", { ...route, generation: 2 }));
      await reject(() => owner.allowLogin("192.0.2.18"));
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(beforeStaleAuth) || JSON.stringify(await owner.fenceSideEffects()) !== beforeStaleEffects) throw Error("Stale auth changed data, audit, or throttle");
      const after = await owner.testCounts();
      if (after.users !== before.users + 1 || after.events <= before.events) throw Error("Authorized Go mutation did not write user and audit");
      await owner.freeze(route);
      const frozenEffects = JSON.stringify(await owner.fenceSideEffects());
      await reject(() => owner.addUser("frozen@example.com", "Password-frozen-123!", route));
      await reject(() => owner.login("before@example.com", "Password-before-123!", "192.0.2.1", route));
      await reject(() => owner.session(signedIn.cookie, "read", "", route));
      await reject(() => owner.allowLogin("192.0.2.19"));
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(after) || JSON.stringify(await owner.fenceSideEffects()) !== frozenEffects) throw Error("Frozen write changed data, audit, or throttle");
      await reject(() => owner.evict());
      owner = env.OWNER.getByName("application");
      await reject(() => owner.addUser("restart@example.com", "Password-restart-123!", route));
      await owner.changeFenceTableCase();
      await reject(() => owner.evict());
      owner = env.OWNER.getByName("application");
      await reject(() => owner.addUser("mixed-case@example.com", "Password-restart-123!", route));
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(after) || JSON.stringify(await owner.fenceSideEffects()) !== frozenEffects) throw Error("Frozen owner effects changed after case-varied restart");
      const recovery = env.MAINTENANCE_OWNER.getByName("recovery");
      const maintenanceRegistry = env.MAINTENANCE_REGISTRY.getByName("projects");
      await maintenanceRegistry.reserve(origin, "recovery");
      const recoveryProject = (await recovery.provision("Recovery fence test", origin, { projectId: null, origin, objectName: "recovery", generation: 1 })).projectId;
      await maintenanceRegistry.activate(origin, "recovery", recoveryProject);
      const recoveryRoute = { projectId: recoveryProject, origin, objectName: "recovery", generation: 1 };
      await recovery.arm(recoveryRoute);
      await rejectRecovery(() => recovery.recover(recoveryRoute));
      await rejectRecovery(() => recovery.restore("test-bookmark", recoveryRoute));
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
