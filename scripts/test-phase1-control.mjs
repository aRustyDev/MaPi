import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import control from '../worker/phase1-control.js';

// Workers provide this method on SubtleCrypto. Supply the Node equivalent for
// this routing test, which does not start a Worker or create credentials.
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(a, b);
let calls = 0;
const route = { project_id: 'proj_example', origin: 'https://example.test', object_name: 'project:a', generation: 1, state: 'active' };
const env = {
  MAPI_OPERATOR_TOKEN: 'operator',
  MAPI_PHASE1_CONTROL_TOKEN: 'control',
  PROJECT_REGISTRY: { getByName: () => ({ resolve: async () => route }) },
  NEXTGEN_APPLICATION: { getByName: () => ({ phase1Control: async (authority, secret, action, userId) => {
    calls++;
    assert.equal(authority.generation, 1);
    assert.equal(secret, 'control');
    assert.equal(userId, 'user_example');
    return action === 'user-audit' ? 1 : 'synthetic-token';
  } }) },
};
function request(token, action = 'user-audit') {
  return new Request('https://private.invalid/', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ origin: route.origin, action, userId: 'user_example' }) });
}
assert.equal((await control.fetch(request('wrong'), env)).status, 404);
assert.equal(calls, 0);
assert.equal((await control.fetch(request('operator', 'invalid'), env)).status, 400);
assert.equal(calls, 0);
const response = await control.fetch(request('operator'), env);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { result: 1 });
assert.equal(calls, 1);
route.state = 'moving';
assert.equal((await control.fetch(request('operator'), env)).status, 404);
assert.equal(calls, 1);
console.log('Private phase 1 control authorization and route checks passed.');
