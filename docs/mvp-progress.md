# Experimental MVP status

This is an implementation checkpoint, not an MVP or parity release. The
existing Woven application has not been replaced by the experimental build.
The [parity inventory](parity-inventory.md) records the remaining surface.

## Local evidence

- `npm run test:worker` compares the existing password/session fixture with
  native Nextgen, including injected audit rollback and object restart.
- `npm run test:sqlite-bridge` exercises nested rollback, 64-bit values and
  SQLite binding limits in workerd. `npm run test:sql-bind` checks numbered
  parameters, including repeated and out-of-order use.
- `npm run test:official-login` exercises the official login component, a
  password failure, sign-in, reload, origin/CSRF rejection, logout and cookie
  replay. `npm run test:official-projects` adds two local origins and proves
  password and cookie isolation. Both need a locally running experimental MVP
  Worker, `MAPI_URL`, and `MAPI_OPERATOR_TOKEN`; they provision synthetic users.
- `npm run test:flow-throttle` checks that cross-origin submissions do not use
  the budget and that same-origin submissions are limited. Run it against an
  isolated local database in a fresh throttle window.
- `npm run test:system-parity` compares native and workerd liveness, readiness,
  and OpenAPI response behavior; readiness failures still need coverage.
- `npm run test:native-oidc` drives an independent relying-party test against
  the native Nextgen server and the experimental provider. `npm run test:oauth-composition`
  tests the upstream flow, signed ID token, replay and refresh handling in a
  private workerd harness. `npm run test:oauth-browser` drives the official
  component through a local HTTPS relying party, using a self-signed certificate
  and temporary synthetic credentials. A combined test run measured 55,464,797
  bytes of Wasm and 110,886,912 bytes of Wasm linear memory. These tests do not
  establish total isolate memory, hosted limits, or OIDC conformance.
- `npm run test:oidc-project-isolation` drives two local HTTPS project origins
  through the official component and an independent relying party. It verifies
  distinct issuers and signing keys, token and cookie isolation, wrong issuer
  and audience rejection, and isolated logout.
- `npm run test:relocation` tests a standalone, bounded relocation protocol.
  It is not wired to the application; see [the proof](relocation-proof.md).
- `npm run build:egress-spike` and `npm run test:egress-spike` exercise a
  durable pause and resume around synthetic local HTTPS discovery. Arbitrary
  IdP egress remains blocked by unresolved connected-IP validation; see
  [the egress proof](idp-egress-spike.md).
- The separate management experiment passes real workerd checks with two
  project objects. Its local namespaces are independent of the application
  deployment and do not administer that data; see [the management proof](management-read-proof.md).
- `npm run benchmark:flow` runs 20 synthetic flow journeys at concurrency four,
  plus one initial journey, against an initialized experimental Worker. On the
  local test run the sign-in p95 was approximately 1.54 seconds and final Wasm
  linear memory was 105,381,888 bytes. Linear memory cannot shrink, so this is
  the maximum Wasm memory reached in that run, not total isolate memory. An
  earlier run without collection after flow submissions reached 172,490,752
  bytes; the current reactor reclaims Go scratch allocations after each submit.
- The experimental flow-and-OAuth application dry-run upload was 54,302.10 KiB
  uncompressed. A local 20-journey browser/RP burst reached 173,801,472 bytes
  of Wasm linear memory before the validator-cache and collection changes. A
  fresh run after those changes and the row-count fix reached 106,168,320 bytes
  of Wasm linear memory and a 1.82-second journey p95. The hosted runtime gate remains open: total
  isolate memory, CPU and Cloudflare limit behavior have not been measured.

## Outstanding gates

The experimental OAuth package is mounted only in the opt-in local build, where
discovery remains unavailable. Its browser/RP, userinfo, revocation and logout
tests do not establish production readiness or conformance. Hosted provider and
session wiring, issuer metadata and the selected stricter profile remain open.
The project migration proof lacks integration,
large-project transfer and write-fence coverage for all mutation paths. Hosted
HTTPS isolation, startup, CPU, total isolate memory, bursts, recovery, and the
rest of the Nextgen server, Console, CLI and SDK parity remain unverified.

The user chose mandatory S256 PKCE. The official Basic OP suite expects some
authorization requests without PKCE and did not pass; a separate stricter
profile needs further protocol work. See [the conformance results](oidf-conformance.md).
