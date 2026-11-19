# Isolated deployment variable snapshots

This local-only test build adds the pinned generated `/variables` list, read, patch and delete handlers to the private [release/deployment adapter](release-deployment-parity-proof.md). It wires Nextgen's actual project-key and variable services. The extra test hook checks synthetic database contents locally; it is not production ingress and must not be deployed. `POST /releases/build` remains unmounted.

After `node scripts/fixture.mjs`, run:

```sh
node scripts/build-release-variables-test.mjs
node scripts/test-release-variables-parity.mjs
```

The test compares pinned native SQLite and local workerd. It patches a non-secret and a secret, checks that the secret is redacted by variable and deployment read APIs, and verifies that the stored secret and frozen `variable_sets` entries do not contain its synthetic plaintext. It also checks `variable.set` and `variable.removed` audit payloads do not contain the secret. It deploys a release with the first variable value, changes the live value, confirms the old deployment remains frozen, redeploys and observes the new value, and rolls back to the original frozen value. It verifies deletion does not alter the older snapshot and confirms the rolled-back snapshot survives object eviction. An injected local audit failure rolls back the multi-variable patch; native fault injection was not tested. The test prints no secret values or credentials.

The fixtures contain two native projects inside one Worker object. A foreign credential is rejected with native 404 `var.not_found` and workerd 401 `auth.unauthorized`; independent objects and delegated grants are not tested. Wrong-origin and CSRF behavior for an authorized administrator session, non-primary/preview variables, all value and patch forms, key rotation, raw audit envelopes, missing release references, concurrent variable changes during deployment, recovery, and hosted behavior remain open. A single local build produced 54,551,261 bytes of Wasm, not a hosted upload or total isolate-memory measurement. This test is not evidence to expose the routes.
