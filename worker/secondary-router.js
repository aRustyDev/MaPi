// A second hostname reaches the same authoritative application Worker.
// The registry in that Worker chooses the project from the original origin.
export default {
  async fetch(request, env) {
    if (new URL(request.url).origin !== env.MAPI_ROUTER_ORIGIN) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    return env.MAPI_OWNER.fetch(request);
  },
};
