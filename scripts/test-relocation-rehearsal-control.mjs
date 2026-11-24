import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import control from '../worker/relocation-rehearsal-control.js';

// Match Workers' SubtleCrypto extension for this isolated routing test.
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(a, b);
let calls = [];
const env = {
  MAPI_REHEARSAL_SYNTHETIC_ONLY: '1', MAPI_REHEARSAL_OPERATOR_TOKEN: 'operator-secret',
  MAPI_RELOCATION_CONTROL_TOKEN: 'relocation-secret', MAPI_REHEARSAL_ORIGIN: 'https://synthetic.example',
  MAPI_REHEARSAL_PROJECT_ID: 'project-synthetic', MAPI_REHEARSAL_MOVE_ID: 'move-synthetic',
  MAPI_PHASE1_CONTROL_TOKEN: 'phase-control', MAPI_REHEARSAL_OTHER_ORIGIN: 'https://other.example', MAPI_REHEARSAL_OTHER_PROJECT_ID: 'project-other',
  RELOCATION_COORDINATOR: { getByName(name) { assert.equal(name, 'synthetic-rehearsal'); return { advance(...args) { calls.push(args); return { done: false, phase: 'importing' }; }, evidence(secret, project, move, after) { assert.equal(secret, 'relocation-secret'); assert.equal(project, 'project-synthetic'); assert.equal(move, 'move-synthetic'); return { complete: true, done: true, next: after, pages: [] }; } }; } },
  PROJECT_REGISTRY: { getByName() { return { resolve() { return { state: 'active', project_id: 'project-other', origin: 'https://other.example', object_name: 'project:other', generation: 1 }; }, relocationStatus() { return { route: { project_id: 'project-synthetic', origin: 'https://synthetic.example', object_name: 'destination', generation: 2 }, move: { phase: 'committed', move_id: 'move-synthetic', source_object: 'application', destination_object: 'destination', generation: 1 } }; } }; } },
  NEXTGEN_APPLICATION: { getByName(name) { if (name === 'project:other') return { phase1Control(route, token, action) { assert.equal(route.projectId, 'project-other'); assert.equal(token, 'phase-control'); return action === 'project-token' ? 'synthetic-token' : true; } }; assert.equal(name, 'application'); return { addUser() { throw Error('Owner is fenced or route is stale'); } }; } },
};
const request = (token = 'operator-secret', method = 'POST') => new Request('https://service.invalid/', { method, headers: { authorization: `Bearer ${token}` }, ...(method === 'POST' ? { body: JSON.stringify({ projectId: 'foreign', origin: 'https://foreign.example', moveId: 'foreign' }) } : {}) });
assert.equal((await control.fetch(request('wrong'), env)).status, 404);
assert.equal((await control.fetch(request(), { ...env, MAPI_REHEARSAL_SYNTHETIC_ONLY: '0' })).status, 404);
assert.equal((await control.fetch(request('operator-secret', 'GET'), env)).status, 405);
assert.equal((await control.fetch(request(), { ...env, MAPI_REHEARSAL_PROJECT_ID: '' })).status, 503);
assert.deepEqual(calls, []);
const response = await control.fetch(request(), env);
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.deepEqual(await response.json(), { done: false, phase: 'importing' });
assert.deepEqual(calls, [['relocation-secret', 'https://synthetic.example', 'project-synthetic', 'move-synthetic']]);
const stale = await control.fetch(new Request('https://service.invalid/stale-probe', { method: 'POST', headers: { authorization: 'Bearer operator-secret' } }), env);
assert.equal(stale.status, 200); assert.deepEqual(await stale.json(), { rejected: true, generation: 1 });
const management = await control.fetch(new Request('https://service.invalid/management-token', { method: 'POST', headers: { authorization: 'Bearer operator-secret' } }), env);
assert.equal(management.status, 200); assert.deepEqual(await management.json(), { token: 'synthetic-token' });
const evidence = await control.fetch(new Request('https://service.invalid/evidence?after=4', { method: 'POST', headers: { authorization: 'Bearer operator-secret' } }), env);
assert.deepEqual(await evidence.json(), { complete: true, done: true, next: 4, pages: [] });
assert.equal((await control.fetch(new Request('https://service.invalid/evidence?after=-1', { method: 'POST', headers: { authorization: 'Bearer operator-secret' } }), env)).status, 400);
const dangerous = { ...env, NEXTGEN_APPLICATION: { getByName() { return { addUser() { return true; } }; } } };
assert.equal((await control.fetch(new Request('https://service.invalid/stale-probe', { method: 'POST', headers: { authorization: 'Bearer operator-secret' } }), dangerous)).status, 503);
console.log('Verified rehearsal service denies unauthorized calls and ignores request-selected targets.');
