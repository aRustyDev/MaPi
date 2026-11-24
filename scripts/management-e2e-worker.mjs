import app, { NextgenApplication, ProjectRegistry as RealProjectRegistry } from '../worker/generated/management-test-app.js';
import { handleManagementApp } from '../worker/management-ingress.js';
export { NextgenApplication };
// Only the local fixture can construct an inconsistent registry to exercise
// the ingress identity check; production activation still requires attestation.
export class ProjectRegistry extends RealProjectRegistry {
 async injectMismatchedTestRoute(origin, objectName, projectId) {
  if (this.env.MAPI_LOCAL_TEST !== '1' || objectName !== 'mismatched-test' || projectId !== 'proj_mismatch') throw Error('Invalid fixture');
  let rejected = false;
  try { await this.activate(origin, objectName, projectId); } catch { rejected = true; }
  if (!rejected) throw Error('Unattested registry activation unexpectedly succeeded');
  this.ctx.storage.transactionSync(() => {
   const rows = this.ctx.storage.sql.exec("SELECT origin FROM project_routes WHERE origin = ? AND object_name = ? AND project_id IS NULL AND state = 'pending'", origin, objectName).toArray();
   if (rows.length !== 1) throw Error('Missing pending fixture');
   this.ctx.storage.sql.exec("UPDATE project_routes SET project_id = ?, state = 'active' WHERE origin = ?", projectId, origin);
  });
 }
}
// Test-only entry point. Project credentials are never exported by app.js;
// this synthetic local-only harness obtains them to verify real Bearer handling.
export default { async fetch(request, env) {
 const url = new URL(request.url), registry = env.PROJECT_REGISTRY.getByName('projects');
 if (url.pathname === '/_mapi/test/management-route') {
  if (env.MAPI_LOCAL_TEST !== '1' || typeof env.MAPI_OPERATOR_TOKEN !== 'string' || !env.MAPI_OPERATOR_TOKEN || request.headers.get('authorization') !== `Bearer ${env.MAPI_OPERATOR_TOKEN}` || !['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(null, { status: 404 });
  const args = await request.json();
  const route = await registry.reserve(args.origin, args.object);
  if (args.projectId) await registry.injectMismatchedTestRoute(args.origin, route.object_name, args.projectId);
  return new Response(null, { status: 204 });
 }
 if (url.pathname === '/_mapi/test/management-token-fence') {
  if (env.MAPI_LOCAL_TEST !== '1' || typeof env.MAPI_OPERATOR_TOKEN !== 'string' || !env.MAPI_OPERATOR_TOKEN || request.headers.get('authorization') !== `Bearer ${env.MAPI_OPERATOR_TOKEN}` || !['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(null, { status: 404 });
  const route = await registry.resolve(url.origin);
  if (!route || route.state !== 'active') return new Response(null, { status: 404 });
  const owner = env.NEXTGEN_APPLICATION.getByName(route.object_name);
  const authority = { projectId: route.project_id, origin: route.origin, objectName: route.object_name, generation: route.generation };
  // Stale generation and wrong owner retain a valid identity and origin, so
  // rejecting them proves the provisioned owner's fence is armed. This does
  // not establish tuple enforcement for a legacy owner without a fence.
  for (const tuple of [undefined, { ...authority, generation: authority.generation + 1 }, { ...authority, objectName: 'wrong-test-owner' }]) {
   let rejected = false;
   try { await owner.testManagementToken(tuple); } catch { rejected = true; }
   if (!rejected) throw Error('Invalid test authority minted a token');
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
 }
 if (url.pathname === '/_mapi/test/management-token') {
  if (env.MAPI_LOCAL_TEST !== '1' || typeof env.MAPI_OPERATOR_TOKEN !== 'string' || !env.MAPI_OPERATOR_TOKEN || request.headers.get('authorization') !== `Bearer ${env.MAPI_OPERATOR_TOKEN}` || !['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(null, { status: 404 });
  const route = await registry.resolve(url.origin);
  if (!route || route.state !== 'active') return new Response(null, { status: 404 });
  const project = env.NEXTGEN_APPLICATION.getByName(route.object_name);
  return Response.json({ token: await project.testManagementToken({ projectId: route.project_id, origin: route.origin, objectName: route.object_name, generation: route.generation }) }, { headers: { 'cache-control': 'no-store' } });
 }
 return handleManagementApp(request, env, app);
}};
