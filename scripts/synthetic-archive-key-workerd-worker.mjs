import { mintSyntheticArchiveKey, openSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';

const scope = { keyArn: 'arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f',
  runId: 'mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a', archiveId: '1'.repeat(32), manifestDigest: '2'.repeat(64) };
const signal = () => AbortSignal.timeout(10000);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rejected(action) { try { await action(); } catch { return; } throw new Error('Expected rejection'); }
function barrier() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/ready') return new Response(null, { status: 204 });
    try {
      const bucket = env.ARCHIVE_TEST;
      let calls = 0;
      const kms = {
        async generateDataKey(input) {
          assert(input.KeyId === scope.keyArn && input.KeySpec === 'AES_256' && input.EncryptionContext.purpose === 'mapi-phase1-synthetic-archive' && input.EncryptionContext.run_id === scope.runId, 'KMS request');
          calls++; return { KeyId: scope.keyArn, Plaintext: new Uint8Array(32).fill(7), CiphertextBlob: new Uint8Array([3, 4, 5]) };
        },
        async decrypt(input) {
          assert(input.KeyId === scope.keyArn && input.EncryptionContext.run_id === scope.runId && input.CiphertextBlob.toBase64() === 'AwQF', 'KMS decrypt');
          return { KeyId: scope.keyArn, Plaintext: new Uint8Array(32).fill(7) };
        },
      };
      const first = await mintSyntheticArchiveKey(bucket, kms, scope, signal());
      assert(Object.keys(first).length === 1 && /^[0-9a-f]{64}$/.test(first.provisionalEnvelopeDigest), 'provisional digest');
      const key = await openSyntheticArchiveKey(bucket, kms, scope, first.provisionalEnvelopeDigest, signal());
      assert(key.extractable === false && key.algorithm.name === 'AES-GCM', 'unextractable key');
      const iv = new Uint8Array(12), message = new Uint8Array([1, 2, 3]);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, message);
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
      assert(plaintext.length === message.length && plaintext.every((v, i) => v === message[i]), 'key roundtrip');
      await rejected(() => openSyntheticArchiveKey(bucket, kms, scope, '0'.repeat(64), signal()));
      await rejected(() => mintSyntheticArchiveKey(bucket, kms, scope, signal()));
      assert(calls === 1, 'repeated generation');

      const concurrent = { ...scope, archiveId: '3'.repeat(32) }, entered = barrier(), release = barrier();
      const held = { ...kms, async generateDataKey(input) { entered.release(); await release.promise; return kms.generateDataKey(input); } };
      const pending = mintSyntheticArchiveKey(bucket, held, concurrent, signal());
      await entered.promise;
      await rejected(() => mintSyntheticArchiveKey(bucket, held, concurrent, signal()));
      release.release(); await pending; assert(calls === 2, 'concurrent generation');

      const ambiguous = { ...scope, archiveId: '4'.repeat(32) };
      let lost = true;
      const lostAck = { get: (...args) => bucket.get(...args), async put(...args) {
        const response = await bucket.put(...args);
        if (lost && args[0].endsWith('/reservation')) { lost = false; throw new Error('simulated lost acknowledgment'); }
        return response;
      } };
      await rejected(() => mintSyntheticArchiveKey(lostAck, kms, ambiguous, signal()));
      await rejected(() => mintSyntheticArchiveKey(bucket, kms, ambiguous, signal()));
      assert(calls === 2, 'ambiguous claim generated a key');
      return Response.json({ ok: true });
    } catch {
      return new Response('Synthetic key provider workerd test failed', { status: 500 });
    }
  },
};
