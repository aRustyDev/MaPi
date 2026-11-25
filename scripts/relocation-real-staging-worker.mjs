// This control runs only against freshly created synthetic namespaces.
import chunks, { ChunkProject, ChunkRegistry } from './relocation-chunks-test-worker.mjs';

export { ChunkProject, ChunkRegistry };

export default {
  async fetch(request, env) {
    const encoder = new TextEncoder();
    const supplied = encoder.encode(request.headers.get('authorization') ?? '');
    const expected = encoder.encode(`Bearer ${env.MAPI_STAGING_PROOF_TOKEN ?? ''}`);
    if (!env.MAPI_STAGING_PROOF_TOKEN || supplied.length !== expected.length ||
        !crypto.subtle.timingSafeEqual(supplied, expected) ||
        request.method !== 'POST' || new URL(request.url).pathname !== '/verify') {
      return new Response(null, { status: 404 });
    }
    return chunks.fetch(request, env);
  },
};
