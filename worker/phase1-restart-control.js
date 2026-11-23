// Never attach this synthetic-only service to a public route or workers.dev.
import base from './relocation-rehearsal-control.js';
const enc = new TextEncoder();
function authorized(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = enc.encode(actual), b = enc.encode(`Bearer ${expected}`);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['/restart', '/restart-probe'].includes(url.pathname)) return base.fetch(request, env);
    if (env.MAPI_REHEARSAL_SYNTHETIC_ONLY !== '1' || env.MAPI_RESTART_REHEARSAL !== '1' || !authorized(request.headers.get('authorization'), env.MAPI_REHEARSAL_OPERATOR_TOKEN)) return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!env.MAPI_RELOCATION_CONTROL_TOKEN || !env.MAPI_REHEARSAL_ORIGIN || !env.MAPI_REHEARSAL_PROJECT_ID || !env.MAPI_REHEARSAL_MOVE_ID) return new Response(null, { status: 503 });
    const coordinator = env.RELOCATION_COORDINATOR.getByName('synthetic-rehearsal');
    try {
      if (url.pathname === '/restart-probe') return Response.json(await coordinator.restartProbe(env.MAPI_RELOCATION_CONTROL_TOKEN, env.MAPI_REHEARSAL_ORIGIN, env.MAPI_REHEARSAL_PROJECT_ID, env.MAPI_REHEARSAL_MOVE_ID), { headers: { 'cache-control': 'no-store' } });
      const stage = url.searchParams.get('stage');
      if (!['frozen', 'importing', 'committed', 'activated'].includes(stage)) return new Response(null, { status: 400 });
      await coordinator.restartAt(env.MAPI_RELOCATION_CONTROL_TOKEN, env.MAPI_REHEARSAL_ORIGIN, env.MAPI_REHEARSAL_PROJECT_ID, env.MAPI_REHEARSAL_MOVE_ID, stage);
      return new Response(null, { status: 500 }); // An abort must never return normally.
    } catch { return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } }); }
  },
};
