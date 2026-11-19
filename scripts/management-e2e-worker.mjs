import app, { NextgenApplication, ProjectRegistry } from '../worker/generated/management-test-app.js';
import { handleManagementApp } from '../worker/management-ingress.js';
export { NextgenApplication, ProjectRegistry };
// Test-only entry point. Project credentials are never exported by app.js;
// this synthetic local-only harness obtains them to verify real Bearer handling.
export default { async fetch(request, env) {
 const url = new URL(request.url), registry = env.PROJECT_REGISTRY.getByName('projects');
 if (url.pathname === '/_mapi/test/management-route') {
  if (env.MAPI_LOCAL_TEST !== '1' || request.headers.get('authorization') !== `Bearer ${env.MAPI_OPERATOR_TOKEN}` || !['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(null, { status: 404 });
  const args = await request.json();
  const route = await registry.reserve(args.origin, args.object);
  if (args.projectId) await registry.activate(args.origin, route.object_name, args.projectId);
  return new Response(null, { status: 204 });
 }
 if (url.pathname === '/_mapi/test/management-token') {
  if (env.MAPI_LOCAL_TEST !== '1' || request.headers.get('authorization') !== `Bearer ${env.MAPI_OPERATOR_TOKEN}` || !['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(null, { status: 404 });
  const route = await registry.resolve(url.origin);
  if (!route || route.state !== 'active') return new Response(null, { status: 404 });
  const project = env.NEXTGEN_APPLICATION.getByName(route.object_name);
  return Response.json({ token: await project.testManagementToken() }, { headers: { 'cache-control': 'no-store' } });
 }
 return handleManagementApp(request, env, app);
}};
