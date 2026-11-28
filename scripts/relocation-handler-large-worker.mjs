import { NextgenApplication, ProjectRegistry } from '../worker/phase1-owner.js';
import { initializeOwnerFence } from '../worker/owner-fence.js';

export { ProjectRegistry };
export class HandlerOwner extends NextgenApplication {
  seedNearLimit(projectId, userId) {
    this.ctx.storage.sql.exec(`INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'near_limit', '"z' || replace(hex(zeroblob(2096998)), '00', '😀') || 'xyzab"')`, projectId, userId);
  }
  arm(route) { initializeOwnerFence(this.ctx.storage, route); }
}

export default {
  async fetch(request, env) {
    const origin = 'https://near-limit-handler.example', objectName = 'synthetic-handler';
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    const owner = env.NEXTGEN_APPLICATION.getByName(objectName);
    await registry.reserve(origin, objectName);
    const { projectId } = await owner.provision('Synthetic handler proof', origin, { projectId: null, origin, objectName, generation: 1 });
    await registry.activate(origin, objectName, projectId);
    const route = { projectId, origin, objectName, generation: 1 };
    const { userId } = await owner.addUser('near-handler@example.test', 'Synthetic-password-123!', route);
    await owner.seedNearLimit(projectId, userId);
    await owner.arm(route);
    const token = await owner.phase1Control(route, env.MAPI_PHASE1_CONTROL_TOKEN, 'project-token');
    const response = await owner.handleRequest({ method: 'GET', url: `${origin}/users/${userId}`, headers: { authorization: [`Bearer ${token}`] }, body: '', peer: '127.0.0.1' }, route);
    if (response.status !== 200) return Response.json({ status: response.status });
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(response.body)));
    const attribute = parsed.attributes?.near_limit;
    if (typeof attribute !== 'string') throw Error('Near-limit attribute missing from Go response');
    const bytes = new TextEncoder().encode(attribute);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return Response.json({ status: response.status, bytes: bytes.length, digest });
  },
};
