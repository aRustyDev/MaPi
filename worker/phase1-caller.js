// Local benchmark adapter for a private control service binding. This Worker
// has no public route and must only be run with an explicit loopback listener.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.MAPI_PHASE1_LOCAL_CALLER !== '1' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    return env.PHASE1_CONTROL.fetch(request);
  },
};
