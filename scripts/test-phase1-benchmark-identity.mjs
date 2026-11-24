import assert from 'node:assert/strict';
import { benchmarkExpectedIdentity } from './phase1-benchmark-identity.mjs';
import { assertRpClaims } from './phase1-rp-claims.mjs';

const env = { MAPI_PHASE1_CHILD: '1', MAPI_PHASE1_EXPECTED_PROJECT: 'p1', MAPI_PHASE1_EXPECTED_USER: 'u1' };
assert.equal(benchmarkExpectedIdentity({ projectId: 'p1' }, env), 'u1');
assert.equal(benchmarkExpectedIdentity({ projectId: 'p2' }, {}), undefined);
for (const [user, values] of [[{ projectId: 'p2' }, env], [{ projectId: 'p1' }, { ...env, MAPI_PHASE1_EXPECTED_USER: '' }], [{ projectId: 'p1' }, { ...env, MAPI_PHASE1_EXPECTED_PROJECT: '' }]]) assert.throws(() => benchmarkExpectedIdentity(user, values), /identity mismatch/);
const expected = { origin: 'https://example.test', projectId: 'p1', nonce: 'n', clientId: 'c', expectedUserId: 'u1', nowSeconds: 10 };
const claims = { iss: 'https://example.test/oauth/p1', nonce: 'n', aud: 'c', sub: 'u1', exp: 11 };
assert.doesNotThrow(() => assertRpClaims(claims, expected));
assert.throws(() => assertRpClaims({ ...claims, sub: 'u2' }, expected), /Invalid ID-token claims/);
console.log('Benchmark child rejects a mismatched project fixture or signed-token subject.');
