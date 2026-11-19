# Private FAPI authorization-code reuse

The private FAPI exchange records a bounded-lifetime consumed-code tombstone and associates issued access and refresh grants with a family. A replay must first authenticate the same client, validate a fresh DPoP proof, and match the original redirect URI, PKCE verifier and any originally bound DPoP key. A qualifying replay revokes the family and writes the `mapi.fapi.code.reused` audit event in the same transaction, then returns `invalid_grant`. An audit failure rolls back revocation and replay records. Authoritative resource validation rejects both the original access token and access tokens issued through refresh; further refresh requests are rejected. Signature-only offline validation cannot see this revocation.

Schema version 9 adds family and refresh-family tables. Tokens issued before this migration have no family binding, so this change cannot retrospectively revoke their families. Before any future deployment using an existing private FAPI database, invalidate outstanding sessions and refresh tokens and rotate or retire the prior signing keys, then verify recovery and upgrade procedures. This implementation is unmounted and not production-ready; full conformance, independent review and hosted resource measurements remain gates.

The native real-service test and the local workerd real-password session probe exercise replay, failed-audit rollback, first-access rejection and refresh rejection; the native test also checks refreshed-access rejection and an incorrect PKCE verifier. Run:

```sh
GOCACHE=/private/tmp/mapi-isolated-go-cache node scripts/test-native-fapi.mjs
GOCACHE=/private/tmp/mapi-isolated-go-cache node scripts/test-fapi-app.mjs
```

The workerd test requires loopback access. It reports Wasm linear memory, not total hosted isolate memory or CPU.
