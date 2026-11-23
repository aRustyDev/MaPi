import assert from 'node:assert/strict';
import { assertRpClaims } from './phase1-rp-claims.mjs';

const expected = { origin: 'https://issuer.example.test', projectId: 'project-1', nonce: 'nonce-1', clientId: 'client-1', nowSeconds: 1000 };
const valid = { iss: 'https://issuer.example.test/oauth/project-1', nonce: 'nonce-1', aud: 'client-1', sub: 'user-1', exp: 1001 };
assert.doesNotThrow(() => assertRpClaims(valid, expected));
assert.doesNotThrow(() => assertRpClaims({ ...valid, aud: ['other', 'client-1'] }, expected));
for (const exp of [undefined, null, '1001', 'bad', NaN, Infinity, -Infinity, 1000, 999]) {
  assert.throws(() => assertRpClaims({ ...valid, exp }, expected), /Invalid ID-token claims/, `invalid expiry ${String(exp)} must fail`);
}
for (const overrides of [{ iss: 'other' }, { nonce: 'other' }, { aud: 'other' }, { sub: '' }, { sub: 42 }, { sub: {} }]) {
  assert.throws(() => assertRpClaims({ ...valid, ...overrides }, expected), /Invalid ID-token claims/);
}
console.log('Benchmark RP rejects missing, nonnumeric, nonfinite and expired ID-token expiry.');
