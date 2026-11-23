// Claims checked by the independent benchmark RP after signature verification.
// This is a runtime-evidence check, not full issuer conformance.
export function assertRpClaims(claims, { origin, projectId, nonce, clientId, expectedUserId, nowSeconds = Date.now() / 1000 }) {
  if (!claims || claims.iss !== `${origin}/oauth/${projectId}` || claims.nonce !== nonce || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(clientId) || typeof claims.sub !== 'string' || !claims.sub || (expectedUserId !== undefined && claims.sub !== expectedUserId) || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) throw new Error('Invalid ID-token claims');
}
