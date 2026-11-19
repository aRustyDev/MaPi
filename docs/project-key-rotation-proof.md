# Local project-key rotation proof

This is an isolated, test-only experiment. Pinned Nextgen supplies the project encryption-key service and the real SQLite and audit services. The RS256 bearer and ES256 FAPI issuer key rings themselves are MaPi extensions; the pinned native Nextgen server does not ship a working issuer. This probe is not a public rotation endpoint and is not deployed.

After `node scripts/baseline.mjs` and a populated pinned Go module cache, run:

```sh
GOPROXY=off GOMODCACHE=/private/tmp/zitadel-nextgen-poc/go-mod GOCACHE=/private/tmp/zitadel-nextgen-poc/go-cache node scripts/test-key-rotation.mjs
```

The test builds the pinned source and overlay in a temporary checkout, creates two independent local SQLite Durable Objects, provisions two real Nextgen projects, signs in synthetic users, and uses each project's real upstream key service to wrap the private issuer keys. Within each object, it initializes and rotates the bearer RS256 and private FAPI ES256 key rings, checks that the old and new tokens remain valid and both public keys are published, and injects an error **after the actual mutation audit write**. The failed rotation leaves the prior active key, key count and audit count unchanged. Synthetic tokens cross only between these local test objects; neither token, project credential, private key, password nor cookie is printed. The other project's bearer and FAPI ID tokens are rejected, while its own tokens remain valid, both before and after object eviction.

The test then directly deletes the retired public-key row as a fault injection and proves the old token is rejected while the token signed by the active key remains accepted. **That SQL deletion is not an implemented emergency revocation or retirement API.** Ordinary rotation intentionally keeps retired public keys available; it does not revoke their tokens. A supported key-retirement policy must address compromised keys, token expiry, cache propagation, signing-key audit, key distribution and a recovery procedure. Offline clients may continue accepting keys or tokens they cached before removal. The experiment does not revoke upstream project encryption keys or prove master-key rotation, backup/recovery or compromised-key response.

The accompanying native `-race` tests cover the native SQLite and Go key-ring tests, including rotation and failed-audit rollback; the upstream project key service is used by the native bearer administration test, whereas the native FAPI ring unit test uses its existing synthetic wrapping service. The FAPI test ring here uses the legacy private `/oauth` namespace for the key-service exercise; it does not establish the newer separate `/fapi` browser route or full OIDC conformance. The foreign-token checks are for the two newly provisioned test projects, not delegated access or cross-project ownership grants.

The local Wasm measured 55,959,681 bytes in one build. That is neither total Worker upload size nor hosted isolate memory, CPU, startup, latency, concurrent traffic or platform-limit evidence. The harness uses privileged test-only exports and an in-memory synthetic master key and must not be deployed. Production operator authorization, key-retention schedules, independent security review, migration and multi-project key recovery remain open.
