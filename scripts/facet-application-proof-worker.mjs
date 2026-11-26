// Local-only synthetic proof. This supervisor is not a production authority,
// cannot migrate legacy storage and intentionally has no cross-owner bridge.
import { DurableObject } from 'cloudflare:workers';
import { ProjectRegistry } from '../worker/registry.js';
import dynamic from './dynamic.txt';
import wasmBytes from './engine.bin';

export { ProjectRegistry };
export class FacetApplicationSupervisor extends DurableObject {
  facet(name) {
    const own = this.ctx.id.toString();
    if (typeof name !== 'string' || this.env.NEXTGEN_APPLICATION.idFromName(name).toString() !== own) throw Error('Supervisor identity mismatch');
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS proof_name (name TEXT NOT NULL)');
    const row = sql.exec('SELECT name FROM proof_name LIMIT 1').toArray()[0];
    if (row && row.name !== name) throw Error('Persisted owner name mismatch');
    if (!row) sql.exec('INSERT INTO proof_name VALUES (?)', name);
    return this.ctx.facets.get('app', () => ({ class: this.env.LOADER.get(`application-proof-v1:${own}`, () => ({
      compatibilityDate: '2026-11-18', mainModule: 'entry.js',
      modules: { 'entry.js': dynamic, './generated/nextgen.wasm': { wasm: wasmBytes } },
      env: { MAPI_LOCAL_TEST: '1', MAPI_RELOCATION_ENABLED: '1', MAPI_RELOCATION_CONTROL_TOKEN: 'synthetic-token', MAPI_FENCE_WRITERS_DRAINED: '1', MAPI_MASTER_KEY: this.env.MAPI_MASTER_KEY, REGISTRY: this.env.PROJECT_REGISTRY.getByName('projects'), OWNER_NAME: name, OWNER_ID: own },
      globalOutbound: null,
    })).getDurableObjectClass('Facet') }));
  }
  provision(name, origin, route) { return this.facet(route.objectName).provision(name, origin, route); }
  provisioningAttestation(origin, name, generation) { return this.facet(name).provisioningAttestation(origin, name, generation); }
  activateProvisioning(route) { return this.facet(route.objectName).activateProvisioning(route); }
  addUser(email, password, route) { return this.facet(route.objectName).addUser(email, password, route); }
  status(verify, route) { return this.facet(route.objectName).status(verify, route); }
  identity(name) { return this.facet(name).identity(); }
  counts(name) { return this.facet(name).testCounts(); }
  crossOwnerProbe(name) { return this.facet(name).crossOwnerProbe(); }
  login(email, password, ip, route) { return this.facet(route.objectName).login(email, password, ip, route); }
  freezeRelocation(secret, route, move) { return this.facet(route.objectName).freezeRelocation(secret, route, move); }
  evictFacet(name) { this.facet(name); this.ctx.facets.abort('app', 'synthetic facet restart'); return true; }
  evictSupervisor() { this.ctx.abort('synthetic supervisor restart'); }
}
const reject = async (promise, message) => { try { await promise; } catch (error) { if (String(error).includes(message)) return; throw error; } throw Error('Expected synthetic rejection'); };
export default { async fetch(request, env) {
  const host = new URL(request.url).hostname;
  if (env.MAPI_LOCAL_TEST !== '1' || !['127.0.0.1', 'localhost', '[::1]'].includes(host) || !env.MAPI_GATE_KEY || request.headers.get('x-synthetic-key') !== env.MAPI_GATE_KEY) return new Response(null, { status: 404 });
  try {
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    const name = `source-${crypto.randomUUID()}`, origin = `https://${crypto.randomUUID()}.example`;
    let owner = env.NEXTGEN_APPLICATION.getByName(name);
    await registry.reserve(origin, name);
    const { projectId } = await owner.provision('Synthetic', origin, { projectId: null, origin, objectName: name, generation: 1 });
    await registry.activate(origin, name, projectId);
    const route = { projectId, origin, objectName: name, generation: 1 };
    const user = await owner.addUser('synthetic@example.test', 'Synthetic-password-123!', route);
    const login = await owner.login('synthetic@example.test', 'Synthetic-password-123!', '192.0.2.1', route);
    if (!user.userId || login.status !== 200) throw Error('Synthetic Go/Wasm user or login failed');
    const before = await owner.counts(name);
    await reject(owner.addUser('bad@example.test', 'Synthetic-password-123!', { ...route, objectName: 'wrong' }), 'Supervisor identity mismatch');
    const stale = await owner.status(true, { ...route, generation: 2 });
    if (stale.ready || stale.fenceReady) throw Error('Stale generation accepted');
    if (JSON.stringify(await owner.counts(name)) !== JSON.stringify(before)) throw Error('Rejected route changed synthetic data');
    await reject(owner.freezeRelocation('wrong', route, 'synthetic-move'), 'Relocation control denied');
    await reject(owner.crossOwnerProbe(name), 'Cross-owner capability is not implemented in this proof');
    await owner.evictFacet(name);
    if (!(await owner.status(true, route)).ready) throw Error('Facet restart lost application');
    try { await owner.evictSupervisor(); } catch { /* eviction aborts RPC */ }
    owner = env.NEXTGEN_APPLICATION.getByName(name);
    if (!(await owner.status(true, route)).ready || await owner.identity(name) !== projectId) throw Error('Supervisor restart lost application');
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
} };
