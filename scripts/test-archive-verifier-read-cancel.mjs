// Initial verifier authority reads only; no archive, Workerd, AWS or Woven.
import assert from 'node:assert/strict';
import { advanceConfiguredSyntheticVerifier } from '../worker/synthetic-archive-verifier-runner.js';

const config = { scope:{}, commitment:{}, envelopeDigest:'',
  sealingJobId:'1'.repeat(32), verificationJobId:'2'.repeat(32) };
const verification = { read:async () => null, create:async () => {}, compareAndSwap:async () => {} };

async function exercise(position, lateFailure) {
  let settle, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const pending = new Promise((resolve,reject) => { settle = lateFailure ? reject : resolve; });
  let calls = 0;
  const stalled = { read() { calls++; entered(); return pending; }, create:async () => {}, compareAndSwap:async () => {} };
  const sealing = position === 'sealing' ? stalled : { read:async () => ({terminal:true}) };
  const destination = position === 'verification' ? stalled : verification;
  const controller = new AbortController();
  const result = advanceConfiguredSyntheticVerifier(config,{}, {},sealing,destination,controller.signal);
  await waiting;
  controller.abort();
  await assert.rejects(result, {message:'Archive verifier canceled'});
  assert.equal(calls,1);
  // A dispatched read is not canceled. Its late resolution/rejection must be
  // consumed without causing another verifier step or an unhandled rejection.
  settle(lateFailure ? Error('late private error') : {terminal:true});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls,1);
}

for (const position of ['sealing','verification']) {
  await exercise(position,false);
  await exercise(position,true);
}
console.log('Initial synthetic verifier authority read cancellation passed');
