import assert from 'node:assert/strict';
import { readBoundedBody, readBoundedText } from '../worker/request-body.js';
import { handleFlowProxy } from '../worker/flow-proxy.js';
import { handleOAuthIngress } from '../worker/oauth-ingress.js';
import { handleManagementIngress } from '../worker/management-proxy.js';

const empty = () => new Uint8Array();
function source(chunks, cancelResult, keepOpen = false) {
  let index = 0, canceled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index === chunks.length) { if (!keepOpen) controller.close(); }
      else controller.enqueue(chunks[index++]);
    },
    cancel() { canceled++; return cancelResult; },
  });
  return { stream, canceled: () => canceled };
}
const wrap = (stream) => ({ body: stream });
assert.deepEqual(await readBoundedBody({}, 4), new Uint8Array());
const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
assert.deepEqual(await readBoundedBody(wrap(source([empty(), view, new Uint8Array([4])]).stream), 4), new Uint8Array([1, 2, 3, 4]));
assert.equal((await readBoundedBody(wrap(source(Array.from({ length: 1024 }, empty)).stream), 4)).length, 0);
for (const chunks of [[new Uint8Array(5)], Array.from({ length: 1025 }, empty)]) {
  const input = source(chunks, new Promise(() => {}));
  assert.equal(await readBoundedBody(wrap(input.stream), 4), null);
  assert.equal(input.canceled(), 1);
}
const failedCancel = source([new Uint8Array(5)], Promise.reject(new Error('cancel failed')));
assert.equal(await readBoundedBody(wrap(failedCancel.stream), 4), null);
await assert.rejects(readBoundedBody(wrap(source(['not bytes']).stream), 4), /must be bytes/);
await assert.rejects(readBoundedBody(wrap(new ReadableStream({ start(c) { c.error(new Error('stream failed')); } })), 4), /stream failed/);

// Legacy form/admin routes decode with a nonfatal TextDecoder and must return
// without waiting for cancellation when a request exceeds its budget.
assert.equal(await readBoundedText({}, 4), '');
const utf8 = source([new Uint8Array([0x61, 0xe2]), new Uint8Array([0x82, 0xac])]);
assert.equal(await readBoundedText(wrap(utf8.stream), 4), 'a€');
assert.equal(await readBoundedText(wrap(source([new Uint8Array([0xc3])]).stream), 4), '\ufffd');
assert.equal(await readBoundedText(wrap(source(Array.from({ length: 1024 }, empty)).stream), 4), '');
for (const chunks of [[new Uint8Array(5)], Array.from({ length: 1025 }, empty)]) {
  const input = source(chunks, new Promise(() => {}));
  await assert.rejects(Promise.race([
    readBoundedText(wrap(input.stream), 4),
    new Promise((_, reject) => setTimeout(() => reject(Error('bounded read stalled')), 250)),
  ]), /body too large/);
  assert.equal(input.canceled(), 1);
}

const origin = 'https://project.example', project = 'proj_test';
let calls = 0, received;
const goResponse = { status: 200, headers: {}, body: '' };
const object = {
  async identity() { return project; },
  async flowRequest(input) { calls++; received = input; return goResponse; },
  async oauthRequest(input) { calls++; received = input; return goResponse; },
  async handleRequest(input) { calls++; received = input; return goResponse; },
};
const route = { origin, project_id: project, object_name: 'owner', state: 'active', generation: 1 };
const registry = { async resolve() { return route; } };
const namespace = { getByName() { return object; } };
const cases = [
  [(request) => handleFlowProxy(request, object, project, origin), `/__nextgen/sessions/exchange?project_id=${project}`],
  [(request) => handleOAuthIngress(request, object, project, origin), `/oauth/${project}/token`],
  [(request) => handleManagementIngress(request, registry, namespace), '/api/v1/users/query'],
];
const request = (path, body) => new Request(origin + path, { method: 'POST', headers: { origin }, body, duplex: 'half' });
for (const [handler, path] of cases) {
  const exact = new Uint8Array(65_536); exact[0] = 7; exact[65_535] = 8;
  const split = source([empty(), exact.subarray(0, 15), exact.subarray(15)]);
  assert.equal((await handler(request(path, split.stream))).status, 200);
  assert.deepEqual(Uint8Array.fromBase64(received.body), exact);
  for (const chunks of [[new Uint8Array(65_537)], Array.from({ length: 1025 }, empty)]) {
    const bad = source(chunks, new Promise(() => {}), true);
    const before = calls;
    assert.equal((await handler(request(path, bad.stream))).status, 413);
    assert.equal(bad.canceled(), 1);
    assert.equal(calls, before);
  }
}
console.log('Bounded request-body and ingress tests passed.');
