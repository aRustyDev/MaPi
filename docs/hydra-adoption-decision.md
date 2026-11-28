# Proposed Hydra bearer issuer decision

Status: Proposed, awaiting the decision owner. Decision owner: aRustyDev.

## Recommendation

Adopt Hydra OSS v26.2.0 at commit `0b84568fffccf151dc5e6c7955fdfb738555bf4b` for the Workers bearer issuer, retaining Nextgen as the first session authority. The hosted spike exercised actual Hydra transactions and ordered refresh release against session revocation. The comparison in [the Phase 0 evidence](hydra-phase-0-evidence.md) describes the remaining work and evidence limits for both issuer paths. No verified engineering-time saving is available.

The recommendation relies on accepting ownership of Hydra's patched transaction, OAuth handler, and runtime seams. The patch owner is **not yet assigned**. Before approving a go, assign an owner who accepts responsibility for watching Hydra and Go security advisories, reviewing upstream releases and backporting fixes, rebasing and reviewing patches, rebuilding the pinned artifact, and repeating transaction, revocation, isolation, conformance, and runtime qualification. Record the reviewers and any accepted evidence gaps in [#137](https://github.com/aRustyDev/MaPi/issues/137).

## Release conditions

An approved go permits implementation in [#132](https://github.com/aRustyDev/MaPi/issues/132). Delivery still requires production-grade session handling, grant-scoped revocation, independent two-project journeys, an agreed OIDC qualification route, issuer cutover and rollback rehearsal, and the hosted performance and recovery gates in [#128](https://github.com/aRustyDev/MaPi/issues/128). The measured 62.77 MiB uncompressed spike upload exceeds the 55 MiB per-Worker release target. Confirm the limit on the exact candidate, including its complete deployment graph. Resolve or explicitly disposition the unknown origin wire counts, canceled event labels, and historical timeout.

The owner must record the final decision and update the dependent issues. Production cutover is separately authorized. If the evidence or patch ownership does not support a go, retain the current issuer on the MVP path and keep Hydra delivery blocked.
