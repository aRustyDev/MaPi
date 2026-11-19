import app, { NextgenApplication, ProjectRegistry } from '../worker/generated/combined-test-app.js';
export { NextgenApplication, ProjectRegistry };
// Synthetic-only owner helper for end-to-end tests. Never deploy this entry.
export default { async fetch(request, env) {
 const url = new URL(request.url);
 if (url.pathname === '/_mapi/test/management-token') {
  if (env.MAPI_LOCAL_TEST !== '1' || request.headers.get('authorization') !== `Bearer ${env.MAPI_OPERATOR_TOKEN}` || !['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(null, { status: 404 });
  const registry = env.PROJECT_REGISTRY.getByName('projects'); const route = await registry.resolve(url.origin);
  if (!route || route.state !== 'active') return new Response(null, { status: 404 });
  return Response.json({ token: await env.NEXTGEN_APPLICATION.getByName(route.object_name).testManagementToken() }, { headers: { 'cache-control': 'no-store' } });
 }
 return app.fetch(request, env);
}};
