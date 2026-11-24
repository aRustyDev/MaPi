import assert from 'node:assert/strict';
import { assertExpectedReplay } from './phase1-rp-evidence.mjs';
const response = (status, body) => new Response(body, { status });
await assertExpectedReplay(response(400, '{"error":"invalid_grant"}'), new AbortController());
for (const [status, body, kind] of [[200, '{}', 'invalid'], [400, '{"error":"invalid_client"}', 'invalid'], [429, 'private response', 'http'], [500, 'private response', 'http'], [400, 'private malformed', 'response']]) {
  await assert.rejects(assertExpectedReplay(response(status, body), new AbortController()), error => {
    assert.deepEqual(error.phase1RpFailure, { stage: 'replay', kind, status });
    assert.ok(!String(error).includes('private'));
    return true;
  });
}
console.log('Replay evidence accepts only the pinned invalid_grant response and redacts failures.');
