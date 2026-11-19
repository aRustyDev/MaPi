# Private issuer-profile isolation experiment

`ComposeIsolatedProfiles` is an unmounted local experiment. A project has a rotating bearer issuer at `/oauth/<project>` and a FAPI issuer at `/fapi/<project>`. They have separate issuer identifiers, authentication methods, key rings and refresh/code tables. Both use the same authoritative Nextgen project and session database. An audited project/client membership table assigns each upstream application client exclusively to one profile; unassigned and cross-profile clients fail closed. FAPI resource policy and assertion-key registration apply only to FAPI members. Membership is immutable in this experiment, including after repeated initialization.

Run the native real-service test with:

```sh
GOCACHE=/private/tmp/mapi-isolated-go-cache node scripts/test-isolated-profiles.mjs
```

The test migrates an empty native database, creates real Nextgen project keys, applications and confidential-client secrets, and uses a synthetic verified Nextgen session. It exercises separate discovery metadata and signing keys, issuer-bound client assertions, signed access-token cross-rejection, client and policy isolation, audit failure rollback, and distinct refresh stores. The bearer refresh family rotates and is revoked on reuse; the private FAPI confidential-client refresh is reusable under its authenticated client policy. Direct store tests do not substitute for full HTTP exchanges or security review.

This experiment does not expose either discovery document. The `/fapi` authorization/browser continuation route is not implemented and no integrated browser or workerd isolation test is provided. It is not evidence of FAPI conformance, production readiness, or acceptable hosted CPU/memory. Existing experimental bearer and FAPI configurations remain separate and unchanged. A future deployment requires complete issuer routing, operator lifecycle, an independent security review, the relevant conformance suites and fresh full-stack runtime measurements. FAPI authorization-code replay family revocation remains a separate open issue.
