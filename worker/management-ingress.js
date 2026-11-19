import { handleManagementIngress, isManagementRoute } from './management-proxy.js';
const noStore = { 'cache-control': 'no-store' };

// Shared by the separate management build and its local end-to-end harness.
export async function handleManagementApp(request, env, fallback) {
  const url = new URL(request.url);
  if (!isManagementRoute(request.method, url.pathname)) return fallback.fetch(request, env);
  if (env.MAPI_MANAGEMENT_ENABLED !== '1') return new Response(null, { status: 404, headers: noStore });
  if (env.MAPI_MAINTENANCE === '1') return new Response(null, { status: 503, headers: noStore });
  try {
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    const route = await registry.resolve(url.origin);
    if (!route || route.state !== 'active' || route.origin !== url.origin) return new Response(null, { status: 404, headers: noStore });
    const object = env.NEXTGEN_APPLICATION.getByName(route.object_name);
    const status = await object.status();
    if (!status.recoveryReady || status.maintenance === true ||
        (env.MAPI_REQUIRE_OWNER_MAINTENANCE_CHECK === '1' && status.maintenance !== false)) {
      return new Response(null, { status: 503, headers: noStore });
    }
    return handleManagementIngress(request, registry, env.NEXTGEN_APPLICATION);
  } catch {
    return new Response(null, { status: 503, headers: noStore });
  }
}
