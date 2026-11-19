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
- `npm run test:relocation` tests a standalone, bounded relocation protocol.
  It is not wired to the application; see [the proof](relocation-proof.md).
- `npm run benchmark:flow` runs 20 synthetic flow journeys at concurrency four,
  plus one initial journey, against an initialized experimental Worker. On the
  local test run the sign-in p95 was approximately 1.54 seconds and final Wasm
  linear memory was 105,381,888 bytes. Linear memory cannot shrink, so this is
  the maximum Wasm memory reached in that run, not total isolate memory. An
  earlier run without collection after flow submissions reached 172,490,752
  bytes; the current reactor reclaims Go scratch allocations after each submit.
- The experimental staging configuration's dry-run upload was 52,628.13 KiB
  uncompressed. Recheck after each rebuild.

## Outstanding gates

The experimental OAuth package is not mounted or advertised. Production key and
session integration, issuer metadata, token signing, the independent relying
party journey, userinfo, revocation, logout, conformance and the full requested
OAuth profile remain incomplete. The project migration proof lacks integration,
large-project transfer and write-fence coverage for all mutation paths. Hosted
HTTPS isolation, startup, CPU, total isolate memory, bursts, recovery, and the
rest of the Nextgen server, Console, CLI and SDK parity remain unverified.
