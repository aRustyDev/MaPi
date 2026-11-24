import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const SUPERVISOR = new URL('./local-worker-supervisor.mjs', import.meta.url);

// The supervisor owns a fresh session. The parent communicates through IPC
// and never signals a potentially recycled process-group identifier.
export function startLocalWorker(file, args, env, cwd) {
  const supervisor = spawn(process.execPath, [SUPERVISOR.pathname], {
    cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let childFailure = null, childPid = null, supervisorError = null;
  for (const stream of [supervisor.stdout, supervisor.stderr]) stream.resume(); // Never retain or print arbitrary child logs.
  supervisor.on('error', () => { supervisorError = 'supervisor error'; });
  supervisor.on('message', message => {
    if (message?.type === 'child-started') childPid = message.pid;
    if (message?.type === 'child-error' || message?.type === 'child-exit' || message?.type === 'stop-error') childFailure = message.type;
  });
  supervisor.send({ type: 'start', file, args }, error => { if (error) supervisorError = 'supervisor IPC failed'; });
  return {
    supervisor,
    get childPid() { return childPid; },
    get failure() { return supervisorError || childFailure || (supervisor.exitCode !== null || supervisor.signalCode !== null ? 'supervisor exited' : null); },
    // True means only that this particular owned process group disappeared.
    // It does not prove descendants could not create a separate session.
    async stopOwnedGroup(timeoutMs = 5000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw Error('Invalid supervisor timeout');
      // If the leader died unexpectedly, descendants may have escaped. Do not
      // signal its old PGID and do not claim cleanup is verified.
      if (!supervisor.connected || supervisor.exitCode !== null || supervisor.signalCode !== null) return false;
      const exited = once(supervisor, 'exit').catch(() => null);
      try { await new Promise((resolve, reject) => supervisor.send({ type: 'stop' }, error => error ? reject(error) : resolve())); }
      catch { return false; }
      const result = await Promise.race([exited, delay(timeoutMs).then(() => null)]);
      if (!result || result[1] !== 'SIGKILL') return false;
      // kill(0) checks for *remaining* members but never signals them. If a
      // group survives or the result is ambiguous, keep the state directory.
      for (let i = 0; i < 100; i++) {
        try { process.kill(-supervisor.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') return true; return false; }
        await delay(50);
      }
      return false;
    },
  };
}

// The expected nonce stays in the Worker env file. The readiness request does
// not disclose it to an unrelated listener that wins the port race.
export async function verifyLocalReadiness(origin, nonce, failure, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (failure()) throw Error('Local Worker stopped during startup');
    let response;
    try {
      response = await fetch(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"readiness"}', redirect: 'error', signal: AbortSignal.timeout(1000) });
    } catch { await delay(200); continue; }
    if (response.status !== 200 || !response.body) throw Error('Local Worker readiness identity mismatch');
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4096) throw Error('Local Worker readiness identity mismatch');
        chunks.push(value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || Object.keys(result).length !== 1 || result.ready !== nonce) throw Error('Local Worker readiness identity mismatch');
      return;
    } catch { throw Error('Local Worker readiness identity mismatch'); }
    finally { await reader.cancel().catch(() => {}); }
  }
  throw Error('Local Worker startup timed out');
}
