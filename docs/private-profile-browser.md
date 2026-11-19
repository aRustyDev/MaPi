# Private two-profile browser experiment

This local-only workerd test runs two distinct issuers over one authoritative Nextgen project and its sessions: the experimental rotating bearer issuer at `/oauth/<project>` and the FAPI issuer at `/fapi/<project>`. Each has its own signing-key and grant stores; the local profile registry admits each synthetic client to exactly one issuer. The FAPI login uses `/fapi/continue` and a separate `mapi_fapi` handle; the bearer login continues to use `/oauth/continue` and `mapi_oauth`. No public or staging route is enabled.

`node scripts/test-profiles-browser.mjs` builds the pinned tagged Go reactor in a temporary source checkout, starts a local HTTPS Worker and an independent loopback relying party, and runs both browser journeys through the pinned official login component. It verifies the FAPI consent and denial pages, session handling after object eviction, issuer-specific ES256 and RS256 ID-token signatures, authorization-code replay rejection and a DPoP-bound FAPI resource. It tests cross-profile client credentials, access tokens and browser continuation handles in both directions. Keys, test credentials, cookies and tokens remain in local temporary storage and memory.

A November 19 local run passed with a 56,327,623-byte Wasm module. `npx wrangler deploy --config scripts/profiles-browser-test.wrangler.jsonc --dry-run` reported 55,089.47 KiB uncompressed and 11,106.35 KiB gzipped for this **test Worker**, excluding any conclusion about hosted total isolate memory. That uncompressed result is approximately 1.20 MiB below the 55 MiB initial budget. It does not establish capacity, staging readiness or full conformance.

The official FAPI authorization-code replay module was also run locally against the distinct `/fapi/<project>` issuer. It finished **PASSED**: the issuer rejected code reuse and the suite's subsequent resource check rejected the previously issued access token. Its [redacted result](oidf-fapi-profile-code-replay.json) represents one selected module, not a complete profile run or certification. To reproduce after starting the local suite described in [the FAPI suite report](fapi-oidf-local.md):

```sh
MAPI_OIDF_MODULES=fapi2-security-profile-final-attempt-reuse-authorization-code-after-one-second \
  MAPI_OIDF_RESULTS=.mapi/profile-replay-result.json node scripts/test-profiles-oidf-local.mjs
```

The profile ownership registry, browser and discovery routes remain test-only. Woven deployment, real issuer-domain configuration, runtime headroom, operational recovery and the complete official suite on the distinct issuer remain outstanding.
