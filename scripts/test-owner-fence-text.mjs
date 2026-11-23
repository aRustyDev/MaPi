// Only tests malformed JavaScript input at the fence API boundary. The storage
// spy prevents malformed input from reaching SQLite or any Durable Object.
import assert from 'node:assert/strict';
import { assertOwnerFence, freezeOwnerFence, initializeOwnerFence, reserveMoveDestination, withOwnerFence } from '../worker/owner-fence.js';

const valid = { projectId: 'project-😀', origin: 'https://example.test/😀', objectName: 'owner-😀', generation: 2 };
const malformed = ['\ud800', '\udfff', 'ok\ud800x', '\ud800\ud800', '\udc00\udc00'];
let calls;
const storage = {
  transactionSync(fn) { calls++; return fn(); },
  sql: { exec() { calls++; throw Error('Storage reached'); } },
};
const rejected = action => {
  calls = 0;
  assert.throws(action, /Invalid owner route|Invalid move ID/);
  assert.equal(calls, 0, 'malformed route must be rejected before storage');
};
for (const field of ['projectId', 'origin', 'objectName']) {
  for (const value of malformed) {
    const route = {...valid, [field]: value};
    rejected(() => initializeOwnerFence(storage, route));
    rejected(() => assertOwnerFence(storage, route));
    rejected(() => withOwnerFence(storage, route, () => { throw Error('Mutation reached'); }));
    rejected(() => freezeOwnerFence(storage, route, 'move-😀'));
    rejected(() => reserveMoveDestination(storage, route, 'move-😀'));
  }
}
for (const moveId of malformed) {
  rejected(() => freezeOwnerFence(storage, valid, moveId));
  rejected(() => reserveMoveDestination(storage, valid, moveId));
}
// A valid surrogate pair must pass validation, without needing to touch SQL.
for (const action of [
  () => initializeOwnerFence(storage, valid),
  () => assertOwnerFence(storage, valid),
  () => withOwnerFence(storage, valid, () => {}),
  () => freezeOwnerFence(storage, valid, 'move-😀'),
  () => reserveMoveDestination(storage, valid, 'move-😀'),
]) {
  calls = 0;
  assert.throws(action, /Storage reached/);
  assert(calls > 0, 'well-formed Unicode must pass the text validation');
}
console.log('Owner-fence JavaScript text boundary passed');
