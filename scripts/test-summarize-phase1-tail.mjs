import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'mapi-tail-regression-'));
const script = join(import.meta.dirname, 'summarize-phase1-tail.mjs');
const id = 'a'.repeat(64), boot = '12345678-1234-4abc-8def-123456789abc', other = '87654321-4321-4abc-8def-cba987654321';
const version = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const record = (event, stamp) => ({ timestamp: stamp, message: [JSON.stringify(event)] });
const first = { eventTimestamp: 1700000000000, executionModel: 'durableObject', durableObjectId: id, scriptVersion: { id: version }, outcome: 'ok', cpuTime: 12, wallTime: 50, event: { request: { url: 'https://secret.invalid/', headers: { authorization: 'secret' } } }, logs: [record({ event: 'mapi.owner.boot', objectId: id, bootId: boot, secret: 'secret' }, 1700000000001), record({ event: 'mapi.reactor.ready', objectId: id, bootId: boot, initialization: 1, wasmHighWaterBytes: 65536 }, 1700000000003)] };
const second = { ...first, eventTimestamp: first.eventTimestamp, logs: [record({ event: 'mapi.owner.boot', objectId: id, bootId: other }, 1700000000002)] };
const input = join(dir, 'tail.jsonl');
try {
  await writeFile(input, JSON.stringify(first, null, 2) + '\n' + JSON.stringify(second) + '\n', { mode: 0o600 });
  const output = execFileSync(process.execPath, [script, input], { encoding: 'utf8' });
  assert.ok(!output.includes('secret'));
  const summary = JSON.parse(output);
  assert.equal(summary.records, 2); assert.equal(summary.invalidFields, 0); assert.equal(summary.malformed, 0);
  assert.deepEqual(summary.markers.map(x => x.invocationIndex), [0, 0, 1]);
  assert.deepEqual(summary.markers.map(x => x.logTimestamp), [1700000000001, 1700000000003, 1700000000002]);
  assert.equal(summary.markers[1].logTimestamp - summary.markers[0].logTimestamp, 2);
  assert.equal(summary.invocations[0].scriptVersion, version);
  assert.equal(summary.completeness, 'unverified');
  const bad = { eventTimestamp: -1, executionModel: 'private-model', durableObjectId: 'private-object', scriptVersion: { id: 'private-version' }, outcome: 'private-outcome', cpuTime: -1, logs: [record({ event: 'mapi.overload', component: 'private-component', bootId: 'private-boot', objectId: 'private-object', initialization: 'private-init', wasmHighWaterBytes: 'private-memory' }, -1)] };
  await writeFile(input, JSON.stringify(bad) + '\n' + 'null\n' + JSON.stringify({ logs: 'private-logs' }) + '\n', { mode: 0o600 });
  let failed;
  try { execFileSync(process.execPath, [script, input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { failed = error; }
  assert.equal(failed?.status, 1);
  assert.ok(!failed.stdout.includes('private-'));
  const invalid = JSON.parse(failed.stdout);
  assert.ok(invalid.invalidFields >= 10); assert.equal(invalid.malformed, 2); assert.equal(invalid.overloads, 1);
  assert.equal(invalid.byOutcome.unknown, 1); assert.equal(invalid.markers[0].component, null);
  // Event fields are required according to their actual producer contracts.
  // Other Tail metadata is optional; capture completeness remains unverified.
  const events = [
    { event: 'mapi.worker.boot', bootId: boot },
    { event: 'mapi.owner.boot', bootId: boot, objectId: id },
    { event: 'mapi.reactor.ready', bootId: boot, objectId: id, initialization: 1, wasmHighWaterBytes: 65536 },
    { event: 'mapi.wasm.highwater', bootId: boot, objectId: id, wasmHighWaterBytes: 131072 },
    { event: 'mapi.overload', component: 'application' },
    { event: 'mapi.flow.submit', kind: 'password', bootId: boot },
  ];
  for (const event of events) {
    const ownerSpecific = ['mapi.owner.boot', 'mapi.reactor.ready', 'mapi.wasm.highwater', 'mapi.flow.submit'].includes(event.event);
    const envelope = ownerSpecific ? { durableObjectId: id } : {};
    await writeFile(input, JSON.stringify({ ...envelope, logs: [record(event)] }) + '\n', { mode: 0o600 });
    const valid = JSON.parse(execFileSync(process.execPath, [script, input], { encoding: 'utf8' }));
    assert.equal(valid.invalidFields, 0, `valid ${event.event}`);
    assert.equal(valid.markers[0].attributionValid, ownerSpecific ? true : null);
    assert.equal(valid.completeness, 'unverified');
    for (const name of Object.keys(event).filter(name => name !== 'event')) {
      for (const missingValue of [undefined, null]) {
        const incomplete = { ...event, [name]: missingValue };
        await writeFile(input, JSON.stringify({ ...envelope, logs: [record(incomplete)] }) + '\n', { mode: 0o600 });
        assert.throws(() => execFileSync(process.execPath, [script, input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => {
          const result = JSON.parse(error.stdout);
          assert.equal(error.status, 1, `${event.event}.${name}`);
          assert.equal(result.invalidFields, name === 'objectId' ? 2 : 1, `${event.event}.${name}`);
          assert.equal(result.markers[0][name], null);
          return true;
        });
      }
    }
    if (ownerSpecific) {
      for (const absentId of [undefined, null]) {
        await writeFile(input, JSON.stringify({ durableObjectId: absentId, logs: [record(event)] }) + '\n', { mode: 0o600 });
        assert.throws(() => execFileSync(process.execPath, [script, input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => {
          const result = JSON.parse(error.stdout);
          return error.status === 1 && result.invalidFields === 1 && result.markers[0].attributionValid === false;
        });
      }
      await writeFile(input, JSON.stringify({ durableObjectId: id, executionModel: 'stateless', logs: [record(event)] }) + '\n', { mode: 0o600 });
      assert.throws(() => execFileSync(process.execPath, [script, input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => {
        const result = JSON.parse(error.stdout);
        return error.status === 1 && result.invalidFields === 1 && result.markers[0].attributionValid === false;
      });
      if (event.objectId) {
        await writeFile(input, JSON.stringify({ durableObjectId: 'b'.repeat(64), logs: [record(event)] }) + '\n', { mode: 0o600 });
        assert.throws(() => execFileSync(process.execPath, [script, input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => {
          const result = JSON.parse(error.stdout);
          return error.status === 1 && result.invalidFields === 1 && result.markers[0].attributionValid === false;
        });
      }
    }
  }
  // A worker boot cannot originate from a Durable Object invocation, but
  // an absent execution model does not identify which model produced it.
  const workerBoot = { event: 'mapi.worker.boot', bootId: boot };
  for (const [model, expected] of [['stateless', true], [undefined, null]]) {
    await writeFile(input, JSON.stringify({ executionModel: model, logs: [record(workerBoot)] }) + '\n', { mode: 0o600 });
    const result = JSON.parse(execFileSync(process.execPath, [script, input], { encoding: 'utf8' }));
    assert.equal(result.invalidFields, 0);
    assert.equal(result.markers[0].attributionValid, expected);
  }
  await writeFile(input, JSON.stringify({ executionModel: 'durableObject', logs: [record(workerBoot)] }) + '\n', { mode: 0o600 });
  assert.throws(() => execFileSync(process.execPath, [script, input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => {
    const result = JSON.parse(error.stdout);
    return error.status === 1 && result.invalidFields === 1 && result.markers[0].attributionValid === false;
  });
  // A ready reactor cannot have zero bytes of initialized linear memory.
  const zeroMemory = { event: 'mapi.reactor.ready', bootId: boot, objectId: id, initialization: 1, wasmHighWaterBytes: 0 };
  await writeFile(input, JSON.stringify({ durableObjectId: id, logs: [record(zeroMemory)] }) + '\n', { mode: 0o600 });
  assert.throws(() => execFileSync(process.execPath, [script, input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => {
    const result = JSON.parse(error.stdout);
    return error.status === 1 && result.invalidFields === 1 && result.markers[0].wasmHighWaterBytes === null;
  });
  // Retain independently scoped growth markers across owner eviction/reboot.
  const growth = [
    { event: 'mapi.wasm.highwater', bootId: boot, objectId: id, wasmHighWaterBytes: 65536 },
    { event: 'mapi.wasm.highwater', bootId: boot, objectId: id, wasmHighWaterBytes: 131072 },
    { event: 'mapi.wasm.highwater', bootId: other, objectId: id, wasmHighWaterBytes: 65536 },
  ];
  await writeFile(input, growth.map(event => JSON.stringify({ durableObjectId: id, executionModel: 'durableObject', logs: [record(event)] })).join('\n') + '\n', { mode: 0o600 });
  const growthSummary = JSON.parse(execFileSync(process.execPath, [script, input], { encoding: 'utf8' }));
  assert.deepEqual(growthSummary.markers.map(({ bootId, wasmHighWaterBytes, attributionValid }) => ({ bootId, wasmHighWaterBytes, attributionValid })), [
    { bootId: boot, wasmHighWaterBytes: 65536, attributionValid: true },
    { bootId: boot, wasmHighWaterBytes: 131072, attributionValid: true },
    { bootId: other, wasmHighWaterBytes: 65536, attributionValid: true },
  ]);
  assert.equal(growthSummary.completeness, 'unverified');
  await writeFile(input, '{"incomplete":\n', { mode: 0o600 });
  assert.throws(() => execFileSync(process.execPath, [script, input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && JSON.parse(error.stdout).malformed === 1);
  console.log('Tail summaries correlate markers by record and reject malformed or sensitive fields.');
} finally { await rm(dir, { recursive: true, force: true }); }
