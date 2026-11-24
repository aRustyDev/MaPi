import { performance } from 'node:perf_hooks';
import { benchmarkChildFailure } from './phase1-benchmark-report.mjs';

// Terminal messages and exits are sticky: a second wait after an early exit
// fails promptly rather than losing the terminal event and waiting again.
export function watchBenchmarkChild(processChild, onProgress, { timeoutMs = 180000, now = () => performance.timeOrigin + performance.now() } = {}) {
  const pending = [];
  let wake, terminal;
  function signal() { if (wake) { const resolve = wake; wake = undefined; resolve(); } }
  processChild.on('message', message => {
    if (message?.type === 'setup-progress') { onProgress(message); return; }
    if (message?.type === 'wave-start') message = { ...message, parentReceivedAtMs: now() };
    pending.push(message); signal();
  });
  processChild.on('exit', () => { terminal ??= new Error('Benchmark child exited'); signal(); });
  processChild.on('error', () => { terminal ??= new Error('Benchmark child process error'); signal(); });
  return {
    process: processChild,
    async next(type) {
      while (!pending.length) {
        if (terminal) throw terminal;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { wake = undefined; terminal ??= new Error('Benchmark child timed out'); reject(terminal); }, timeoutMs);
          wake = () => { clearTimeout(timeout); resolve(); };
        });
      }
      const message = pending.shift();
      if (message?.type === 'child-failure') {
        terminal = benchmarkChildFailure(message);
        throw terminal;
      }
      if (message?.type !== type) { terminal = new Error('Unexpected benchmark child message'); throw terminal; }
      return message;
    },
  };
}
