# Authentication expiry and frozen clocks

Status: **unresolved**. This note identifies the authority boundary that a fix
must cover. It does not authorize disabling authentication, changing the
expiry policy, or treating the existing 1 ms margin as a wall-time guarantee.
The user chose to keep this gate open while other Phase 1 work continues.

## Observed boundary

The production flow stack passes `time.Now` to the pinned Go flow state
machine in `upstream/overlay/apps/api/cmd/mapi-wasm/flow_enabled_wasip1.go`.
The split-password experiment rechecks the attempt after its asynchronous
verifier call and before the final synchronous transaction, but that
experiment remains unmounted. The existing local frozen-clock diagnostic
shows that the pinned Go `AuthAttempt.IsExpired` can still report an attempt
unexpired after a longer synchronous interval than its TTL when its clock is
held fixed. Its test clock is synthetic and its local timing is not a hosted
measurement. Details and the existing command are in
`upstream-split-password-proof.md`.

The affected paths are broader than the final credential response. In the
pinned source, `authAttemptService.IssueChallenge` writes challenge state;
`VerifyProof` can write user or credential state, a successful check and
audit; `Handoff` writes a handoff token and audit; and the session exchange
can promote checks into a session, delete the attempt and issue a token via
`session.RunExchange`, while `sessionService.Exchange` emits audit in its
transaction. Passkey registration also has a distinct, tighter challenge lifetime.
These are the boundaries a staged design must cover; a separate trusted time
reading after any of these commits does not reverse their effects.

Cloudflare documents that deployed Workers' `Date.now()` and
`performance.now()` advance after I/O, rather than during uninterrupted code
execution. It also documents no hard wall-time limit on a Durable Object RPC
or HTTP invocation while its caller remains connected. Neither a CPU limit nor
an observed latency percentile establishes a wall-time bound on the last
synchronous transaction, including scheduling pauses. See the [Performance
API](https://developers.cloudflare.com/workers/runtime-apis/performance/) and
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

Suppose an attempt expires at `E`, and its last observable time is `T < E`.
If execution can be delayed after that observation and before an externally
effective commit, the same local observation can precede a commit after `E`.
An I/O refresh, a signed timestamp obtained immediately before the transaction,
a timer callback, or a finite unverified safety margin does not by itself
exclude that case. This is a missing guarantee under the stated model; the
local diagnostic does not establish how long a deployed transaction actually
takes.

## Conditions for a real fix

One possible route is an independently justified and enforced upper bound on
elapsed wall time from the final trusted freshness observation through the
actual authority commit. The guard would have to include that bound and clock
uncertainty in its admission decision, reject when insufficient time remains,
and fail closed if the guarantee is unavailable. A measured p95, CPU budget,
or timeout that cannot preempt the synchronous transaction is not that bound.
Any bound must cover pauses as well as execution and be supported for the
deployed platform and every affected path.

Another possible route is to redesign the authority boundary around a
separate, independently time-validating receiver. A prepared result would
remain inaccessible until that receiver checks the actual expiry and accepts
the exact project, attempt, challenge, credential, route and recovery era.
The receiver's own freshness check and issuance/use boundary must have a
defensible timing guarantee. A check after the current Go transaction cannot
undo mutations already committed: authentication-success state, attempt
consumption, handoffs, sessions, and success audit could already have been
written after expiry. Such a design must either stage those effects as
non-authoritative until a valid release, or explicitly change and approve the
policy for those internal effects. It must not claim that post-checking a
returned credential alone proves expiry at the original commit.

Before enabling a replacement, trace and cover all expiry-sensitive flow,
session, handoff and challenge operations, including the passkey registration
challenge already identified in `phase1-status.md`. Test the real Go handlers
and their durable side effects with an expired attempt, a delay across the
last freshness observation, rollback, retry and concurrent use; verify that no
expired result becomes authoritative and that audit semantics match the
approved policy. Demonstrate the timing guarantee with independent hosted
evidence for the exact selected artifact. Keep Argon2 settings unchanged.

Until one of these designs is implemented and verified, the expiry gate remains
open. A policy that disables affected authentication paths can fail closed but
would also prevent the required hosted sign-in journeys; it is not implemented
as a substitute for the requested Phase 1 result.
