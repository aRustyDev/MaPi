import assert from 'node:assert/strict';
import { logOverload, logReactorLifecycle, logRuntimeError, observeWasmHighWater } from '../worker/runtime-diagnostics.js';
const messages = [];
const original = console.error;
try {
  console.error = value => messages.push(value);
  logOverload({ overloaded: true, message: 'private request body' }, 'management');
  logOverload({ overloaded: false, message: 'private request body' }, 'management');
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0]), { event: 'mapi.overload', component: 'management' });
  assert.ok(!messages[0].includes('private'));
  console.error = () => { throw new Error('injected error sink failure'); };
  assert.doesNotThrow(() => logRuntimeError('synthetic runtime error'));
} finally {
  console.error = original;
}
console.log('Overload classification logs no error details.');

const wasmMessages = [];
const originalLog = console.log;
try {
  console.log = value => wasmMessages.push(value);
  const boot = '12345678-1234-4abc-8def-123456789abc', object = 'a'.repeat(64);
  let high = observeWasmHighWater(0, 65536, false, boot, object);
  assert.equal(high, 65536); assert.equal(wasmMessages.length, 0);
  high = observeWasmHighWater(high, 65536, true, boot, object);
  high = observeWasmHighWater(high, 0, true, boot, object);
  assert.equal(wasmMessages.length, 0);
  high = observeWasmHighWater(high, 131072, true, boot, object);
  assert.equal(high, 131072); assert.equal(wasmMessages.length, 1);
  assert.deepEqual(JSON.parse(wasmMessages[0]), { event: 'mapi.wasm.highwater', bootId: boot, objectId: object, wasmHighWaterBytes: 131072 });
  console.log = () => { throw new Error('injected logging failure'); };
  assert.equal(observeWasmHighWater(high, 196608, true, boot, object), 196608);
} finally { console.log = originalLog; }
console.log('Sampled Wasm high-water growth logs only sanitized owner and boot metadata.');

const lifecycle=[];
const savedLog=console.log;
try {
  console.log=value=>lifecycle.push(value);
  const boot='boot', object='object';
  logReactorLifecycle(false,'start',boot,object,1,0,0);
  logReactorLifecycle(true,'start',boot,object,1,0,0);
  logReactorLifecycle(true,'failure',boot,object,1,0,65536);
  logReactorLifecycle(true,'start',boot,object,2,0,65536);
  logReactorLifecycle(true,'ready',boot,object,2,1,131072);
  assert.deepEqual(lifecycle.map(JSON.parse),[
    {event:'mapi.reactor.start',bootId:boot,objectId:object,attempt:1},
    {event:'mapi.reactor.failure',bootId:boot,objectId:object,attempt:1},
    {event:'mapi.reactor.start',bootId:boot,objectId:object,attempt:2},
    {event:'mapi.reactor.ready',bootId:boot,objectId:object,initialization:1,wasmHighWaterBytes:131072,attempt:2},
  ]);
  console.log=()=>{throw Error('logging failure');};
  assert.doesNotThrow(()=>logReactorLifecycle(true,'start',boot,object,3,1,131072));
  assert.doesNotThrow(()=>logReactorLifecycle(true,'ready',boot,object,3,2,131072));
  assert.doesNotThrow(()=>logReactorLifecycle(true,'failure',boot,object,3,1,131072));
} finally {console.log=savedLog;}
console.log('Reactor attempt markers are gated, correlated, sanitized and best effort.');
