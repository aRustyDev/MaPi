import assert from 'node:assert/strict';
import { readRehearsalCounts, assertRehearsalEvidenceCounts, rehearsalEvidenceDone } from './rehearsal-evidence.mjs';

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const valid = { projects: 1, users: 1, events: 31 };
assert.deepEqual(await readRehearsalCounts(response(valid)), valid);
await assert.rejects(readRehearsalCounts(response(valid, 503)), /count request failed/);
for (const invalid of [null, [], {}, { projects: 1, events: 31 }, { ...valid, users: '1' },
  { ...valid, users: -1 }, { ...valid, users: 0 }, { ...valid, events: 0 },
  { ...valid, projects: 2 }, { ...valid, events: Number.MAX_SAFE_INTEGER + 1 }]) {
  await assert.rejects(readRehearsalCounts(response(invalid)), /Invalid rehearsal count baseline/);
}
await assert.rejects(readRehearsalCounts(new Response('invalid', { status: 200 })));
assert.doesNotThrow(() => assertRehearsalEvidenceCounts(new Map([['users', 1], ['events', 31]]), valid));
assert.throws(() => assertRehearsalEvidenceCounts(new Map([['users', 1]]), valid), /events differ/);
assert.throws(() => assertRehearsalEvidenceCounts(new Map([['events', 31]]), valid), /users differ/);
assert.throws(() => assertRehearsalEvidenceCounts(new Map([['users', 1], ['events', 30]]), valid), /events differ/);
assert.equal(rehearsalEvidenceDone({ complete: true, done: true, pages: [] }), true);
assert.equal(rehearsalEvidenceDone({ complete: true, done: false, pages: [] }), false);
for (const invalid of [null, [], {}, { complete: true, pages: [] },
  { complete: true, done: 'false', pages: [] }, { complete: true, done: 0, pages: [] },
  { complete: false, done: true, pages: [] }, { complete: true, done: true, pages: null }]) {
  assert.throws(() => rehearsalEvidenceDone(invalid), /Invalid rehearsal evidence page/);
}
console.log('Rehearsal evidence requires valid baseline counts and both reconciled tables.');
