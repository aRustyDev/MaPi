# Isolated DPoP verification foundation

`internal/mapidpop` is an unmounted Go verification core for the selected FAPI 2.0 path. It uses the pinned `go-jose/v4` dependency and supports ES256 with P-256, PS256 with RSA keys of 2048–8192 bits, and EdDSA with Ed25519. It accepts one bounded compact JWS with a public JWK and `typ: dpop+jwt`, checks the signature, rejects private/symmetric keys and remote key references, and rejects duplicate JSON object members. It validates the exact HTTP method, an HTTPS `htu` with syntax- and scheme-based normalization, bounded `iat`, a required caller-supplied nonce, an optional access-token `ath`, and the public-key thumbprint. A protected-resource check with an access token must also supply the expected token-bound thumbprint.

The replay table keys records by project, JWK thumbprint and a SHA-256 digest of `jti`. Verification must execute **inside the same owning SQLite transaction as the protected mutation**; `SQLReplay` does not open a nested transaction. It uses `INSERT ... ON CONFLICT DO NOTHING RETURNING project_id` and tests for `sql.ErrNoRows`. Durable Object SQLite `rowsWritten` can count index writes, so `RowsAffected() == 1` is not a reliable test for one logical inserted row. Each verification deletes its own expired exact key and opportunistically cleans at most 100 expired records from the same project using an expiry index. This bounds individual cleanup work; sustained abuse controls and separate cleanup still need validation. Upstream client authentication remains an independent check.

Native Go tests cover these three algorithms, URI normalization, nonce and freshness boundaries, private/symmetric keys, signature tampering, replay rollback, project scoping, `ath`, and key binding. The local workerd test uses the real Go/Wasm-to-SQLite bridge with ES256: it injects a failure after proof admission and confirms replay and session changes roll back together, sends ten concurrent uses of one proof and gets exactly one success, tests project isolation, evicts the object and confirms the replay is still rejected. Nonce tests additionally cover issue/audit rollback, hashed storage, project/client/purpose isolation, expiry and bounded cleanup; workerd verifies issue rollback and persistence across eviction. PS256 and Ed25519 have not yet been exercised under workerd or hosted load.

After `npm ci` and `bash scripts/build.sh` prepare the pinned source:

```sh
node scripts/build-dpop-spike.mjs
(cd .mapi/nextgen/apps/api && GOWORK=off GOTOOLCHAIN=go1.26.9 go test ./internal/mapidpop)
node scripts/test-dpop-spike.mjs
```

The standalone test Wasm measured 7,258,200 bytes; its test-only Worker dry run was 7,097.26 KiB uncompressed / 1,948.32 KiB gzip. This is not the combined issuer size or a hosted runtime, CPU, latency or memory result. The test Worker has local-only test routes and must not be deployed.

## Integration requirements and limits

- The separate `NonceStore` issues random 256-bit nonces, stores only their hashes, and scopes each to an authenticated project, client and purpose (`par`, `token`, or `resource`). Issuance and its required audit callback commit in one transaction; resolution checks scope and expiry inside the caller’s transaction. The verifier must then validate the proof signature and nonce before accepting it. Nonces remain reusable until expiry while `jti` replay protection prevents proof reuse. HTTP delivery, `DPoP-Nonce` challenges, `use_dpop_nonce` responses, rate limits and production issuance policies are not wired; do not pass a fixed test nonce in a real endpoint.
- The caller must derive method and external URL from trusted routing configuration, not untrusted forwarded headers, and must reject multiple DPoP header fields before flattening them. The `htu` claim excludes query and fragment; the request URL may include them and they are ignored for comparison.
- PAR may accept a `dpop_jkt` without a proof under RFC 9449. If both appear, the caller must compare them; this verifier checks a supplied `ExpectedThumbprint`. PAR's unmounted hook is responsible for the proofless case and must call verification in its existing transaction.
- Authorization-code storage and redemption must preserve and require any bound JWK thumbprint, and token issuance must bind the access token's `cnf.jkt`. Resource endpoints must verify both `ath` and that token's authoritative `cnf.jkt`, alongside normal token validity, audience, expiry, scopes and revocation. These operations are not implemented by this proof.
- Replay records must remain authoritative across object migration, recovery and backup restore. A restore that discards recently used `jti` records must invalidate affected tokens/nonces before reopening traffic or otherwise prevent replay. Bound replay retention, cleanup cost and abuse controls require production testing.
- Native/workerd coverage here is a focused local test, not an RFC/FAPI conformance suite, full interoperability assessment, or hosted load test. Key rotation, multiple issuer origins, delegations, token lifecycles, nonce races and client assertion interactions remain to be tested. No public routes are mounted and no DPoP/FAPI compliance claim follows from this foundation.

References: [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449), [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-security-profile-2_0-final.html).
