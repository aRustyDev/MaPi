import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Only the existing disposable loopback fixture is launched. The sentinel
// checks this synthetic output, not arbitrary Wrangler stderr.
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-timeout-integration-'));
const child = spawn(process.execPath, [resolve('scripts/test-large-real-relocation.mjs')], {
  env: { PATH: process.env.PATH, TMPDIR: directory, XDG_CONFIG_HOME: resolve(directory, 'config'), XDG_CACHE_HOME: resolve(directory, 'cache'), MAPI_LOCAL_TIMEOUT_REGRESSION: '1' },
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
let overflow = false;
function append(current, chunk) { const combined = current + chunk; if (combined.length > 262144) { overflow = true; return combined.slice(0, 262144); } return combined; }
child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
function stopGroup() { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
const timer = setTimeout(stopGroup, 60000);
try {
  const [code] = await once(child, 'exit');
  assert.equal(code, 1, 'The simulated lost acknowledgement must remain a failure');
  assert.equal(overflow, false, 'Unexpected excess diagnostic output');
  assert.ok(!stdout.includes('LOCAL_TIMEOUT_TEST_SECRET_SENTINEL') && !stderr.includes('LOCAL_TIMEOUT_TEST_SECRET_SENTINEL'), 'Synthetic secret appeared in output');
  const events = stderr.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const attempts = events.filter(event => event.event === 'local.timeout.test.attempt');
  const acknowledgements = events.filter(event => event.event === 'local.timeout.test.ack');
  const probes = events.filter(event => event.event === 'local.move.timeout.checkpoints');
  assert.deepEqual(attempts.map(event => event.attempt), [1, 2], 'The runner must not automatically retry advance');
  assert.equal(acknowledgements.length, 1, 'The delayed advance must not be acknowledged');
  assert.ok(stderr.includes('LOCAL_TIMEOUT_TEST_DELAY_REACHED'), 'The delay must begin after both local RPCs completed');
  assert.equal(probes.length, 1, 'A timeout must produce one checkpoint probe');
  const [registry, source, destination] = probes[0].observations;
  assert.equal(registry.outcome, 'read'); assert.equal(registry.phase, 'moving');
  assert.equal(source.outcome, 'read'); assert.equal(destination.outcome, 'read');
  assert.equal(source.nextChunk, acknowledgements[0].nextChunk + 1);
  assert.equal(destination.nextChunk, acknowledgements[0].nextChunk + 1);
  assert.match(stderr, /advance: local request failed \(TimeoutError\)/);
  console.log('Local timeout path observed committed source and destination checkpoints after a delayed acknowledgement without retry.');
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); stopGroup(); await stopped; }
  else stopGroup();
  await rm(directory, { recursive: true, force: true });
}
