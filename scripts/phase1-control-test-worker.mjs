import { NextgenApplication as Owner, ProjectRegistry } from '../worker/generated/phase1-owner-app.js';
import caller from '../worker/phase1-caller.js';
export { ProjectRegistry };
import { initializeOwnerFence, freezeOwnerFence } from '../worker/owner-fence.js';
import control from '../worker/phase1-control.js';

export class NextgenApplication extends Owner {
  initTestFence(route) { initializeOwnerFence(this.ctx.storage, route); }
  freezeTestFence(route) { freezeOwnerFence(this.ctx.storage, route, 'test-move'); }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).hostname !== '127.0.0.1') return new Response(null, { status: 404 });
    try {
      const owner = env.NEXTGEN_APPLICATION.getByName('application');
      const origin = 'http://localhost:8787';
      const registry = env.PROJECT_REGISTRY.getByName('projects');
      await registry.reserve(origin, 'application');
      const project = await owner.provision('Control test', origin, { projectId: null, origin, objectName: 'application', generation: 1 });
      await registry.activate(origin, 'application', project.projectId);
      const route = { projectId: project.projectId, origin, objectName: 'application', generation: 1 };
      await owner.initTestFence(route);
      const user = await owner.addUser('phase1-control@example.invalid', 'Example-password-123!', route);
      const bindings = {
        ...env,
        PROJECT_REGISTRY: env.PROJECT_REGISTRY,
        NEXTGEN_APPLICATION: env.NEXTGEN_APPLICATION,
      };
      const callerEnv = { MAPI_PHASE1_LOCAL_CALLER: '1', PHASE1_CONTROL: { fetch: request => control.fetch(request, bindings) } };
      const call = (auth, action, userId) => caller.fetch(new Request('http://127.0.0.1/', { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ origin, action, userId }) }), callerEnv);
      if ((await caller.fetch(new Request('http://public.example/', { method: 'POST' }), callerEnv)).status !== 404) throw Error('Public caller accepted');
      if ((await call('wrong', 'project-token')).status !== 404) throw Error('Unauthenticated control accepted');
      const token = await call(env.MAPI_OPERATOR_TOKEN, 'project-token');
      if (!token.ok || typeof (await token.json()).result !== 'string') throw Error('Token control failed');
      const audit = await call(env.MAPI_OPERATOR_TOKEN, 'user-audit', user.userId);
      if (!audit.ok || (await audit.json()).result !== 1) throw Error('Audit control failed');
      const missing = await call(env.MAPI_OPERATOR_TOKEN, 'user-audit', 'user_missing');
      if (!missing.ok || (await missing.json()).result !== 0) throw Error('Missing audit was not distinguished');
      await owner.freezeTestFence(route);
      if ((await call(env.MAPI_OPERATOR_TOKEN, 'project-token')).status !== 503) throw Error('Frozen control accepted');
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
