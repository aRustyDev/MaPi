// Test-only direct owner RPC probes. Never deployed.
import app, { NextgenApplication } from "../worker/app.js";
import { ProjectRegistry } from "../worker/registry.js";

export class MainRegistry extends ProjectRegistry { constructor(ctx, env) { super(ctx, { ...env, NEXTGEN_APPLICATION: env.TEST_MAIN }); } }
export class MaintenanceRegistry extends ProjectRegistry { constructor(ctx, env) { super(ctx, { ...env, NEXTGEN_APPLICATION: env.TEST_MAINTENANCE }); } }
export class RecoveryRegistry extends ProjectRegistry { constructor(ctx, env) { super(ctx, { ...env, NEXTGEN_APPLICATION: env.TEST_RECOVERY }); } }
export class MainOwner extends NextgenApplication { constructor(ctx, env) { super(ctx, { ...env, PROJECT_REGISTRY: env.MAIN_REGISTRY, NEXTGEN_APPLICATION: env.TEST_MAIN }); } }
export class MaintenanceOwner extends NextgenApplication {
  constructor(ctx, env) { super(ctx, { ...env, PROJECT_REGISTRY: env.MAINTENANCE_REGISTRY, NEXTGEN_APPLICATION: env.TEST_MAINTENANCE, MAPI_MAINTENANCE: "1" }); }
}
export class RecoveryOwner extends NextgenApplication {
  constructor(ctx, env) { super(ctx, { ...env, PROJECT_REGISTRY: env.RECOVERY_REGISTRY, NEXTGEN_APPLICATION: env.TEST_RECOVERY, MAPI_RECOVERY_EPOCH: "1" }); }
}

export default {
  async fetch(_request, env) {
    // The asset is public, but only this exact GET may bypass project routing.
    let assetFetches = 0;
    const staticEnv = { MAPI_OFFICIAL_LOGIN: "1", ASSETS: { fetch: () => { assetFetches++; return new Response("public-sdk"); } }, PROJECT_REGISTRY: { getByName: () => { throw new Error("registry must not be used"); } } };
    for (const hostname of ["issuer.example", "other.example"]) {
      const asset = await app.fetch(new Request(`https://${hostname}/zitadel-login.mjs`), staticEnv);
      if (asset.status !== 200 || await asset.text() !== "public-sdk") throw new Error("public asset unavailable");
    }
    if (assetFetches !== 2) throw new Error("unexpected asset forwarding");
    for (const req of [new Request("https://issuer.example/login"), new Request("https://issuer.example/zitadel-login.mjs", { method: "POST" })]) {
      let rejected = false;
      try { await app.fetch(req, staticEnv); } catch { rejected = true; }
      if (!rejected) throw new Error("non-asset route bypassed registry");
    }
    const origin = "https://issuer.example";
    const main = env.TEST_MAIN.getByName("main");
    const registry = env.MAIN_REGISTRY.getByName("projects");
    await registry.reserve(origin, "main");
    const { projectId } = await main.provision("Guard race test", origin, { projectId: null, origin, objectName: "main", generation: 1 });
    await registry.activate(origin, "main", projectId);
    const route = { projectId, origin, objectName: "main", generation: 1 };
    const request = { method: "POST", url: `${origin}/api/v1/flows/flow_wrong/submit`, headers: { origin: [origin], "content-type": ["application/json"] }, body: new TextEncoder().encode("{}").toBase64(), peer: "192.0.2.1" };
    const check = async (stub, argument, expected) => {
      const result = await stub.flowRequest(request, argument);
      if (result.status !== expected) throw new Error(`expected ${expected}, got ${result.status}`);
    };
    if (!(await main.admitLogin(route)) || await main.admitLogin({ ...route, projectId: "proj_other" }) || await main.admitLogin({ ...route, origin: "https://other.example" }) || await main.admitLogin(undefined)) throw new Error("login route identity/origin admission failed");
    await check(main, { ...route, projectId: "proj_other" }, 503);
    await check(main, { ...route, origin: "https://other.example" }, 503);
    await check(main, undefined, 503);
    const admitted = await main.flowRequest(request, route);
    if (admitted.status >= 500 || admitted.status === 429) throw new Error(`valid route rejected: ${admitted.status}`);
    const wrongOrigin = { ...request, url: "https://other.example/api/v1/flows/flow_wrong/submit" };
    if ((await main.flowRequest(wrongOrigin, route)).status !== 403) throw new Error("cross-origin owner request accepted");

    const maintenance = env.TEST_MAINTENANCE.getByName("maintenance");
    const maintenanceRegistry = env.MAINTENANCE_REGISTRY.getByName("projects");
    await maintenanceRegistry.reserve(origin, "maintenance");
    const maintenanceProject = (await maintenance.provision("Maintenance test", origin, { projectId: null, origin, objectName: "maintenance", generation: 1 })).projectId;
    await maintenanceRegistry.activate(origin, "maintenance", maintenanceProject);
    const maintenanceRoute = { projectId: maintenanceProject, origin, objectName: "maintenance", generation: 1 };
    await check(maintenance, maintenanceRoute, 503);
    if (await maintenance.admitLogin(maintenanceRoute)) throw new Error("maintenance login admitted");
    const recovery = env.TEST_RECOVERY.getByName("recovery");
    const recoveryRegistry = env.RECOVERY_REGISTRY.getByName("projects");
    await recoveryRegistry.reserve(origin, "recovery");
    const recoveryProject = (await recovery.provision("Recovery test", origin, { projectId: null, origin, objectName: "recovery", generation: 1 })).projectId;
    await recoveryRegistry.activate(origin, "recovery", recoveryProject);
    const recoveryRoute = { projectId: recoveryProject, origin, objectName: "recovery", generation: 1 };
    await check(recovery, recoveryRoute, 503);
    if (await recovery.admitLogin(recoveryRoute)) throw new Error("recovery login admitted");

    // The earlier valid probe consumed one password slot. The rest race on one
    // object's synchronous owner turn; exactly 59 may pass before the bound.
    const results = await Promise.all(Array.from({ length: 65 }, () => main.flowRequest(request, route)));
    const allowed = results.filter(r => r.status !== 429).length;
    if (allowed !== 59 || results.filter(r => r.status === 429).length !== 6) throw new Error(`password throttle race: ${allowed} admitted`);
    await main.oauthAdmin("initialize", {}, route);
    const oauth = await main.oauthRequest({ method: "GET", url: `${origin}/oauth/${projectId}/jwks`, headers: {}, body: "", peer: request.peer }, route);
    if (oauth.status === 429) throw new Error("password throttle exhausted OAuth budget");
    return Response.json({ ok: true, allowed, rejected: 6, oauthStatus: oauth.status });
  },
};
