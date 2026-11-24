import { createPublicKey, verify } from 'node:crypto';

// These checks protect the benchmark RP's reported signature and claim
// evidence; they are not a full OIDC conformance suite.
export function parseRpIdToken(token) {
  if (typeof token !== 'string') throw new Error('Invalid ID-token format');
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment) || Buffer.from(segment, 'base64url').toString('base64url') !== segment)) throw new Error('Invalid ID-token format');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch { throw new Error('Invalid ID-token format'); }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) throw new Error('Invalid ID-token header');
  return { header, claims, signingInput: `${segments[0]}.${segments[1]}`, signature: Buffer.from(segments[2], 'base64url') };
}

export function assertRpIdTokenSignature(parsed, keys) {
  const key = Array.isArray(keys) ? keys.find(entry => entry?.kid === parsed?.header?.kid) : undefined;
  if (!key || key.kty !== 'RSA') throw new Error('Invalid ID-token signature');
  let valid = false;
  try { valid = verify('RSA-SHA256', Buffer.from(parsed.signingInput), createPublicKey({ key, format: 'jwk' }), parsed.signature); } catch {}
  if (!valid) throw new Error('Invalid ID-token signature');
}
