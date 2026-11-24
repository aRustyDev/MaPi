# Synthetic archive authority return checks

The unmounted synthetic archive advances sealing and verification through an
independent authority, with separate asynchronous reads of archive mode and
protection records. Previously an authority head could change after the last
head observation, during those later reads, and an operation could return its
old head as successful. A terminal-verification retry and a completed restore
had the same interval. A compliant immutable terminal head must not change, but
the implementation should not silently report success when an observed head
has changed.

Sealing and verification now reread their exact expected head after their final
mode/protection read. A failed or unavailable reread reports an uncertain
authority outcome and requires reconciliation: a prior create or CAS may have
committed. Restore rereads the verification head after its final protection
check before reporting either progress or completion. The target remains
private, and no return value authorizes activation.

The following distinct Node commands passed in the implementation checkout:

```sh
node scripts/test-synthetic-archive-readonly-authority.mjs
node scripts/test-synthetic-archive-bounded-sealing.mjs
node scripts/test-synthetic-relocation-archive.mjs
```

The read-only-authority test uses a deliberately rewindable in-memory fake to
change a verifier or sealer head during the relevant mode read. It covers an
already-complete verifier, an already-complete sealer, a verifier advance after
a committed CAS, and a restore with a completed private destination. Each
detects the changed head and fails; after restoring the appropriate fake head,
retry proceeds from the durable checkpoint, including the committed CAS head.
The fake rollback models corruption or privileged alteration, not an allowed
operation of the terminal authority. Existing lost-acknowledgement and archive
restore Node tests also passed.

An independent review found a further gap: `verifyProtection` and the
authorized-archive verifier read the sealing head, then await a final mode
read before returning. The read-only authority test injected a sealing-head
change during that mode read. Before the correction, the completed
verification case returned success and the test exited 1 with a missing
expected rejection. Both paths now reread the sealing head after the mode
read; the updated test passed for completed verification, completed restore
and the authorized-archive verifier. It also checked cancellation during the
final sealing-head read and an unchanged verification head afterward. The
other two Node commands above passed after the correction.

These checks do not make authority and archive reads atomic. A head can change
after the last read, or change and return to the same value between reads. They
do not establish independently administered nonrollback authority, archive
writer closure, protected retention, key custody, a real owner/importer,
Workerd integration, or hosted recovery. The separately interrupted combined
archive test and scale fixture were not read, run or polled. No Woven or AWS
resource was changed.

In particular, the sealing head can change while the caller subsequently reads
the separate verification authority, and the verification head can change
while the sealing authority is read. Alternating checks do not establish
simultaneous freshness. The protocol still depends on independently enforced
nonrollback and terminal immutability for both authorities; successful local
checks alone do not supply those properties or authorize activation.
