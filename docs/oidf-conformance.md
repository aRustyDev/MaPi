# Local OpenID Foundation conformance exploration

This is an experimental local test, not certification or evidence that the
OpenID Connect Basic OP profile passes. The issuer and the official suite run
on loopback. The suite uses ephemeral MongoDB storage, and its HTTPS ports bind
only to `127.0.0.1`; no public tunnel or staging deployment is used.

The official suite image tested was version 5.3.4, pinned to
`sha256:605026d2b54d17e64b55b3aa3911b394e3b6fff30d26c7ba7e9d50688cbe776a`.
The source inventory was checked at commit
`aa5f851eeebd108acb325dc80b54d58eaf018e23`. The Foundation describes its
[local Docker suite and CI runner](https://openid.net/certification/about-conformance-suite/)
and the [Basic OP test prerequisites](https://openid.net/certification/connect_op_testing/).

The selected plan was `oidcc-basic-certification-test-plan`, using static
server metadata and static client registration. The configured plan contained
35 modules. Static metadata keeps discovery disabled at the app ingress. Two
different confidential clients were registered, with the first also used for
the `client_secret_post` variant. The suite and issuer exchanged only synthetic
data. The local test trusts only the generated issuer certificate and the
suite's container certificate; Chromium is configured with those exact SPKI
pins. It is not a hosted TLS or Cloudflare limit test.

All 35 configured modules were attempted against the prebuilt experimental
issuer. The redacted [per-module results](oidf-basic-results.json) record the
run: **2 passed, 1 finished failed, 29 interrupted/failed, 1 skipped, and 2
remained waiting** when the harness stopped them after an HTTP 400. The 29
interrupted modules stopped at `CheckIfAuthorizationEndpointError`; their
individual target behaviors were not established. These are not 29 separate
proven protocol defects. Representative results:

| OIDF module | Result | Evidence |
| --- | --- | --- |
| `oidcc-ensure-request-with-valid-pkce-succeeds` | PASSED | Official component completed the upstream password flow and the suite verified the callback. |
| `oidcc-response-type-missing` | PASSED | The suite accepted the error response. |
| `oidcc-server` | INTERRUPTED / FAILED | `CheckIfAuthorizationEndpointError`: the valid authorization request was answered with `invalid_request`. The request did not include a PKCE challenge. |
| `oidcc-prompt-none-not-logged-in` | FINISHED / FAILED | The suite expected a UI-required error, but received `invalid_request` on a request that also omitted PKCE. |
| `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported` | SKIPPED | The suite skipped the module in this configuration. |
| `oidcc-ensure-registered-redirect-uri`, `oidcc-ensure-request-object-with-redirect-uri` | WAITING | The browser received HTTP 400 without a callback; the harness stopped each unfinished module. |

The issuer was subsequently changed to return `interaction_required` for an
otherwise-valid S256 request with `prompt=none`, without rendering UI; a native
test confirms missing PKCE still returns `invalid_request`. The official suite
results above were recorded **before** that focused change, and the suite's
no-PKCE request remains incompatible with the mandatory-PKCE policy.

The [Basic OP plan source](https://gitlab.com/openid/conformance-suite/-/blob/aa5f851eeebd108acb325dc80b54d58eaf018e23/src/main/java/net/openid/conformance/openid/OIDCCBasicTestPlan.java)
offers static/discovery metadata and static/dynamic registration variants; it
does not offer a variant adding PKCE to every request. Its common authorization
request omits PKCE, while its separate
[PKCE-positive module](https://gitlab.com/openid/conformance-suite/-/blob/aa5f851eeebd108acb325dc80b54d58eaf018e23/src/main/java/net/openid/conformance/openid/OIDCCEnsureRequestWithValidPkceSucceeds.java)
adds it. MaPi intentionally requires S256 for every authorization request.
Retain that requirement: the failing Basic module is a profile incompatibility,
not evidence that PKCE should be disabled. Other Basic modules and Config OP
discovery have not yet passed as a complete plan.

The official [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-security-profile-2_0-final.html)
requires S256 on every request, but is a different, stricter target. It also
requires authenticated pushed authorization requests, sender-constrained
access tokens using DPoP or mTLS, and mTLS or `private_key_jwt` client
authentication. MaPi currently lacks those capabilities and its refresh-token
rotation policy must be evaluated against the profile. A mandatory-PKCE
certification target therefore requires implementing and testing that complete
profile, not just selecting a different Basic-plan option. In addition, Basic
OP requests exercise optional OIDC scopes and parameters MaPi's narrow current
provider rejects; they must be implemented before claiming that broader
profile, even if a separate compatibility policy is eventually chosen.

For the smallest **separate** FAPI 2.0 authorization-server profile, use
`private_key_jwt` for client authentication and DPoP for sender-constrained
tokens. This avoids making Cloudflare edge mTLS a prerequisite, while preserving
the existing confidential bearer-token profile for other clients. Before
claiming the FAPI profile, the implementation must at least:

1. Register project-scoped client public keys and verify `private_key_jwt`
   signatures, exact issuer audience, expiry, permitted algorithms and
   replay-protected assertion IDs. Revalidate client state in the same
   transaction as authorization and token mutations.
2. Add client-authenticated PAR, reject ordinary non-PAR authorization requests
   on the FAPI issuer, require a redirect URI and S256 PKCE in PAR, and store
   expiring request handles with transactional binding and one-time use at
   authorization. Return the issuer identifier in the authorization response.
3. Validate DPoP proof signatures, HTTP method and target URI, times, unique
   proof IDs and authorization-code key binding. Issue access tokens carrying
   the public-key thumbprint and require a valid bound proof at every resource
   endpoint. Keep replay state authoritative per project, with bounded expiry.
4. Add at least one permitted JWT algorithm: the profile permits PS256,
   ES256 or EdDSA/Ed25519, while MaPi currently emits RS256. Publish the
   corresponding public keys and perform rollover without reusing key IDs.
5. Implement the FAPI refresh-token policy: ordinary rotation is prohibited;
   exceptional rotation needs the profile's retry/recovery behavior. Continue
   to enforce client/credential revocation and short code lifetimes.
6. Publish accurate metadata for this distinct issuer, enforce the required TLS
   and redirect protections, and run the **complete** official FAPI 2.0
   Security Profile authorization-server plan with the chosen `private_key_jwt`
   and DPoP variants. A local suite run does not establish hosted TLS, Workers
   CPU/memory, replay retention or recovery behavior.

The suite's `fapi2-security-profile-final-test-plan` currently offers the
target configuration `fapi_profile=plain_fapi`,
`authorization_request_type=simple`, `client_auth_type=private_key_jwt`,
`openid=openid_connect`, `sender_constrain=dpop`, and
`grant_management=disabled`. Its unfiltered catalog contains 69 modules;
variant selection may change the configured set. This is a target for future
testing, not a profile that has been run or passed.

An isolated, unmounted PAR endpoint and storage primitive now exist in
`upstream/overlay/apps/api/internal/mapioauth/par.go` and `par_http.go`.
Their native tests cover bounded lifetime, client/project/PKCE binding,
one-time consumption, callback replay, and transactional audit rollback.
The client assertion and DPoP verifier hooks are mandatory but are not yet
connected here. In particular, the verified DPoP thumbprint must propagate
through the login and authorization code into token redemption; a PAR handle
alone does not establish sender-constrained token security. The PAR endpoint
and FAPI profile remain unavailable on the Worker ingress.

To reproduce the configured plan from the project root:

```sh
npm ci
bash scripts/build-oidc.sh
node scripts/build-login-assets.mjs
docker compose -p mapi-oidf-local -f scripts/oidf-local.compose.yaml up -d
MAPI_OIDF_ALL=1 MAPI_OIDF_RESULTS=.mapi/oidf-results.json node scripts/test-oidf-local.mjs
docker compose -p mapi-oidf-local -f scripts/oidf-local.compose.yaml down
```

The test requires Docker, Node 24+, Go 1.26.9, OpenSSL, `rsync`, Playwright
Chromium, and loopback ports 8443 and 8444. The suite container must resolve
`host.docker.internal` to the host's loopback-bound workerd port; this was
verified on the local Docker runtime but may require runtime-specific setup on
Linux. `MAPI_OIDF_ALL=1` attempts every module in the configured plan;
interactive and multi-step modules may remain incomplete. Set
`MAPI_OIDF_RESULTS` to an ignored, local output path for a redacted summary.
Raw suite logs and its ephemeral database may contain synthetic credentials and
tokens; do not commit them.
