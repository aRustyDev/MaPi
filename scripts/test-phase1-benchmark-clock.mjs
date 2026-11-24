import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { benchmarkOverlapPassed } from './phase1-benchmark-metrics.mjs';

const now = () => performance.timeOrigin + performance.now();
if (process.argv[2] === 'child') {
  process.send({ ready: true });
  process.once('message', () => {
    const childReceivedAtMs = now();
    const starts = Array.from({ length: 4 }, () => now());
    process.send({ childReceivedAtMs, childAcknowledgedAtMs: now(), starts });
    setTimeout(() => { process.send({ ends: starts.map(() => now()) }); process.disconnect(); }, 100);
  });
} else {
  const child = fork(fileURLToPath(import.meta.url), ['child'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const [ready] = await once(child, 'message'); assert.equal(ready.ready, true);
  const sent = now(); child.send({ start: true });
  const [ack] = await once(child, 'message'); const received = now();
  const [completion] = await once(child, 'message');
  const start = { attempts: 4, started: 4, parentSentAtMs: sent, parentReceivedAtMs: received, childReceivedAtMs: ack.childReceivedAtMs, childAcknowledgedAtMs: ack.childAcknowledgedAtMs };
  assert.ok(start.childAcknowledgedAtMs - start.parentReceivedAtMs <= start.childReceivedAtMs - start.parentSentAtMs, 'IPC clocks have inconsistent offset bounds');
  const operations = ['get', 'query', 'get', 'query'].map((operation, index) => ({ operation, startedAtMs: received + 1 + index * 5, endedAtMs: received + 5 + index * 5 }));
  const outcomes = [{ signInIntervals: ack.starts.map((startedAtMs, index) => ({ startedAtMs, endedAtMs: completion.ends[index] })) }, { signInIntervals: ack.starts.map((startedAtMs, index) => ({ startedAtMs, endedAtMs: completion.ends[index] })) }];
  const waves = Array.from({ length: 5 }, (_, index) => ({ starts: [start, start], outcomes, management: [0, 1].map(() => ({ attempts: index === 1 || index === 3 ? 6 : 4, operationIntervals: [...operations, ...(index === 1 || index === 3 ? [{ operation: 'create', startedAtMs: received + 1, endedAtMs: received + 20 }, { operation: 'created-get', startedAtMs: received + 21, endedAtMs: received + 25 }] : [])] })) }));
  assert.equal(benchmarkOverlapPassed(true, waves), true);
  if (child.exitCode === null) await once(child, 'exit');
  console.log('Parent and child monotonic clock bounds admit provable local client overlap.');
}
