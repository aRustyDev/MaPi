import assert from 'node:assert/strict';
import { upstreamTestResult } from './upstream-sqlite-test-result.mjs';

const name = 'TestMaPiOwnerA';
const logs = `=== RUN   ${name}\n--- PASS: ${name} (0.00s)\nPASS\n`;
assert.deepEqual(upstreamTestResult(name, { exitCode: 0, logs }), { ran: true, passed: true });
assert.equal(upstreamTestResult(name, { exitCode: 1, logs }).passed, false);
assert.equal(upstreamTestResult(name, { exitCode: 0, logs: 'testing: warning: no tests to run\nPASS\n' }).passed, false);
assert.deepEqual(upstreamTestResult(name, { exitCode: 0, logs: `=== RUN   ${name}\n--- SKIP: ${name} (0.00s)\nPASS\n` }), { ran: true, passed: false });
assert.equal(upstreamTestResult(name, { exitCode: 0, logs: logs.replaceAll(name, name + 'Extra') }).passed, false);
assert.equal(upstreamTestResult(name, { exitCode: 0, logs: `${logs}--- FAIL: ${name} (0.00s)\n` }).passed, false);
assert.equal(upstreamTestResult(name, { exitCode: 0, logs: undefined }).passed, false);
console.log('Pinned Go results require the exact requested test to run and pass.');
