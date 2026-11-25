// Deploy only as a service-binding-only Worker for a fresh synthetic staging
// namespace. It deliberately cannot select a project, origin, or move from a
// request. Never attach routes, workers.dev, preview URLs, or a public caller.
const encode = new TextEncoder();
function authorized(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = encode.encode(actual), b = encode.encode(`Bearer ${expected}`);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
export default {
  async fetch(request, env) {
    if (env.MAPI_REHEARSAL_SYNTHETIC_ONLY !== '1' || !authorized(request.headers.get('authorization'), env.MAPI_REHEARSAL_OPERATOR_TOKEN)) return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!env.MAPI_RELOCATION_CONTROL_TOKEN || !env.MAPI_REHEARSAL_ORIGIN || !env.MAPI_REHEARSAL_PROJECT_ID || !env.MAPI_REHEARSAL_MOVE_ID || !env.RELOCATION_COORDINATOR) return new Response(null, { status: 503 });
    const path = new URL(request.url).pathname;
    try {
      if (path === '/management-token') {
        if (!env.MAPI_PHASE1_CONTROL_TOKEN || !env.MAPI_REHEARSAL_OTHER_ORIGIN || !env.MAPI_REHEARSAL_OTHER_PROJECT_ID || !env.PROJECT_REGISTRY || !env.NEXTGEN_APPLICATION || env.MAPI_REHEARSAL_OTHER_ORIGIN === env.MAPI_REHEARSAL_ORIGIN || env.MAPI_REHEARSAL_OTHER_PROJECT_ID === env.MAPI_REHEARSAL_PROJECT_ID) return new Response(null, { status: 503 });
        const route = await env.PROJECT_REGISTRY.getByName('projects').resolve(env.MAPI_REHEARSAL_OTHER_ORIGIN);
        if (!route || route.state !== 'active' || route.origin !== env.MAPI_REHEARSAL_OTHER_ORIGIN || route.project_id !== env.MAPI_REHEARSAL_OTHER_PROJECT_ID || route.object_name === 'application' || route.generation !== 1) throw Error('Synthetic second project identity differs');
        const authority = { projectId: route.project_id, origin: route.origin, objectName: route.object_name, generation: route.generation };
        const owner = env.NEXTGEN_APPLICATION.getByName(route.object_name);
        await owner.phase1Control(authority, env.MAPI_PHASE1_CONTROL_TOKEN, 'initialize-fence');
        const token = await owner.phase1Control(authority, env.MAPI_PHASE1_CONTROL_TOKEN, 'project-token');
        if (typeof token !== 'string' || !token) throw Error('Synthetic management token missing');
        return Response.json({ token }, { headers: { 'cache-control': 'no-store' } });
      }
      if (path === '/evidence') {
        const raw = new URL(request.url).searchParams.get('after') ?? '0';
        if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) return new Response(null, { status: 400 });
        const coordinator = env.RELOCATION_COORDINATOR.getByName('synthetic-rehearsal');
        const result = await coordinator.evidence(env.MAPI_RELOCATION_CONTROL_TOKEN, env.MAPI_REHEARSAL_PROJECT_ID, env.MAPI_REHEARSAL_MOVE_ID, Number(raw));
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      }
      if (path === '/stale-probe') {
        if (!env.PROJECT_REGISTRY || !env.NEXTGEN_APPLICATION) return new Response(null, { status: 503 });
        const { route, move } = await env.PROJECT_REGISTRY.getByName('projects').relocationStatus(env.MAPI_RELOCATION_CONTROL_TOKEN, env.MAPI_REHEARSAL_PROJECT_ID);
        if (!route || route.origin !== env.MAPI_REHEARSAL_ORIGIN || route.project_id !== env.MAPI_REHEARSAL_PROJECT_ID || move?.phase !== 'committed' || move.move_id !== env.MAPI_REHEARSAL_MOVE_ID || move.source_object !== 'application' || route.object_name !== move.destination_object || route.generation !== move.generation + 1) throw Error('Synthetic move identity differs');
        const oldRoute = { projectId: route.project_id, origin: route.origin, objectName: move.source_object, generation: move.generation };
        const source = env.NEXTGEN_APPLICATION.getByName(move.source_object);
        try { await source.addUser(`stale-${crypto.randomUUID()}@example.invalid`, `Synthetic-${crypto.randomUUID()}!`, oldRoute); }
        catch (error) {
          if (String(error).includes('Owner is fenced or route is stale')) return Response.json({ rejected: true, generation: move.generation }, { headers: { 'cache-control': 'no-store' } });
          throw error;
        }
        throw Error('Stale source unexpectedly accepted a write');
      }
      if (path !== '/') return new Response(null, { status: 404 });
      const coordinator = env.RELOCATION_COORDINATOR.getByName('synthetic-rehearsal');
      const result = await coordinator.advance(env.MAPI_RELOCATION_CONTROL_TOKEN, env.MAPI_REHEARSAL_ORIGIN, env.MAPI_REHEARSAL_PROJECT_ID, env.MAPI_REHEARSAL_MOVE_ID);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (path === '/evidence' && String(error).includes('Evidence index preparation in progress; retry')) return Response.json({ pending: true }, { status: 503, headers: { 'cache-control': 'no-store' } });
      return new Response(null, { status: 503 });
    }
  },
};
