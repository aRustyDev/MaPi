import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mapiEvents, mapiPayloads } from './mapi-event-contract.mjs';

const test = await readFile('scripts/mapi-event-roundtrip-test.go', 'utf8');
const names = mapiEvents.map(([name]) => name);
assert.equal(new Set(names).size, names.length, 'Duplicate MaPi event contract type');
for (const [name, payload] of mapiEvents) {
  assert.ok(test.includes(`"${name}"`), `Missing generated round-trip case for ${name}`);
  assert.ok(payload === 'empty-event-payload.yaml' || Object.hasOwn(mapiPayloads, payload), `Missing payload schema for ${name}`);
}
console.log(`MaPi audit contract maps ${names.length} distinct types to tested payloads.`);
