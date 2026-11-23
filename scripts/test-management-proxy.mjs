import assert from 'node:assert/strict';
import { handleManagementIngress, isManagementRoute } from '../worker/management-proxy.js';
const origin = 'https://project.example';
const route = { origin, object_name: 'project:one', project_id: 'proj_abc', state: 'active', generation: 3 };
let record, ownerRoute, status = 200, identity = route.project_id, resolved = route;
const object = { async identity() { return identity; }, async handleRequest(req, authority) { record = req; ownerRoute = authority; return { status, headers: { 'Content-Type': ['application/json'], 'Cache-Control': ['public'], 'X-Secret': ['do-not-forward'], 'WWW-Authenticate': ['Bearer'] }, body: btoa('{"ok":true}') }; } };
let objectName;
const registry = { async resolve(value) { assert.equal(value, origin); return resolved; } };
const namespace = { getByName(name) { objectName = name; return object; } };
const send = (path, options = {}) => handleManagementIngress(new Request(origin + path, options), registry, namespace);
const query = '/api/v1/users/query?project_id=proj_abc';
assert.ok(isManagementRoute('GET', '/api/v1/users/user_abc'));
assert.ok(isManagementRoute('POST', '/users/query'));
assert.ok(!isManagementRoute('POST', '/users/user_abc'));
assert.ok(!isManagementRoute('GET', '/users/user_abc%2Ffoo'));
let response = await send(query, { method: 'POST', body: '{}', headers: { authorization: 'Bearer example', cookie: '__Host-zitadel_session=example', origin, 'sec-fetch-site': 'same-origin', 'x-zitadel-csrf': 'csrf', 'x-forwarded-host': 'attacker.example', forwarded: 'host=attacker.example', 'content-type': 'application/json' } });
assert.equal(response.status, 200); assert.equal(objectName, route.object_name);
assert.deepEqual(ownerRoute, { projectId: route.project_id, origin, objectName: route.object_name, generation: route.generation });
assert.equal(record.url, origin + query); assert.equal(record.headers.authorization[0], 'Bearer example'); assert.equal(record.headers.cookie[0], '__Host-zitadel_session=example');
assert.equal(record.headers['sec-fetch-site'][0], 'same-origin'); assert.equal(record.headers['x-zitadel-csrf'][0], 'csrf'); assert.equal(record.headers['x-forwarded-host'], undefined); assert.equal(record.headers.forwarded, undefined);
assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-secret'), null); assert.equal(response.headers.get('www-authenticate'), 'Bearer');
response = await send('/users/user_abc', { headers: { authorization: 'Bearer bearer-only' } }); assert.equal(response.status, 200); assert.equal(record.headers.authorization[0], 'Bearer bearer-only'); assert.equal(record.headers.cookie, undefined);
response = await send('/users/query', { method: 'POST', body: '{}', headers: { cookie: '__Host-zitadel_session=session-only', origin, 'sec-fetch-site': 'same-origin' } }); assert.equal(response.status, 200); assert.equal(record.headers.cookie[0], '__Host-zitadel_session=session-only'); assert.equal(record.headers.authorization, undefined);
status = 401; response = await send('/users/user_abc'); assert.equal(response.status, 401); assert.equal(record.headers.authorization, undefined); status = 200;
record = undefined; assert.equal((await send(query, { method: 'POST', body: '{}', headers: { origin: 'https://evil.example', cookie: 'session=x' } })).status, 403); assert.equal(record, undefined);
assert.equal((await send(query, { method: 'POST', body: '{}', headers: { 'sec-fetch-site': 'cross-site', cookie: 'session=x' } })).status, 403); assert.equal(record, undefined);
assert.equal((await send('/users/query?project_id=proj_other', { method: 'POST', body: '{}' })).status, 403);
assert.equal((await send('/users/query?project_id=proj_abc&project_id=proj_abc', { method: 'POST', body: '{}' })).status, 403);
assert.equal((await send('/users/query', { method: 'POST', body: 'a'.repeat(65_537) })).status, 413);
assert.equal((await send('/users/query', { method: 'POST', body: 'a'.repeat(65_536) })).status, 200); assert.equal(Uint8Array.fromBase64(record.body).length, 65_536);
resolved = { ...route, state: 'pending' }; record = undefined; assert.equal((await send('/users/user_abc')).status, 404); assert.equal(record, undefined);
resolved = null; assert.equal((await send('/users/user_abc')).status, 404);
for (const state of ['moving', 'recovering', 'migrating']) { resolved = { ...route, state }; const maintenance = await send('/users/user_abc'); assert.equal(maintenance.status, 503, `${state} route must be retryable`); assert.equal(maintenance.headers.get('cache-control'), 'no-store'); }
resolved = { ...route, origin: 'https://other.example' }; assert.equal((await send('/users/user_abc')).status, 404);
resolved = route; identity = 'proj_other'; assert.equal((await send('/users/user_abc')).status, 503); assert.equal(record, undefined);
identity = route.project_id; const failingNamespace = { getByName() { throw Error('secret credentials'); } }; response = await handleManagementIngress(new Request(origin + '/users/user_abc'), registry, failingNamespace); assert.equal(response.status, 503); assert.equal(await response.text(), '');
console.log('Management ingress routing, credential/header preservation, origin checks, and body limits passed.');

const { handleManagementApp } = await import('../worker/management-ingress.js');
const fallback = { async fetch() { return new Response('fallback'); } };
const guardedRequest = () => new Request(origin + '/users/user_abc');
let gated = await handleManagementApp(guardedRequest(), {}, fallback);
assert.equal(gated.status, 404);
gated = await handleManagementApp(guardedRequest(), { MAPI_MANAGEMENT_ENABLED: '1', MAPI_MAINTENANCE: '1' }, fallback);
assert.equal(gated.status, 503);
const gatedEnv = { MAPI_MANAGEMENT_ENABLED: '1', PROJECT_REGISTRY: { getByName() { return registry; } }, NEXTGEN_APPLICATION: { getByName() { return { async status() { return { recoveryReady: false }; } }; } } };
gated = await handleManagementApp(guardedRequest(), gatedEnv, fallback);
assert.equal(gated.status, 503);
assert.equal(await (await handleManagementApp(new Request(origin + '/login'), {}, fallback)).text(), 'fallback');
console.log('Management feature flag, maintenance and recovery gates passed.');
const missingSignal = { MAPI_MANAGEMENT_ENABLED: '1', MAPI_REQUIRE_OWNER_MAINTENANCE_CHECK: '1', PROJECT_REGISTRY: { getByName() { return registry; } }, NEXTGEN_APPLICATION: { getByName() { return { async status() { return { recoveryReady: true }; } }; } } };
assert.equal((await handleManagementApp(guardedRequest(), missingSignal, fallback)).status, 503);
missingSignal.NEXTGEN_APPLICATION = { getByName() { return { async status() { return { recoveryReady: true, maintenance: true }; } }; } };
assert.equal((await handleManagementApp(guardedRequest(), missingSignal, fallback)).status, 503);
console.log('Shared ingress rejects missing and active owner maintenance signals.');

// Both the outer ingress and inner proxy perform registry lookups. A route can
// move between those lookups; no user request should reach the stale owner.
let routeReads = 0, requestCalls = 0;
const raceRegistry = { async resolve() { routeReads++; return routeReads === 1 ? route : { ...route, state: 'moving' }; } };
const raceObject = { async status() { return { recoveryReady: true, fenceReady: true, maintenance: false }; }, async identity() { return route.project_id; }, async handleRequest() { requestCalls++; return { status: 200, headers: {}, body: '' }; } };
const raceEnv = { MAPI_MANAGEMENT_ENABLED: '1', PROJECT_REGISTRY: { getByName() { return raceRegistry; } }, NEXTGEN_APPLICATION: { getByName() { return raceObject; } } };
const raced = await handleManagementApp(guardedRequest(), raceEnv, fallback);
assert.equal(raced.status, 503); assert.equal(routeReads, 2); assert.equal(requestCalls, 0);
const otherOrigin = 'https://other.example', otherRoute = { origin: otherOrigin, object_name: 'other-owner', project_id: 'proj_other', state: 'active', generation: 1 };
let otherAuthority, otherRequest;
const isolatedRegistry = { async resolve(value) { return value === origin ? { ...route, state: 'moving' } : value === otherOrigin ? otherRoute : null; } };
const otherObject = { async status() { return { recoveryReady: true, fenceReady: true, maintenance: false }; }, async identity() { return otherRoute.project_id; }, async handleRequest(req, authority) { otherRequest = req; otherAuthority = authority; return { status: 200, headers: {}, body: '' }; } };
const isolatedEnv = { MAPI_MANAGEMENT_ENABLED: '1', PROJECT_REGISTRY: { getByName() { return isolatedRegistry; } }, NEXTGEN_APPLICATION: { getByName(name) { assert.equal(name, otherRoute.object_name); return otherObject; } } };
assert.equal((await handleManagementApp(guardedRequest(), isolatedEnv, fallback)).status, 503);
const otherResponse = await handleManagementApp(new Request(`${otherOrigin}/users/user_other`, { headers: { authorization: 'Bearer other-token' } }), isolatedEnv, fallback);
assert.equal(otherResponse.status, 200); assert.equal(otherRequest.headers.authorization[0], 'Bearer other-token'); assert.equal(otherAuthority.projectId, otherRoute.project_id);
assert.equal((await handleManagementApp(new Request('https://unknown.example/users/user_other'), isolatedEnv, fallback)).status, 404);
console.log('Management moving-route and lookup-race maintenance responses preserve isolation.');

// Malformed maintenance routes are not treated as known projects by either ingress.
for (const state of ['moving', 'recovering', 'migrating']) {
  for (const bad of [{ object_name: '' }, { object_name: null }, { project_id: '' }, { project_id: 'invalid' }, { project_id: null }, { origin: 'https://other.example' }]) {
    resolved = { ...route, state, ...bad };
    assert.equal((await send('/users/user_abc')).status, 404);
    assert.equal((await handleManagementApp(guardedRequest(), gatedEnv, fallback)).status, 404);
  }
}
resolved = { ...route, state: 'pending' };
assert.equal((await handleManagementApp(guardedRequest(), gatedEnv, fallback)).status, 404);
resolved = null;
assert.equal((await handleManagementApp(guardedRequest(), gatedEnv, fallback)).status, 404);
console.log('Malformed maintenance routes remain 404 at both management ingress layers.');
