// Source contract for MaPi-owned audit types. Do not deploy the local event
// test owner without the separate runtime, authorization, and parity gates.
const empty = 'empty-event-payload.yaml';
export const mapiEvents = [
  ['mapi.oauth.signing_key.rotated', empty],
  ['mapi.oauth.code.issued', empty],
  ['mapi.oauth.refresh.reuse', empty],
  ['mapi.oauth.client_credential.rotated', empty],
  ['mapi.oauth.client_credential.revoked', empty],
  ['mapi.oauth.logout_uri.registered', 'mapi-uri-payload.yaml'],
  ['mapi.oauth.profile_client.assigned', 'mapi-profile-payload.yaml'],
  ['mapi.fapi.resource_policy.updated', 'mapi-resource-policy-payload.yaml'],
  ['mapi.fapi.client_keys.changed', 'mapi-client-keys-payload.yaml'],
  ['mapi.fapi.client_assertion.accepted', 'mapi-kid-payload.yaml'],
  ['mapi.fapi.dpop.nonce.issued', 'mapi-purpose-payload.yaml'],
  ['mapi.fapi.par.pushed', empty],
  ['mapi.fapi.par.consumed', empty],
  ['mapi.fapi.signing_key.rotated', empty],
  ['mapi.fapi.access.validated', empty],
  ['mapi.fapi.token.exchanged', empty],
  ['mapi.fapi.code.reused', empty],
  ['mapi.fapi.login_started', empty],
  ['mapi.fapi.code_issued', empty],
  ['mapi.fapi.login_denied', empty],
  ['mapi.recovery.session_checks_invalidated', 'mapi-recovery-count-payload.yaml'],
  ['mapi.recovery.session_tokens_invalidated', 'mapi-recovery-count-payload.yaml'],
  ['mapi.recovery.orphan_tokens_invalidated', 'mapi-recovery-count-payload.yaml'],
  ['mapi.recovery.credential_invalidated', 'mapi-recovery-count-payload.yaml'],
  ['mapi.recovery.attempt_checks_invalidated', 'mapi-recovery-count-payload.yaml'],
  ['mapi.recovery.attempt_invalidated', 'mapi-recovery-count-payload.yaml'],
  ['mapi.recovery.completed', 'mapi-recovery-completed-payload.yaml'],
];

const str = { type: 'string' }, integer = { type: 'integer', format: 'int64' };
// The emitters can persist either nil slices (JSON null) or arrays.
const nullableStrings = { oneOf: [{ type: 'array', items: str }, { type: 'null' }] };
const object = (title, properties, required) => ({ title, type: 'object', properties, required, additionalProperties: false });
export const mapiPayloads = {
  'mapi-uri-payload.yaml': object('MaPiUriPayload', { uri: str }, ['uri']),
  'mapi-profile-payload.yaml': object('MaPiProfilePayload', { profile: str }, ['profile']),
  'mapi-resource-policy-payload.yaml': object('MaPiResourcePolicyPayload', { audience: str, scopes: nullableStrings, enabled: { type: 'boolean' }, version: integer }, ['audience', 'scopes', 'enabled', 'version']),
  'mapi-client-keys-payload.yaml': object('MaPiClientKeysPayload', { kids: nullableStrings }, ['kids']),
  'mapi-kid-payload.yaml': object('MaPiKidPayload', { kid: str }, ['kid']),
  'mapi-purpose-payload.yaml': object('MaPiPurposePayload', { purpose: str }, ['purpose']),
  'mapi-recovery-count-payload.yaml': object('MaPiRecoveryCountPayload', { recovery_id: str, count: integer }, ['recovery_id', 'count']),
  // Both the legacy and batched completion records have existed in local
  // state. Optional fields preserve each original shape through the encoder.
  'mapi-recovery-completed-payload.yaml': object('MaPiRecoveryCompletedPayload', { recovery_id: str, expired_handoffs: integer, invalidated_attempts: integer, invalidated_handoffs: integer, revoked_sessions: integer, revoked_credentials: integer }, ['revoked_sessions']),
};
