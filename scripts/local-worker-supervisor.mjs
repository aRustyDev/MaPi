// A disposable local test supervisor. It owns its detached process group; it
// never signals a group whose identity might have been recycled.
import { spawn } from 'node:child_process';

if (process.platform === 'win32' || typeof process.send !== 'function') throw Error('Local supervisor requires POSIX and parent IPC');
let child, started = false, stopping = false;
function report(message) { if (process.connected) process.send(message, () => {}); }
function stop() {
  if (stopping) return;
  stopping = true;
  report({ type: 'stopping' });
  // This process remains the live session/group leader until its own
  // escalation. Descendants cannot cause a recycled PGID to be signalled.
  try { process.kill(-process.pid, 'SIGTERM'); }
  catch { report({ type: 'stop-error' }); return; }
  setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); }
    catch { report({ type: 'stop-error' }); }
  }, 1000);
}
process.on('SIGTERM', () => { if (!stopping) stop(); });
process.on('SIGINT', stop);
process.on('disconnect', stop);
process.on('message', message => {
  if (message?.type === 'stop') { stop(); return; }
  if (message?.type !== 'start' || started || stopping) return;
  started = true;
  try {
    if (typeof message.file !== 'string' || !Array.isArray(message.args) || message.args.some(arg => typeof arg !== 'string')) throw Error('Invalid child');
    child = spawn(message.file, message.args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => report({ type: 'child-error' }));
    child.on('exit', (code, signal) => report({ type: 'child-exit', code, signal }));
    report({ type: 'child-started', pid: child.pid });
  } catch { report({ type: 'child-error' }); }
});
