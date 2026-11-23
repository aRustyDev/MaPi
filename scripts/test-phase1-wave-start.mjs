import assert from 'node:assert/strict';
import { beginObservedWave } from './phase1-wave-start.mjs';

const callbacks = [], release = [];
const factories = Array.from({ length: 4 }, (_, index) => onStart => {
  callbacks[index] = onStart;
  return new Promise(resolve => { release[index] = resolve; });
});
let acknowledged = false;
const pending = beginObservedWave(factories, () => 123).then(result => { acknowledged = true; return result; });
await new Promise(resolve => setImmediate(resolve));
callbacks[0](); callbacks[0](); callbacks[1](); callbacks[2]();
await new Promise(resolve => setImmediate(resolve));
assert.equal(acknowledged, false, 'three distinct requests cannot acknowledge four');
callbacks[3]();
const wave = await pending;
assert.deepEqual({ attempts: wave.attempts, started: wave.started, childAcknowledgedAtMs: wave.childAcknowledgedAtMs }, { attempts: 4, started: 4, childAcknowledgedAtMs: 123 });
for (const done of release) done('ok');
assert.ok((await wave.settled).every(item => item.status === 'fulfilled'));
const incomplete = await beginObservedWave([on => { on(); return 1; }, on => { on(); return 2; }, () => Promise.reject(new Error('failed before first request')), on => { on(); return 4; }], () => 456);
assert.equal(incomplete.attempts, 4);
assert.equal(incomplete.started, 3);
assert.equal((await incomplete.settled).filter(item => item.status === 'rejected').length, 1);
await assert.rejects(beginObservedWave([() => 1]), /Invalid/);
console.log('Wave acknowledgment waits for four distinct real-request callbacks and reports incomplete starts.');
