# Experimental OIDC issuer

The issuer is an opt-in prototype. Its Go/Wasm entry point is built only with
`mapi_oauth`; the default Worker does not route requests to it. The isolated
workerd and native relying-party tests are development evidence, not an OIDC
conformance certification or a deployment authorization.

Build and run the isolated local Worker test from a prepared checkout:

```sh
npm ci
npm run build
npm run baseline
node scripts/test-oauth-composition.mjs
```

The test builds with `mapi_flow,mapi_oauth`, binds an isolated SQLite Durable
Object, provisions a synthetic project and password user, and drives the pinned
Nextgen flow engine through a browser-bound continuation. It checks discovery,
PKCE code exchange, signed tokens, userinfo, refresh rotation, reuse, access
and refresh revocation, an RP logout confirmation, committed audit records,
rollback on injected audit failure, schema upgrade, and the SQL read/DDL cursor
regression. It prints Wasm artifact size, linear memory, and total journey time;
these are local single-run measurements, not CPU or total isolate peak memory.
The upstream test checkout and baseline are prepared by `npm run build` and the
existing fixture/build workflow; this test needs a local loopback listener.

The private reactor exports `mapi_oauth_admin` and `mapi_oauth_request`. The
former initializes the project-scoped schema and encrypted signing key,
registers clients and their explicitly authorized post-logout URIs, and rotates
keys. It returns newly generated client secrets only once. The calling Worker
must authenticate operator actions, validate its authoritative project/origin
route, protect returned credentials, and set proper ingress limits. The request
export enforces the stored project and origin and accepts only its explicit
issuer paths. The separate local app build mounts the implemented endpoints
behind an opt-in flag; the default app does not mount them, and the local app
does not expose discovery.

Supported discovery metadata describes confidential clients using authorization
code and S256 PKCE, `openid` and optional `offline_access`, RS256 tokens, JWKS,
userinfo, rotating refresh tokens, revocation, and RP-initiated logout. Logout
requires an unexpired signed ID-token hint bound to the current browser session,
a registered exact post-logout URI if one is supplied, and an interactive,
same-origin CSRF-protected confirmation. Other scopes, grants, public clients,
claims, or logout modes are not supported. Discovery remains private until the
advertised behavior passes protocol conformance, security review, browser tests,
and hosted multi-project runtime gates.

The issuer stores only a hash of a revoked access token. Its userinfo handler
and `TokenIssuer.ValidateAccess` check this record and the authoritative
Nextgen session, so revocation and logout immediately reject a subsequent
server-side check. An independent relying party that validates a JWT entirely
offline cannot see a revocation before that JWT expires; applications requiring
immediate rejection must use an authoritative check. Revoking a refresh family
also prevents its future rotation, but does not invalidate access JWTs already
issued from it. Retired public keys are retained for validating existing tokens;
a production retention and emergency key-removal policy is still required.

This prototype has not passed the OpenID Foundation conformance suite or hosted
load testing. The official component and operator ingress have passed local
browser tests, but per-project issuer isolation under load, session recovery and
backup semantics, key retention, consent, profile claims, and all remaining
Nextgen parity work are separate release gates.

For the **local opt-in app**, build the tagged reactor and select the separate
local configuration. Set `MAPI_APP_ORIGIN` to the exact browser-trusted HTTPS
origin serving that app; the development default of plain HTTP is not an OIDC
issuer. Keep the master-key backup and key ID made during app setup. The OIDC
signing keys are encrypted under that key chain, so their database alone cannot
restore them.

```sh
bash scripts/build-oidc.sh
npx wrangler dev --local --config wrangler.oidc-local.jsonc --env-file .dev.vars.app
```

Set `MAPI_URL` to the exact configured HTTPS project origin and set `MAPI_OPERATOR_TOKEN`
from the existing private local secrets file. Create the project first with
`mapi admin init --name "Example"`, then initialize its issuer and submit an
application document. The CLI writes the new client secret to stdout only on
creation; capture it in an appropriate secret manager and do not put it in the
application JSON or source control.

```sh
mapi admin oidc init
mapi admin oidc client add --file application.json
mapi admin oidc logout-uri add --client-id CLIENT_ID --uri https://app.example/logout-complete
mapi admin oidc client-secret rotate --client-id CLIENT_ID
mapi admin oidc client-secret revoke --client-id CLIENT_ID
mapi admin oidc rotate
```

The application document uses the pinned Nextgen format, for example:

```json
{
  "slug": "example",
  "name": "Example",
  "clients": [{
    "slug": "web",
    "client_id": "example-web@project",
    "type": "confidential",
    "grant_types": ["authorization_code", "refresh_token"],
    "redirect_uris": ["https://app.example/callback"]
  }]
}
```

`--file -` reads the document from stdin. A post-logout URI has a separate
explicit registration because the pinned Nextgen application schema does not
contain that setting. `rotate` creates an audited signing key and keeps retired
public keys available; it does not replace the deployment master key.

If a registration or client-secret rotation response is lost after commit, the
plaintext secret cannot be recovered. Use `client-secret rotate` with that
client ID to replace all its credentials and receive a new one-time secret. A
compromised credential can instead be disabled with `client-secret revoke`;
rotate again to re-enable the client. Each operation writes an audit record and
invalidates that client's pending authorization codes, refresh tokens, and
previous access tokens at authoritative checks. Relying parties validating
access JWTs entirely offline still cannot see that invalidation before expiry.
Changing credentials therefore needs coordinated relying-party rollout and can
interrupt clients that still use the previous secret. Choose and record a unique explicit `client_id` before registration (do not use
the reserved `client_` or `dcr_` prefixes), so it remains known even if the
response is lost. If Nextgen generated the ID and the response was lost, the
operator must obtain it from trusted project records; this prototype does not
yet provide a client-listing command. Retrying the same application document
does not redisplay the original secret.

The two-project isolation test builds the tagged app and uses two local HTTPS
origins, two project Durable Objects, the official login component and a
separate HTTPS relying party:

```sh
node scripts/test-oidc-project-isolation.mjs
```

It creates the same email with different passwords, checks separate issuers,
signing keys and user IDs, and verifies rejection of wrong issuer, audience,
signature, bearer token, client credential and replayed session cookie. It
also registers the same client ID in both projects and verifies their secrets
are scoped independently. Logging out of one project must leave the other
project's session active. The test generates a temporary local certificate;
Node trusts only that certificate and Chromium pins its public key. All test
services are loopback-only. Per-project Wasm linear memory is printed, but this
is not a measurement of total isolate memory or hosted Cloudflare behavior.

The opt-in operator can publish a changed existing project-wide login flow and
roll back to an earlier primary deployment. Start with a pinned Nextgen flow
definition, such as `.mapi/nextgen/packages/config/defaults/default-login.json`,
and keep its `name` equal to the login flow listed by status. The referenced
user schema must already exist. The definition includes all steps and purposes
for that flow; the other release pointers are preserved.

```sh
mapi admin oidc flow status
mapi admin oidc flow publish --file login-flow.json --expected-deployment CURRENT_DEPLOYMENT_ID
mapi admin oidc flow rollback --target-deployment PREVIOUS_DEPLOYMENT_ID --expected-deployment CURRENT_DEPLOYMENT_ID
```

Both writes require the current deployment ID as an optimistic concurrency
guard. Read status again after a conflict; the publish response also returns the
previous and new deployment IDs. Publication and rollback use the pinned
Nextgen services, verify the configured primary project origin, and commit their
mutations and audit records together. Audit identifies the shared
`mapi_operator` service credential, not an individual operator. This workflow
is available only in the opt-in app configuration and does not deploy code or
change staging.

Run the isolated tests after preparing the pinned checkout:

```sh
node scripts/test-native-flow-release.mjs
node scripts/test-flow-release.mjs
node scripts/test-flow-release-app.mjs
```

The last test drives the actual operator CLI and local Worker: publishing changes
the live first step, rollback restores it, and invalid input, stale deployment
IDs and an injected audit failure leave no partial update. These local tests do
not establish hosted load, browser accessibility, or release conformance.

## Private FAPI client assertion foundation

`ClientAssertions` is an unmounted integration foundation; it does not
change the existing confidential-client bearer profile or make the issuer FAPI
conformant. Its public keys are explicitly registered per project and client,
and a client may overlap active keys during rollover. Each key must have a stable
`kid` and an explicit supported `alg`; `use` may be absent or `sig`. Retired key IDs cannot be
reused or reactivated. This foundation does not fetch remote JWKS URLs.

It accepts PS256 with RSA keys of 2048–8192 bits, ES256/P-256, and EdDSA
with Ed25519. Assertions must have matching client `iss` and `sub`, and a
single **string** `aud` exactly equal to the project issuer. `jti` and `exp`
are required; `iat` is optional. The current private policy permits at most a
five-minute assertion lifetime and ten seconds of future clock skew. Duplicate
JSON members, embedded key references, unsupported algorithms, and replayed
JTIs are rejected. The JTI hash, the authentication audit event, and the
caller’s PAR or token mutation must share the same authoritative transaction.
The replay record is retained until assertion expiry. The five-minute cap and RSA upper bound are local policy choices, not claims
that FAPI requires those exact limits.

These checks follow the final [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-security-profile-2_0-final.html)
and [OpenID Connect client-authentication requirements](https://openid.net/specs/openid-connect-core-1_0.html#ClientAuthentication).
FAPI also requires sender-constrained access tokens and further protocol and
operational controls. The existing JWT bearer tokens and their refresh behavior
must not be presented as a FAPI profile.

After preparing the pinned checkout and baseline, exercise the private
foundation with:

```sh
cd .mapi/nextgen/apps/api
GOWORK=off go test -race -tags=mapi_native_e2e ./internal/mapioauth ./internal/mapidpop
cd ../../../..
node scripts/test-client-assertions.mjs
```

The latter uses a **test-only** `mapi_assertion_test` Wasm build and isolated
Durable Object. It exercises all three signature algorithms, rollover, replay
and transactional audit rollback. It does not expose an endpoint or deploy to
Cloudflare staging.

`NewPrivatePAR` composes the private assertion verifier, upstream application
registry, PAR store and DPoP proof verifier inside one project transaction.
The local integration tests exercise a real upstream client, an invalid-proof
rollback followed by a valid retry, replay rejection for both credentials,
atomic PAR consumption and preservation of the DPoP thumbprint. The test-only
probe uses a server-issued nonce scoped to the project, authenticated client,
and PAR purpose. A separate, unmounted grant store preserves optional PAR
code binding and requires a verified DPoP proof for code exchange and refresh.
For these confidential clients, the refresh grant is bound to authenticated
client identity and policy generation; a refresh may use a new DPoP key, and
the resulting access token is bound to that newly verified key.
`FAPIExchange` composes assertion and token-purpose nonce verification with a
fresh DPoP proof, grant consumption, and required transactional session, mint
and audit callbacks. Local composition tests use synthetic session and mint
callbacks. The separate `ComposePrivateFAPI` binds that exchange to Nextgen's
transaction-scoped session and client reads, encrypted project key service and
audit emitter. Code exchange signs an ES256 ID token containing the session,
authentication time, optional request nonce and access-token hash; refresh
responses omit it. Refresh requests may request an equal or narrower scope,
without changing or rotating the original refresh grant. Its experimental ES256
access token has a `cnf.jkt`, and its
resource validator checks issuer, audience, session, client, DPoP key and
`ath` together with a server-issued resource nonce. A private revoker stores
project-scoped token hashes and commits authenticated client revocation
with its audit record. Its unmounted RFC 7009 adapter accepts access and refresh
token revocation without a DPoP header; if a proof is provided it validates the
nonce and replay without requiring `ath`; for an access-token target, it also
checks the token's sender key. Resource use and refresh redemption still require
DPoP.
The isolated native and
workerd tests seed synthetic session records and exercise real session reads;
they do not represent a complete browser login or a hosted measurement. The
ES256 key ring is separate from bearer keys and retains old public keys on
rotation. Resource routes use `AuthorizeResource` with a trusted audience, allowed-client
set and required scopes. Each project stores a versioned policy per client;
`Policies.Put` performs an audited compare-and-set update and fails closed for
missing or disabled policy. PAR, token issuance and resource validation read
that durable policy in their authoritative transaction. Private schema v7 binds PAR,
pending login, authorization codes, access tokens and refresh tokens to the
policy version at authorization. Any policy update invalidates those existing
artifacts, including after a disable/regrant. Older pre-v7 artifacts lack the
binding and fail closed; clients must authenticate again after upgrading. ID
tokens are validated against the live session and client separately. Private schema v8 also requires
persisted prompt state and a browser-bound reload mapping; pre-v8 pending PAR
and login transactions fail closed. An authenticated
operator interface for policy management is not implemented. `ValidateResource`
validates identity and proof only and must not be treated as authorization.
The private HTTP adapters are unmounted. Public ingress, an operator policy interface, key retirement, a
full-stack hosted memory and CPU gate, and
full protocol conformance remain unimplemented or unverified, so this is not an
advertised FAPI profile.

The private FAPI profile intentionally keeps refresh tokens non-rotating, as
required by FAPI 2.0 for ordinary use. The separate experimental bearer issuer
retains rotation and reuse detection, as required by the MVP roadmap. Separate
issuer/profile routing and conformance review remain a blocker before deployment;
this FAPI experiment does not replace the requested rotating bearer default.
