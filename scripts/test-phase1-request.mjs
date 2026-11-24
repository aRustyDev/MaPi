import assert from 'node:assert/strict';
import { requestJson } from './phase1-request.mjs';
const secret = 'private-body-secret';
assert.deepEqual(await requestJson('http://example.test', {}, { operation: 'setup', fetcher: async () => Response.json({ ok: true }) }), { ok: true });
for (const [response, kind, status] of [[new Response(secret, { status: 429 }), 'http', 429], [new Response(secret, { status: 500 }), 'http', 500], [new Response(secret, { status: 200 }), 'response', 200]]) {
  await assert.rejects(requestJson('http://example.test', {}, { operation: 'setup', fetcher: async () => response }), error => {
    assert.deepEqual(error.phase1Failure, { operation: 'setup', kind, status });
    assert.ok(!JSON.stringify(error.phase1Failure).includes(secret));
    return true;
  });
}
const keepAlive = setTimeout(() => {}, 1000);
try {
  await assert.rejects(requestJson('http://example.test', {}, { operation: 'setup', timeoutMs: 5, fetcher: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })) }), error => {
    assert.deepEqual(error.phase1Failure, { operation: 'setup', kind: 'timeout', status: null }); return true;
  });
} finally { clearTimeout(keepAlive); }
console.log('Benchmark request failures retain only operation, status and timeout classification.');
