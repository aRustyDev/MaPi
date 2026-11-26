// Test-only supervisor: the runner copies this file and generated assets into
// an isolated temporary directory. It must never be deployed as an app route.
import { DurableObject } from 'cloudflare:workers';
import code from './dynamic.txt';
import wasmBytes from './engine.bin';

export class FacetProofSupervisor extends DurableObject {
  facet() {
    // IDs include the parent so unrelated synthetic owners cannot share this
    // cached Worker. The version must change if the generated code changes.
    const loaderId = `mapi-facet-proof-v1:${this.ctx.id.toString()}`;
    return this.ctx.facets.get('app', () => {
      const worker = this.env.LOADER.get(loaderId, async () => ({
        compatibilityDate: '2026-11-18',
        mainModule: 'entry.js',
        modules: { 'entry.js': code, './generated/nextgen.wasm': { wasm: wasmBytes } },
        env: { MAPI_LOCAL_TEST: '1', MAPI_MASTER_KEY: this.env.MAPI_MASTER_KEY },
        globalOutbound: null,
      }));
      return { class: worker.getDurableObjectClass('Facet') };
    });
  }

  async run(action) {
    if (action === 'abort-facet') { this.ctx.facets.abort('app', 'synthetic facet eviction'); return true; }
    if (action === 'abort-supervisor') { this.ctx.abort('synthetic supervisor eviction'); return true; }
    if (action === 'probe') return this.facet().probe();
    if (action === 'inspect') return this.facet().inspect();
    throw Error('Unknown synthetic proof action');
  }
}

export default {
  async fetch(request, env) {
    const host = new URL(request.url).hostname;
    if (env.MAPI_LOCAL_TEST !== '1' || !['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
        !env.MAPI_GATE_KEY || request.headers.get('x-synthetic-key') !== env.MAPI_GATE_KEY) return new Response(null, { status: 404 });
    try {
      const { action, owner } = await request.json();
      if (typeof owner !== 'string' || !/^synthetic-[a-z]+$/.test(owner)) throw Error('Invalid synthetic owner');
      return Response.json(await env.SUPERVISOR.getByName(owner).run(action));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
