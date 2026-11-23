// Local-only harness for the private cross-Worker binding test.
import app, { NextgenApplication as Owner, ProjectRegistry } from '../worker/generated/phase1-owner-app.js';
import { initializeOwnerFence, freezeOwnerFence } from '../worker/owner-fence.js';
import { handleManagementApp } from '../worker/management-ingress.js';
export { ProjectRegistry };
export class NextgenApplication extends Owner {
  initFence(route) { initializeOwnerFence(this.ctx.storage, route); }
  freezeFence(route) { freezeOwnerFence(this.ctx.storage, route, 'binding-test'); }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/_mapi/local/fence' || url.pathname === '/_mapi/local/freeze') {
      if (env.MAPI_LOCAL_TEST !== '1' || !['localhost', '127.0.0.1'].includes(url.hostname) || request.headers.get('authorization') !== `Bearer ${env.MAPI_OPERATOR_TOKEN}`) return new Response(null, { status: 404 });
      const route = await env.PROJECT_REGISTRY.getByName('projects').resolve(url.origin);
      if (!route || route.state !== 'active') return new Response(null, { status: 404 });
      const authority = { projectId: route.project_id, origin: route.origin, objectName: route.object_name, generation: route.generation };
      const object = env.NEXTGEN_APPLICATION.getByName(route.object_name);
      if (url.pathname.endsWith('/freeze')) await object.freezeFence(authority);
      else await object.initFence(authority);
      return new Response(null, { status: 204 });
    }
    return handleManagementApp(request, env, app);
  },
};
