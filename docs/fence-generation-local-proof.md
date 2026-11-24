# Owner-fence generation boundary: local proof

`freezeOwnerFence` rejects a new freeze at `Number.MAX_SAFE_INTEGER`: there is no distinct, exactly representable JavaScript integer for the destination generation. The check occurs inside the synchronous transaction before changing the active fence. An identical retry of a fence already frozen by older code remains idempotent.

`node scripts/test-owner-fence.mjs` passed in disposable local workerd with loopback access. The focused cases verify that the largest movable source generation, `MAX_SAFE_INTEGER - 1`, freezes and can reserve a destination at `MAX_SAFE_INTEGER`; a freeze at the maximum is rejected without changing the fence, business rows, or audit rows, and the active owner can still write. An already-frozen maximum-generation legacy retry leaves the fence unchanged.

This proves the owner helper's local behavior only. It does not prove that registry preflight rejects generation exhaustion before marking a route moving, that a real or staged move completes, or that recovery is safe to reopen. No Woven deployment was changed.
