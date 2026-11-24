import app from "../worker/app.js";

export default {
  async fetch() {
    const origin = "https://project.example";
    const authority = { projectId: "proj_test", origin, objectName: "application", generation: 4 };
    const route = { project_id: authority.projectId, origin, object_name: authority.objectName, state: "active", generation: authority.generation };
    const observed = [];
    const record = (name, args) => { observed.push([name, args]); };
    const object = {
      async identity() { return authority.projectId; },
      async status() { return { ready: true, recoveryReady: true, maintenance: false }; },
      async addUser(...args) { record("addUser", args); return { userId: "user_test" }; },
      async oauthAdmin(...args) { record("oauthAdmin", args); return {}; },
      async handleRequest(...args) { record("handleRequest", args); return { status: 200, headers: {}, body: null }; },
      async login(...args) { record("login", args); return { status: 200, cookie: "cookie" }; },
      async session(...args) { record("session", args); return { status: 200, data: { csrf_token: "token" } }; },
      async admitLogin(...args) { record("admitLogin", args); return true; },
      async bookmark(...args) { record("bookmark", args); return "test"; },
      async recover(...args) { record("recover", args); },
      async restore(...args) { record("restore", args); },
      async provision(...args) { record("provision", args); return { projectId: authority.projectId }; },
    };
    const registry = { async resolve() { return route; }, async activate() { return route; }, async reserve() { return route; } };
    const env = { MAPI_APP_ORIGIN: origin, MAPI_OPERATOR_TOKEN: "token", MAPI_MASTER_KEY: "present", MAPI_OIDC_EXPERIMENTAL: "1", PROJECT_REGISTRY: { getByName() { return registry; } }, NEXTGEN_APPLICATION: { getByName() { return object; } } };
    const send = (path, options = {}) => app.fetch(new Request(origin + path, options), env);
    const admin = { authorization: "Bearer token", "content-type": "application/json" };
    try {
      await send("/_mapi/admin/users", { method: "POST", headers: admin, body: JSON.stringify({ email: "user@example.com", password: "password" }) });
      await send("/_mapi/admin/oidc/init", { method: "POST", headers: admin, body: "{}" });
      await send("/readyz");
      await send("/login", { method: "POST", headers: { origin }, body: new URLSearchParams({ email: "user@example.com", password: "password" }) });
      await send("/app", { headers: { cookie: "session" } });
      await send("/_mapi/admin/bookmark", { headers: admin });
      await send("/_mapi/admin/init", { method: "POST", headers: admin, body: JSON.stringify({ name: "project" }) });
      await send("/_mapi/admin/projects", { method: "POST", headers: admin, body: JSON.stringify({ name: "project", origin }) });
      env.MAPI_MAINTENANCE = "1";
      await send("/_mapi/admin/recover", { method: "POST", headers: admin });
      await send("/_mapi/admin/restore", { method: "POST", headers: admin, body: JSON.stringify({ bookmark: "test" }) });
      const expected = ["addUser", "oauthAdmin", "handleRequest", "login", "session", "session", "bookmark", "provision", "provision", "recover", "restore"];
      if (JSON.stringify(observed.map(([name]) => name)) !== JSON.stringify(expected)) throw Error("Expected owner routes were not exercised");
      for (const [name, args] of observed) {
        if (JSON.stringify(args[args.length - 1]) !== JSON.stringify(authority)) throw Error(`Missing authority for ${name}`);
      }
      env.MAPI_MAINTENANCE = "0";
      route.state = "moving";
      const count = observed.length;
      const movingUser = await send("/_mapi/admin/users", { method: "POST", headers: admin, body: JSON.stringify({ email: "user@example.com", password: "password" }) });
      const movingCreate = await send("/_mapi/admin/projects", { method: "POST", headers: admin, body: JSON.stringify({ name: "project", origin }) });
      if (movingUser.status !== 503 || movingCreate.status !== 503 || observed.length !== count) throw Error("Moving route admitted a mutation");
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
