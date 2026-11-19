# Private upstream SSO callback state bridge

`internal/mapiidpbridge` is an unmounted native proof that invokes pinned Nextgen `FlowSSOCallback.Process` across synchronous steps. The first step consumes a browser-bound upstream SSO state exactly once. When Nextgen attempts outbound HTTP, the transport returns a bounded intent to the trusted host; on each subsequent step it replays only previously supplied responses and suppresses the temporary upstream failure park caused by the missing network response. After the final response, the original Nextgen callback service writes its result and mutation audit through the upstream `AuthAttemptService` transaction. A known egress failure can instead call `Abort` to write the upstream generic failure and audit.

Run the native suite with:

```sh
GOCACHE=/private/tmp/mapi-isolated-go-cache node scripts/test-native-idp-bridge.mjs
```

The tests include a migrated native SQLite database and real auth-attempt service, encrypted PKCE state, a real signed ID token and synthetic provider responses. They cover browser binding, ten concurrent state-consumption attempts, expiry and supersession, actual `FlowSSOCallback.Process` across discovery, token, JWKS and userinfo, a single authoritative callback result and audit event, injected audit failure rollback, and a fail-closed abort that records the upstream failure event once. Connection, variable and key-service lookup dependencies in the callback integration are synthetic; the separate state lifecycle uses real SQLite storage and AES-GCM.

The bridge holds the consumed check and transcript in Go memory for the lifetime of one callback. Its HTTP client never dials: the trusted host must enforce the pinned egress policy, destination and DNS-rebinding protections, TLS, strict response limits, redirect policy and deadlines for every intent. It must hold this state in one isolated reactor across asynchronous fetches, never serialize it to a browser, and prevent concurrent or stale resumption. A lost reactor or ambiguous token POST must not be retried using the same provider code. Go strings and transient copies cannot be reliably zeroed. The existing local workerd egress spike proves a similar intent/replay boundary with a synthetic callback-state table; it does not yet connect this bridge to workerd or prove authoritative Nextgen state and Worker egress in one journey. Production cleanup/recovery, arbitrary provider DNS safety, real provider integration, resource measurements and security review remain open.
