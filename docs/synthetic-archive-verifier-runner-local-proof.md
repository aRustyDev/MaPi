# Synthetic configured archive verification runner

This is an **unmounted synthetic-only** experiment. It is not the requested
registry cutover gate, a production archive service, or evidence of independent
custody. No Woven or AWS resource was changed.

`worker/synthetic-archive-verifier-runner.js` advances the existing bounded
verification protocol using a privileged fixed scope, commitment, envelope
digest, sealing job and verification job. It reads the current heads itself
and does not accept a caller-supplied head, checkpoint or step size. It checks
cancellation and replaces failures from its two authority reads with fixed
errors; it never races an authority write against cancellation. A lost create
or CAS acknowledgement is resolved by the existing protocol's authoritative
readback. The configuration and read heads are detached before later awaits.

The new named `SyntheticArchiveVerifier` entrypoint in the synthetic gateway
uses the gateway's pinned, canonical policy and scoped authority wrappers. It
does not expose raw create or compare-and-swap methods. This is a capability
boundary only if the underlying mutable authority entrypoint, its Durable
Object namespace, bucket write capability, key access and policy configuration
are restricted separately. The same gateway module still exports raw authority
entrypoints; code alone does not prevent an administrator from binding them.

## Local checks

- `node scripts/test-synthetic-archive-verifier-runner.mjs` passed using two
  small synthetic encrypted chunks, an in-memory bucket, fake KMS and fake
  authorities. It exercises the actual archive verification functions,
  incomplete sealing denial, source-identity mismatch, copied configuration,
  cancellation, sanitized authority read errors and committed-but-lost
  create/CAS acknowledgements. It does not invoke an importer or restore a
  project.
- `node scripts/test-synthetic-archive-gateway.mjs` passed in disposable local
  Workerd after scoped approval to open its loopback listener. An earlier
  sandboxed invocation exited `EPERM` before assertions. The named runner
  entrypoint was denied raw authority writes and could not advance without a
  sealing head. This gateway fixture has no archive bucket or KMS binding and
  does **not** demonstrate a successful runner invocation through RPC.

The SHA-256 values at the time of those tests were:

- `worker/synthetic-archive-verifier-runner.js`: `c1c8d359db09de8f3259b342af60df07be613b1fc7e083f06636f808a04d5389`.
- `worker/synthetic-archive-gateway.js`: `231aa73366ce30ec5776126f655e538597aedfefd6821c1c7c55cc8fa91909d2`.
- `scripts/test-synthetic-archive-verifier-runner.mjs`: `f36c4c24ed76e54ce0e9b6c7e05c3c5f126970df431a025bd4a1e8f5c170b955`.
- `scripts/test-synthetic-archive-gateway.mjs`: `611e0e2420c075686e9ef6a99b13a82b2276be5e5e29994721ab7e3ae6002dbf`.

## Initial authority-read cancellation

The runner now stops waiting for either initial authority read when its caller
aborts the supplied signal; late results and failures are consumed without
continuing the canceled call. The focused native test
`node --unhandled-rejections=strict scripts/test-archive-verifier-read-cancel.mjs`
passed for stalled sealing and verification reads, each followed by a late
success and a late failure. The existing native
`node --unhandled-rejections=strict scripts/test-synthetic-archive-verifier-runner.mjs`
also passed after the change. Neither test invokes Workerd, AWS or Woven.

The changed runner SHA-256 is `607d87bd599a70a5505c0b60f2997684d6f5895a3a8d0a361b48e77286ff9d5f`;
the focused test SHA-256 is `f82e4a2b316d3e7c0c7c437dce1836b3f97885e3b04c0dd224d69fb1e78b6e68`.
The caller must abort the signal: the runner imposes no deadline, and abort
does not revoke an already-dispatched RPC.

The underlying synthetic sealing, verification and restore protocol now also
abandons authority reads on cancellation. In the native runner test, a stalled
pre-create sealing read was canceled without creating a job. A separate stalled
readback after a committed create returned an uncertain outcome; the test then
read the persisted head and resumed sealing. Late rejected reads did not cause
unhandled rejections. The calls that mutate an authority are still awaited and
can hang: cancellation cannot establish whether a mutation committed. No
automatic deadline or RPC revocation is provided, and destination reads and
other operations have not all been shown cancellation-bounded.

`node --unhandled-rejections=strict scripts/test-synthetic-archive-verifier-runner.mjs`
and `node --unhandled-rejections=strict scripts/test-synthetic-archive-bounded-sealing.mjs`
passed locally. The protocol source SHA-256 is
`ddb89cca86c61cc4c782bb8f0a288e9fcf2c4dfeb78c5df9a6699762416d93e0` and the
runner test SHA-256 is
`0fe8ac2b747ddc3f8a416039d7e54abe2c60145c72931798fdc7a33907d5043b`.
These checks use local synthetic authorities, and neither establish Workerd nor
independent recovery or a registry cutover gate.

## Remaining boundaries

The selected source commitment is supplied by configuration rather than
obtained from an independently authenticated frozen source. A terminal head
and archive contents require independently enforced nonrollback, immutable
storage, writer closure and retention throughout verification and restore.
The existing synthetic KMS key is encryption-only, and its writer and recovery
roles share an administrator. This test proves neither independent custody nor
effective role separation, and it does not produce a valid cutover grant.

The gateway entrypoint uses a non-aborted local signal; gateway cancellation and
bounded completion of stalled authority or KMS reads remain unproven. There is no
successful gateway-to-R2/KMS run, real owner/importer, representative-scale
archive, independent recovery, hosted rehearsal or direct registry enforcement
here. The separately interrupted combined Workerd archive test, scale fixture
and registry/history actions were not rerun or reconstructed.
