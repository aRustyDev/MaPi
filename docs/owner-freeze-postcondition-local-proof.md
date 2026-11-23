# Owner freeze postcondition: local proof

`freezeOwnerFence` acknowledges a new freeze only when its synchronous transaction reports exactly one logical update and the stored row still contains the expected project, origin, owner, generation, move ID, frozen state and empty digest. If the check fails, throwing inside the transaction rolls back the update and its trigger side effects. An identical retry of an already frozen owner remains unchanged.

`node scripts/test-owner-fence.mjs` passed in disposable local workerd with approved loopback access. Before the fix, a `BEFORE UPDATE` trigger using `RAISE(IGNORE)` caused the test to fail because the helper returned successfully while the row remained active. The passing test covers that case and an `AFTER UPDATE` trigger that restores the active state; it checks that both rejected calls leave fence, business and audit rows unchanged, then confirms active writes still succeed. It also covers normal freeze, identical retry, stale writes and eviction. Expected rejected calls produce workerd error traces.

The fault triggers require privileged changes to the owner schema. This narrow proof does not establish protection against arbitrary schema tampering, integrated relocation, registry moving-state behavior, real-owner moves, or hosted behavior. No Woven resources were changed.
