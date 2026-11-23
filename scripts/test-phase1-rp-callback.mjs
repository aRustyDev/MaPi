import assert from 'node:assert/strict';
import { assertRpCallback } from './phase1-rp-callback.mjs';
const results = await Promise.allSettled([
  Promise.resolve().then(() => assertRpCallback({ status: () => 500 })),
  Promise.resolve().then(() => assertRpCallback({ status: () => 200 })),
  Promise.resolve().then(() => assertRpCallback({ status: () => 200 })),
  Promise.resolve().then(() => assertRpCallback({ status: () => 200 })),
]);
assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
assertRpCallback({ status: () => 200 });
console.log('An RP callback failure remains scoped to its own journey.');
