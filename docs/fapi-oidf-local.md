# Private FAPI 2.0 suite experiment

This local-only experiment is not certification and does not expose the FAPI routes on Woven. It combines the pinned upstream login component and password/session flow with the private PAR, login continuation, private_key_jwt, DPoP, ES256 token and protected-resource adapters. The test-only Worker provisions two synthetic clients with separate keys, durable client resource policies and a common `accounts` resource audience. The independent browser harness validates token signatures, nonce challenges, project routing, CSRF, one-time use and a resource proof, including an explicit object eviction. Its command is `node scripts/test-fapi-browser.mjs`.

The [OpenID Foundation's FAPI authorization-server suite](https://openid.net/certification/certification-fapi_op_testing/) is run locally using the image pinned in `scripts/oidf-local.compose.yaml`. The variant is FAPI 2.0 Security Profile Final, plain FAPI, simple authorization request, private_key_jwt, OpenID Connect, DPoP and grant management disabled. The local issuer uses a synthetic self-signed TLS certificate; this does not test hosted Cloudflare TLS, Workers limits or production deployment. Private client keys and credentials stay in the temporary suite database and memory, not in the redacted result files.

The corrected **v6 policy** run configured and attempted 53 modules: **38 passed, 4 skipped, 1 finished with warning, 6 remained waiting and 4 failed**. See [per-module redacted results](oidf-fapi-local-results.json). A previous run encountered a test-harness object eviction and returned discovery HTTP 503 for the last 28 modules; its [preserved results](oidf-fapi-initial-results.json) are not evidence of those 28 target behaviors. The corrected harness reconstructs the Go reactor after eviction and collects garbage after FAPI requests. The tagged v6 browser artifact was 56,134,392 bytes, before any real app upload measurement.

The v6 failure traces were:

- `plain-fapi-tolerate-unregistered-redirect-uri`: after a valid client assertion, PAR returned HTTP 400 `invalid_client`; the suite expects `invalid_request` or `invalid_request_object`. A later private patch distinguishes client authentication from redirect validation; it has not been included in the v6 result.
- `dpop-negative-tests`: the suite supplied a proof `htu` with query and fragment and expected those components ignored during URI comparison; the resource returned 401. The DPoP verifier fix remains to be validated.
- `par-ensure-reused-request-uri-prior-to-auth-completion-succeeds`: the suite attempted a second authorization before the first completed; the prototype atomically consumes the PAR URI on its first authorization. This is a deliberate single-use policy from the prototype plan and is being assessed separately against the profile.
- `ensure-pkce-code-verifier-required`: the suite omitted the token request's verifier and expected `invalid_grant`; the endpoint returned `invalid_request`. The planned error-mapping change retains mandatory S256 verification.

The six waiting modules were not counted as successes:

| Module suffix | Observed state |
| --- | --- |
| `user-rejects-authentication` | The suite reached `/login`; the prototype has no user-denial interaction, so the driver did not approve it. |
| `ensure-unsigned-authorization-request-without-using-par-fails` | The authorization endpoint returned HTTP 400 for the non-PAR request; the suite remained waiting for a protocol response. |
| `ensure-token-endpoint-fails-with-expired-auth-code` | The browser completed the initial login; the driver timed out before the expiry test finished. |
| `par-attempt-reuse-request_uri` | The initial login completed; the suite remained waiting for its later replay step. |
| `par-attempt-to-use-expired-request_uri` | The suite was still waiting before presenting a browser URL when the driver stopped it. |
| `par-attempt-to-use-request_uri-for-different-client` | The cross-client authorization request returned HTTP 400; the suite remained waiting for a protocol response. |

The warning was for authorization-code reuse after one second; the skipped modules covered identity claims, a non-alias token endpoint, an RS256 assertion variant and refresh-token behavior. The suite configuration did not request `offline_access`, so the skipped refresh case is not evidence of refresh-token parity. The driver does not implement every module's interactive instructions, and a waiting or interrupted test may need a purpose-built interaction rather than an endpoint change. Raw ephemeral suite logs can contain synthetic JWTs and credentials; only redacted summaries are committed.

Reproduce from the repository root with Docker, Node, Go 1.26.9, Playwright Chromium, OpenSSL and `rsync` installed:

```sh
npm ci
node scripts/build-login-assets.mjs
docker compose -p mapi-oidf-local -f scripts/oidf-local.compose.yaml up -d
MAPI_OIDF_ALL=1 MAPI_OIDF_RESULTS=.mapi/fapi-suite-results.json node scripts/test-fapi-oidf-local.mjs
docker compose -p mapi-oidf-local -f scripts/oidf-local.compose.yaml down
```

The suite uses loopback ports 8443/8444 and Docker must resolve `host.docker.internal`. The default driver attempts only discovery and happy flow; `MAPI_OIDF_ALL=1` selects all configured modules and writes progress after every module. Expiry and multi-interaction modules may need longer or tailored runs. No public FAPI discovery document or provider is enabled by this harness.

A later targeted run against the private v7 policy-generation fencing and URI/PKCE fixes attempted six modules with `openid accounts offline_access`: discovery, happy flow, unregistered-redirect handling and missing-PKCE-verifier handling **passed**; `dpop-negative-tests` finished **WARNING** with no failed conditions; and `refresh-token` **failed at PAR** before reaching refresh because its request used `prompt=consent`, which that build rejected. See [redacted targeted results](oidf-fapi-v7-targeted-results.json). The DPoP warnings were the suite's success expectations for proofs timestamped one hour in the future or past; the bounded proof-age policy rejected those requests. A real consent interaction is required before the refresh suite can test refresh behavior. This six-module rerun does not replace the full v6 run or establish a v7 full-plan result.
