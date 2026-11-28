// Test-only router. This fixture is used with a disposable local namespace.
export { SessionFence } from "./session-fence.mjs";

const operations = new Set(["linkGrant", "admit", "settle", "release", "close", "cleanupStatus", "confirmCleanup"]);

export default {
  async fetch(request, env) {
    const { session, operation, args } = await request.json();
    if (!operations.has(operation)) return new Response(null, { status: 404 });
    const stub = env.FENCE.getByName(session);
    return Response.json(await stub[operation](...args));
  },
};
