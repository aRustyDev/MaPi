// Service-binding-only control. It must not receive a public route.
const encoder = new TextEncoder();

function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  return a.length === b.length
    ? crypto.subtle.timingSafeEqual(a, b)
    : !crypto.subtle.timingSafeEqual(a, a);
}

export default {
  async fetch(request, env) {
    if (!env.MAPI_OPERATOR_TOKEN || !env.MAPI_PHASE1_CONTROL_TOKEN || !sameToken(request.headers.get('authorization'), `Bearer ${env.MAPI_OPERATOR_TOKEN}`)) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body = await request.json();
    if (!body || typeof body.origin !== 'string' || !['initialize-fence', 'project-token', 'user-audit'].includes(body.action)) return new Response(null, { status: 400 });
    try {
      const registry = env.PROJECT_REGISTRY.getByName('projects');
      const route = await registry.resolve(body.origin);
      if (!route || route.state !== 'active') return new Response(null, { status: 404 });
      const object = env.NEXTGEN_APPLICATION.getByName(route.object_name);
      const result = await object.phase1Control({ projectId: route.project_id, origin: route.origin, objectName: route.object_name, generation: route.generation }, env.MAPI_PHASE1_CONTROL_TOKEN, body.action, body.userId);
      return Response.json({ result }, { headers: { 'cache-control': 'no-store' } });
    } catch {
      return new Response(null, { status: 503 });
    }
  },
};
