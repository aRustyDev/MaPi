import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { assertRpClaims } from './phase1-rp-claims.mjs';
import { parseRpIdToken, assertRpIdTokenSignature } from './phase1-rp-token.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key' };
const claimExpectation = { origin: 'https://issuer.example.test', projectId: 'project-1', nonce: 'nonce-1', clientId: 'client-1', nowSeconds: 1000 };
const claims = { iss: 'https://issuer.example.test/oauth/project-1', nonce: 'nonce-1', aud: 'client-1', sub: 'user-1', exp: 1001 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(header, body) {
  const input = `${encode(header)}.${encode(body)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const valid = token({ alg: 'RS256', kid: 'test-key' }, claims), parsed = parseRpIdToken(valid);
assert.doesNotThrow(() => assertRpIdTokenSignature(parsed, [jwk]));
assert.doesNotThrow(() => assertRpClaims(parsed.claims, claimExpectation));
for (const input of [undefined, null, {}, '', 'header', 'header.payload', `${valid}.extra`, `.${valid.split('.').slice(1).join('.')}`, `${valid}!`, `${valid}=`, 'e30.e30.A']) assert.throws(() => parseRpIdToken(input), /Invalid ID-token format/);
for (const header of [{ alg: 'none', kid: 'test-key' }, { alg: 'HS256', kid: 'test-key' }, { alg: 'RS256' }, { alg: 'RS256', kid: '' }, { alg: 'RS256', kid: 5 }]) assert.throws(() => parseRpIdToken(token(header, claims)), /Invalid ID-token header/);
const changed = valid.split('.'); changed[1] = encode({ ...claims, sub: 'another-user' });
assert.throws(() => assertRpIdTokenSignature(parseRpIdToken(changed.join('.')), [jwk]), /Invalid ID-token signature/);
assert.throws(() => assertRpIdTokenSignature(parsed, [{ ...jwk, kid: 'other' }]), /Invalid ID-token signature/);
for (const overrides of [{ sub: '' }, { sub: null }, { sub: 12 }, { sub: {} }, { exp: '1001' }, { exp: 1000 }]) {
  const invalidClaims = parseRpIdToken(token({ alg: 'RS256', kid: 'test-key' }, { ...claims, ...overrides }));
  assert.doesNotThrow(() => assertRpIdTokenSignature(invalidClaims, [jwk]));
  assert.throws(() => assertRpClaims(invalidClaims.claims, claimExpectation), /Invalid ID-token claims/);
}
const wrongUser = parseRpIdToken(token({ alg: 'RS256', kid: 'test-key' }, { ...claims, sub: 'different-user' }));
assert.doesNotThrow(() => assertRpIdTokenSignature(wrongUser, [jwk]));
assert.throws(() => assertRpClaims(wrongUser.claims, { ...claimExpectation, expectedUserId: 'user-1' }), /Invalid ID-token claims/);
console.log('Benchmark RP verifies a locally signed ID token and rejects malformed, tampered and mismatched tokens.');
