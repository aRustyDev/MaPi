import { NextgenApplication, ProjectRegistry } from "../worker/generated/phase1-owner-app.js";
export { ProjectRegistry };
import { initializeOwnerFence, freezeOwnerFence } from "../worker/owner-fence.js";

export class AppOwnerFenceTest extends NextgenApplication {
  async arm(route) { initializeOwnerFence(this.ctx.storage, route); await this.ctx.storage.sync(); }
  freeze(route) { freezeOwnerFence(this.ctx.storage, route, "test-move"); }
  throttleCount() { return this.ctx.storage.sql.exec("SELECT COALESCE(SUM(count), 0) AS count FROM mapi_login_limits").one().count; }
  issuerKeyCount() { return this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM mapi_oauth_signing_keys").one().count; }
}
const reject = async (fn) => { try { await fn(); } catch { return; } throw Error("Expected rejection"); };
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
      let before = await owner.testCounts();
      await owner.arm(route);
      await reject(() => owner.evict());
      owner = env.OWNER.getByName("application");
      if (!(await owner.admitLogin(route))) throw Error("Current route rejected");
      const token = await owner.phase1Control(route, "test-control-token", "project-token");
      if (typeof token !== "string" || !token) throw Error("Private control did not mint a project token");
      before = await owner.testCounts();
      await reject(() => owner.phase1Control(route, "bad-control-token", "project-token"));
      await reject(() => owner.phase1Control({ ...route, generation: 2 }, "test-control-token", "project-token"));
      if (await owner.admitLogin({ ...route, generation: 2 })) throw Error("Stale route accepted");
      await reject(() => owner.addUser("bad@example.com", "Password-bad-123!", { ...route, generation: 2 }));
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(before)) throw Error("Stale write changed data or audit");
      await owner.failNextAudit();
      await reject(() => owner.addUser("after@example.com", "Password-after-123!", route));
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(before)) throw Error("Audit failure did not roll back fenced user creation");
      const user = await owner.addUser("after@example.com", "Password-after-123!", route);
      if (await owner.phase1Control(route, "test-control-token", "user-audit", user.userId) !== 1) throw Error("Private control did not find the mutation audit");
      const userRead = { method: "GET", url: `${origin}/api/v1/users/${user.userId}`, headers: { authorization: [`Bearer ${token}`] }, body: "", peer: "192.0.2.12" };
      if ((await owner.handleRequest(userRead, route)).status !== 200) throw Error("Current route rejected a Go management read");
      if ((await owner.handleRequest(userRead, { ...route, generation: 2 })).status !== 503) throw Error("Stale route accepted a Go management read");
      await owner.oauthAdmin("initialize", {}, route);
      const issuerKeys = await owner.issuerKeyCount();
      const stale = { ...route, generation: 2 };
      await reject(() => owner.oauthAdmin("rotate", {}, stale));
      if (await owner.issuerKeyCount() !== issuerKeys) throw Error("Stale issuer administration changed signing keys");
      await owner.oauthAdmin("rotate", {}, route);
      if (await owner.issuerKeyCount() !== issuerKeys + 1) throw Error("Authorized issuer rotation did not commit");
      const flow = { method: "POST", url: `${origin}/api/v1/flows/flow_missing/submit`, headers: { origin: [origin], "content-type": ["application/json"] }, body: new TextEncoder().encode("{}").toBase64(), peer: "192.0.2.12" };
      const oauth = { method: "GET", url: `${origin}/oauth/${projectId}/jwks`, headers: {}, body: "", peer: "192.0.2.12" };
      const oldThrottle = await owner.throttleCount();
      if ((await owner.flowRequest(flow, stale)).status !== 503 || (await owner.oauthRequest(oauth, stale)).status !== 503) throw Error("Stale flow or OAuth route accepted");
      if (await owner.throttleCount() !== oldThrottle) throw Error("Stale flow or OAuth request changed throttle state");
      if ((await owner.flowRequest(flow, route)).status >= 500 || (await owner.oauthRequest(oauth, route)).status !== 200) throw Error("Current flow or OAuth route rejected");
      const after = await owner.testCounts();
      if (after.users !== before.users + 1 || after.events <= before.events) throw Error("Authorized Go mutation did not write user and audit");
      await owner.freeze(route);
      await reject(() => owner.addUser("frozen@example.com", "Password-frozen-123!", route));
      await reject(() => owner.oauthAdmin("rotate", {}, route));
      if ((await owner.handleRequest(userRead, route)).status !== 503) throw Error("Frozen owner accepted a Go management read");
      if ((await owner.flowRequest(flow, route)).status !== 503 || (await owner.oauthRequest(oauth, route)).status !== 503) throw Error("Frozen owner accepted a flow or OAuth request");
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(after)) throw Error("Frozen write changed data or audit");
      await reject(() => owner.evict());
      owner = env.OWNER.getByName("application");
      await reject(() => owner.addUser("restart@example.com", "Password-restart-123!", route));
      if (JSON.stringify(await owner.testCounts()) !== JSON.stringify(after)) throw Error("Frozen owner state changed after restart");
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
