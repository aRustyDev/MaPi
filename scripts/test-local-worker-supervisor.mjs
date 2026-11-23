// Controlled synthetic process tests. Never starts Wrangler or uses credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalWorker } from './local-worker-harness.mjs';

if (process.platform === 'win32') throw Error('POSIX process groups required');
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-supervisor-synthetic-'));
const env = { PATH: process.env.PATH, TMPDIR: dir };
const live = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function until(predicate, message) {
  for (let i = 0; i < 250; i++) { if (await predicate()) return; await delay(20); }
  throw Error(message);
}
let safelyStopped = false;
const workers = [];
let owner;
try {
  // This controlled child starts one controlled grandchild in its own group.
  // Both ignore TERM, forcing the supervisor's own-group escalation.
  const pidFile = resolve(dir, 'grandchild.pid');
  const childCode = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'}); writeFileSync(process.env.MAPI_SYNTHETIC_PID_FILE,String(c.pid),{mode:0o600}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  const worker = startLocalWorker(process.execPath, ['-e', childCode], { ...env, MAPI_SYNTHETIC_PID_FILE: pidFile }, process.cwd());
  workers.push(worker);
  await until(async () => worker.childPid && await readFile(pidFile, 'utf8').then(() => true, () => false), 'Synthetic child tree did not start');
  const childPid = worker.childPid, grandchildPid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
  assert.equal(await worker.stopOwnedGroup(), true, 'Owned group did not terminate');
  await until(() => !live(childPid) && !live(grandchildPid), 'Known synthetic descendants remain');

  // A child that exits during startup leaves the supervisor alive for cleanup.
  const failed = startLocalWorker(process.execPath, ['-e', 'process.exit(7)'], env, process.cwd());
  workers.push(failed);
  await until(() => failed.failure, 'Synthetic startup failure not observed');
  assert.equal(await failed.stopOwnedGroup(), true, 'Failed-start group did not terminate');

  // A caller timeout is uncertainty, not permission to remove state. The
  // supervisor continues its own bounded group termination independently.
  const timed = startLocalWorker(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], env, process.cwd());
  workers.push(timed);
  await until(() => timed.childPid, 'Synthetic timeout child did not start');
  const timedPid = timed.childPid;
  assert.equal(await timed.stopOwnedGroup(1), false, 'Timeout incorrectly reported cleanup');
  await until(() => !live(-timed.supervisor.pid) && !live(timedPid), 'Timed-out synthetic group remains');

  // Simulate an owner dying without asking the supervisor to stop. Its IPC
  // disconnect must cause the supervisor to terminate its own group.
  owner = spawn(process.execPath, [new URL('./local-worker-supervisor-test-owner.mjs', import.meta.url).pathname], { env, cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  owner.on('error', () => {});
  const [ids] = await Promise.race([once(owner, 'message'), delay(5000).then(() => { throw Error('Synthetic owner startup timed out'); })]);
  assert.ok(Number.isSafeInteger(ids.supervisorPid) && Number.isSafeInteger(ids.childPid));
  const ownerExit = once(owner, 'exit');
  await new Promise((resolve, reject) => owner.send({ type: 'exit' }, error => error ? reject(error) : resolve()));
  const [code] = await ownerExit;
  assert.equal(code, 0);
  await until(() => !live(-ids.supervisorPid) && !live(ids.childPid), 'Disconnected synthetic group remains');
  safelyStopped = true;
  console.log('Synthetic supervisor success, startup-failure, timeout and disconnect checks passed');
} finally {
  // Stop only supervisors whose IPC channel is still live; a missing leader
  // never triggers a signal to its potentially recycled group ID.
  for (const worker of workers) if (worker.supervisor.connected) await worker.stopOwnedGroup().catch(() => false);
  if (owner?.connected) await new Promise(resolve => owner.send({ type: 'exit' }, () => resolve())).catch(() => {});
  // No directory is deleted unless every explicitly known test process exited.
  if (safelyStopped) await rm(dir, { recursive: true, force: true });
  else console.error('Synthetic test state retained because cleanup was not established');
}
