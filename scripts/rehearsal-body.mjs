// Drain synthetic response bodies fully, but abort rather than retain an
// unbounded response. The caller never logs body contents.
async function read(response, controller, limit, collect) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) { controller.abort(); throw Error('Synthetic response exceeds byte limit'); }
  if (!response.body) return collect ? new Uint8Array() : 0;
  const reader = response.body.getReader();
  let bytes = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (!collect) return bytes;
        const result = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
        return result;
      }
      bytes += value.byteLength;
      if (bytes > limit) { controller.abort(); throw Error('Synthetic response exceeds byte limit'); }
      if (collect) chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}
export const drainBounded = (response, controller, limit = 1024 * 1024) => read(response, controller, limit, false);
export async function jsonBounded(response, controller, limit = 1024 * 1024) { return JSON.parse(new TextDecoder().decode(await read(response, controller, limit, true))); }
