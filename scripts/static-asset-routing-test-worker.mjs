import application from "../worker/app.js";

// Exercise the actual Worker entry point. Any attempted registry or owner
// access is a test failure, while ASSETS is the real local asset binding.
export default {
  async fetch(request, env) {
    const calls = { assets: 0, registry: 0, owner: 0 };
    const binding = {
      ...env,
      MAPI_OFFICIAL_LOGIN: request.headers.get("x-test-login-enabled") === "0" ? "0" : "1",
      ASSETS: { fetch: (input) => { calls.assets++; return env.ASSETS.fetch(input); } },
      PROJECT_REGISTRY: { getByName: () => { calls.registry++; throw new Error("registry called"); } },
      NEXTGEN_APPLICATION: { getByName: () => { calls.owner++; throw new Error("owner called"); } },
    };
    let response;
    try { response = await application.fetch(request, binding); }
    catch { response = new Response(null, { status: 598 }); }
    const headers = new Headers(response.headers);
    for (const [name, count] of Object.entries(calls)) headers.set(`x-test-${name}-calls`, String(count));
    return new Response(response.body, { status: response.status, headers });
  },
};
