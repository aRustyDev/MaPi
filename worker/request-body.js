// Bound retained memory and work even when the transport splits a small body
// into many chunks. Zero-length chunks do not consume the byte allowance, so
// cap them separately. This rejects streams with more than 1,024 empty chunks.
export async function readBoundedBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const bytes = new Uint8Array(limit);
  let length = 0, emptyChunks = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return bytes.subarray(0, length);
    if (!(value instanceof Uint8Array)) throw new TypeError('Request body chunk must be bytes');
    if ((value.length === 0 && ++emptyChunks > 1024) || value.length > limit - length) {
      // Cancellation starts cleanup, but a stalled or rejected cancellation
      // must not prevent a bounded-input error response from being returned.
      void reader.cancel().catch(() => {});
      return null;
    }
    bytes.set(value, length);
    length += value.length;
  }
}

// Keep the legacy form/admin routes on the same bounded streaming path as
// the API proxies. Preserve their existing nonfatal UTF-8 decoding and let
// each caller translate an oversized body to its existing HTTP response.
export async function readBoundedText(request, limit) {
  const bytes = await readBoundedBody(request, limit);
  if (bytes === null) throw new Error('body too large');
  return new TextDecoder().decode(bytes);
}
