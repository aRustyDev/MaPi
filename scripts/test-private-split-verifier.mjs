import assert from 'node:assert/strict';
import { verifyPrivatePassword } from './private-split-verifier.mjs';

const secret = 'synthetic-secret-only-for-tests-123456';
const input = { password: 'synthetic-password', hash: 'synthetic-hash' };
const response = (body, options = {}) => new Response(body, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
const binding = result => ({ fetch: async () => result });
const reject = value => assert.rejects(verifyPrivatePassword(binding(value), secret, input), /^Error: Private verifier unavailable$/);

let request;
const ok = { fetch: async (url, options) => { request = { url, options }; return response('{"rehash":"","verified":true,"wasmBytes":65536}'); } };
assert.deepEqual(await verifyPrivatePassword(ok, secret, input), { verified: true, rehash: '' });
assert.equal(request.url, 'https://argon.internal/verify');
assert.equal(request.options.headers.authorization, `Bearer ${secret}`);
assert.deepEqual(JSON.parse(request.options.body), input);
assert.deepEqual(await verifyPrivatePassword(binding(response('{"verified":false,"rehash":""}')), secret, input), { verified: false, rehash: '' });
// The service enforces 1,024 password bytes, 512 hash bytes and 4,096
// encoded request bytes. Rejected input must never reach the private binding.
let calls = 0;
const bounded = { fetch: async () => { calls++; return response('{"verified":true,"rehash":""}'); } };
for (const password of ['a'.repeat(1024), 'é'.repeat(512), '😀'.repeat(256)]) {
  await verifyPrivatePassword(bounded, secret, { password, hash: 'h' });
}
await verifyPrivatePassword(bounded, secret, { password: 'p', hash: 'h'.repeat(512) });
const exactBodyPassword = '\0'.repeat(678) + 'aa';
assert.equal(new TextEncoder().encode(JSON.stringify({ password: exactBodyPassword, hash: 'h' })).length, 4096);
assert.equal(new TextEncoder().encode(JSON.stringify({ password: exactBodyPassword + 'a', hash: 'h' })).length, 4097);
await verifyPrivatePassword(bounded, secret, { password: exactBodyPassword, hash: 'h' });
const passedCalls = calls;
for (const input of [
  { password: 'a'.repeat(1025), hash: 'h' },
  { password: 'é'.repeat(513), hash: 'h' },
  { password: '😀'.repeat(257), hash: 'h' },
  { password: 'p', hash: 'h'.repeat(513) },
  { password: 'p', hash: 'é'.repeat(257) },
  { password: exactBodyPassword + 'a', hash: 'h' },
  // Escaped JSON can exceed the transport bound even when plaintext does not.
  { password: '\0'.repeat(700), hash: 'h' },
]) await assert.rejects(verifyPrivatePassword(bounded, secret, input), /^Error: Private verifier unavailable$/);
assert.equal(calls, passedCalls, 'oversized input reached the verifier');
const pinnedHash = '$argon2id$v=19$m=65536,t=3,p=4$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU';
await verifyPrivatePassword(bounded, secret, { password: 'synthetic', hash: pinnedHash });

await reject(null);
await reject({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader() { throw Error('sensitive synthetic detail'); } } });
await reject(response('{"verified":true,"rehash":""}', { status: 500 }));
await reject(response('{"verified":true,"rehash":""}', { headers: { 'content-type': 'text/plain' } }));
await reject(response('{"verified":true,"rehash":""}', { headers: { 'content-length': '1025' } }));
await reject(response('{"verified":true,"rehash":""}', { headers: { 'content-length': '1' } }));
await reject(response('{"verified":true,"rehash":"", "extra":1}'));
await reject(response('{"verified":"true","rehash":""}'));
await reject(response('{"verified":true}'));
await reject(response('{"verified":true,"verified":false,"rehash":""}'));
await reject(response(String.raw`{"verified":false,"ver\u0069fied":true,"rehash":""}`));
await reject(response('{"verified":true,"rehash":"","rehash":""}'));
await reject(response('{"verified":true,"rehash":"","wasmBytes":1,"wasmBytes":2}'));
await reject(response('{"verified":true,"rehash":{},"wasmBytes":1}'));
// A hostile or defective binding may throw before cancel returns a promise.
// This must not leak that error or replace an otherwise valid result.
function cancelThrows(body) {
  let emitted = false;
  return {
    ok: true, headers: new Headers({ 'content-type': 'application/json' }),
    body: { getReader() { return {
      async read() { if (emitted) return { done: true }; emitted = true; return { done: false, value: new TextEncoder().encode(body) }; },
      cancel() { throw Error('sensitive synthetic cancellation detail'); },
    }; } },
  };
}
await reject(cancelThrows('{bad-json'));
assert.deepEqual(await verifyPrivatePassword(binding(cancelThrows('{"verified":true,"rehash":""}')), secret, input), { verified: true, rehash: '' });
let cancelAttempted = false, readerReady;
const ready = new Promise(resolve => { readerReady = resolve; });
const stuck = {
  ok: true, headers: new Headers({ 'content-type': 'application/json' }),
  body: { getReader() { return {
    read() { readerReady(); return new Promise(() => {}); },
    cancel() { cancelAttempted = true; throw Error('sensitive synthetic cancellation detail'); },
  }; } },
};
const abortStuck = new AbortController();
const pendingStuck = verifyPrivatePassword(binding(stuck), secret, { ...input, signal: abortStuck.signal });
await ready;
abortStuck.abort();
await assert.rejects(Promise.race([pendingStuck, new Promise((_, reject) => setTimeout(() => reject(Error('abort did not settle')), 1000))]), /^Error: Private verifier unavailable$/);
assert.equal(cancelAttempted, true);
assert.deepEqual(await verifyPrivatePassword(binding(response(String.raw` { "ver\u0069fied" : true, "rehash" : "", "wasmBytes" : 1e3 } `)), secret, input), { verified: true, rehash: '' });
// Accept valid field order, whitespace and escaped scalar content without
// weakening duplicate-name checks.
for (const verified of [false, true]) for (const rehash of ['', 'quote" slash\\ newline\n 😀']) {
  const fields = { verified, rehash, wasmBytes: Number.MAX_SAFE_INTEGER };
  for (const order of [['verified','rehash','wasmBytes'], ['wasmBytes','verified','rehash'], ['rehash','wasmBytes','verified']]) {
    const serialized = JSON.stringify(Object.fromEntries(order.map(key => [key, fields[key]])), null, 2);
    assert.deepEqual(await verifyPrivatePassword(binding(response(serialized)), secret, input), { verified, rehash });
  }
}
await reject(response('{bad-json'));
await reject(response(new Uint8Array([0xff])));

let canceled = false;
const oversized = new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(700)); controller.enqueue(new Uint8Array(700)); },
  cancel() { canceled = true; },
});
await reject(response(oversized));
assert.equal(canceled, true, 'oversized verifier response must be canceled');

let cancelPending = false;
const pending = new ReadableStream({ cancel() { cancelPending = true; } });
const controller = new AbortController();
const waiting = verifyPrivatePassword(binding(response(pending)), secret, { ...input, signal: controller.signal });
await Promise.resolve();
controller.abort();
await assert.rejects(waiting, /^Error: Private verifier unavailable$/);
assert.equal(cancelPending, true, 'aborting must cancel a pending verifier body');
console.log('Private split verifier rejects malformed, oversized and aborted responses without accepting a proof.');
