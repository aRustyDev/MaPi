// Test-only direct owner RPC probes. Never deployed.
import { NextgenApplication } from "../worker/app.js";

export { NextgenApplication };
export class MaintenanceOwner extends NextgenApplication {
  constructor(ctx, env) { super(ctx, { ...env, MAPI_MAINTENANCE: "1" }); }
}
export class RecoveryOwner extends NextgenApplication {
  constructor(ctx, env) { super(ctx, { ...env, MAPI_RECOVERY_EPOCH: "1" }); }
}

export default {
  async fetch(_request, env) {
    const origin = "https://issuer.example";
    const main = env.TEST_MAIN.getByName("main");
    const { projectId } = await main.provision("Guard race test", origin);
    const route = { projectId, origin };
    const request = { method: "POST", url: `${origin}/api/v1/flows/flow_wrong/submit`, headers: { origin: [origin], "content-type": ["application/json"] }, body: new TextEncoder().encode("{}").toBase64(), peer: "192.0.2.1" };
    const check = async (stub, argument, expected) => {
      const result = await stub.flowRequest(request, argument);
      if (result.status !== expected) throw new Error(`expected ${expected}, got ${result.status}`);
    };
    await check(main, { ...route, projectId: "proj_other" }, 503);
    await check(main, { ...route, origin: "https://other.example" }, 503);
    await check(main, undefined, 503);
    const admitted = await main.flowRequest(request, route);
    if (admitted.status >= 500 || admitted.status === 429) throw new Error(`valid route rejected: ${admitted.status}`);
    const wrongOrigin = { ...request, url: "https://other.example/api/v1/flows/flow_wrong/submit" };
    if ((await main.flowRequest(wrongOrigin, route)).status !== 403) throw new Error("cross-origin owner request accepted");

    const maintenance = env.TEST_MAINTENANCE.getByName("maintenance");
    const maintenanceProject = (await maintenance.provision("Maintenance test", origin)).projectId;
    await check(maintenance, { projectId: maintenanceProject, origin }, 503);
    const recovery = env.TEST_RECOVERY.getByName("recovery");
    const recoveryProject = (await recovery.provision("Recovery test", origin)).projectId;
    await check(recovery, { projectId: recoveryProject, origin }, 503);

    // The earlier valid probe consumed one password slot. The rest race on one
    // object's synchronous owner turn; exactly 59 may pass before the bound.
    const results = await Promise.all(Array.from({ length: 65 }, () => main.flowRequest(request, route)));
    const allowed = results.filter(r => r.status !== 429).length;
    if (allowed !== 59 || results.filter(r => r.status === 429).length !== 6) throw new Error(`password throttle race: ${allowed} admitted`);
    await main.oauthAdmin("initialize");
    const oauth = await main.oauthRequest({ method: "GET", url: `${origin}/oauth/${projectId}/jwks`, headers: {}, body: "", peer: request.peer }, route);
    if (oauth.status === 429) throw new Error("password throttle exhausted OAuth budget");
    return Response.json({ ok: true, allowed, rejected: 6, oauthStatus: oauth.status });
  },
};
