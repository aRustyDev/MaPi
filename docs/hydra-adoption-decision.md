# Hydra bearer issuer decision

Status: Accepted on 2026-11-28. Decision owner and patch owner: aRustyDev.

## Decision

Adopt Hydra OSS v26.2.0 at commit `0b84568fffccf151dc5e6c7955fdfb738555bf4b` for the Workers bearer issuer, retaining Nextgen as the first session authority. The hosted spike exercised actual Hydra transactions and ordered refresh release against session revocation. The comparison in [the Phase 0 evidence](hydra-phase-0-evidence.md) describes the remaining work and evidence limits for both issuer paths. No verified engineering-time saving is available.

The decision accepts ownership of Hydra's patched transaction, OAuth handler, and runtime seams. aRustyDev owns watching Hydra and Go security advisories, reviewing upstream releases and backporting fixes, rebasing and reviewing patches, rebuilding the pinned artifact, and repeating transaction, revocation, isolation, conformance, and runtime qualification. The recorded go and owner confirmation are in [#137](https://github.com/aRustyDev/MaPi/issues/137).

## Release conditions

The go permits implementation in [#132](https://github.com/aRustyDev/MaPi/issues/132). Delivery still requires production-grade session handling, grant-scoped revocation, independent two-project journeys, an agreed OIDC qualification route, issuer cutover and rollback rehearsal, and the hosted performance and recovery gates in [#128](https://github.com/aRustyDev/MaPi/issues/128). The measured 62.77 MiB uncompressed spike upload exceeds the 55 MiB per-Worker release target. Confirm the limit on the exact candidate, including its complete deployment graph. Carry unknown origin wire counts, canceled event labels, historical timeout, and observed local startup failures into release qualification for investigation or explicit disposition.

Production cutover requires separate authorization.
