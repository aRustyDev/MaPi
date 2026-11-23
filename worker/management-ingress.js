import { logOverload } from './runtime-diagnostics.js';
import { handleManagementIngress, isManagementRoute, isManagementRouteUnavailable, isValidManagementRoute } from './management-proxy.js';
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
    if (!isValidManagementRoute(route, url.origin)) return new Response(null, { status: 404, headers: noStore });
    if (isManagementRouteUnavailable(route)) return new Response(null, { status: 503, headers: noStore });
    if (route.state !== 'active') return new Response(null, { status: 404, headers: noStore });
    const object = env.NEXTGEN_APPLICATION.getByName(route.object_name);
    const status = await object.status(false, { projectId: route.project_id, origin: route.origin, objectName: route.object_name, generation: route.generation });
    if (!status.recoveryReady || status.fenceReady === false || status.maintenance === true ||
        (env.MAPI_REQUIRE_OWNER_MAINTENANCE_CHECK === '1' && status.maintenance !== false)) {
      return new Response(null, { status: 503, headers: noStore });
    }
    return handleManagementIngress(request, registry, env.NEXTGEN_APPLICATION);
  } catch (error) {
    logOverload(error, 'management');
    return new Response(null, { status: 503, headers: noStore });
  }
}
