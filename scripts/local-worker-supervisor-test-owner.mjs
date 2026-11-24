// Synthetic owner used to exercise supervisor IPC disconnect; never starts Wrangler.
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalWorker } from './local-worker-harness.mjs';

if (typeof process.send !== 'function') throw Error('Test owner requires IPC');
const code = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
const worker = startLocalWorker(process.execPath, ['-e', code], process.env, process.cwd());
for (let i = 0; i < 100 && !worker.childPid && !worker.failure; i++) await delay(20);
if (!worker.childPid || worker.failure) throw Error('Synthetic child did not start');
process.send({ supervisorPid: worker.supervisor.pid, childPid: worker.childPid });
process.on('message', message => {
  // Simulates unexpected loss of the parent; IPC disconnect, not a signal to
  // an externally chosen PID, triggers the supervisor's own group cleanup.
  if (message?.type === 'exit') process.exit(0);
});
