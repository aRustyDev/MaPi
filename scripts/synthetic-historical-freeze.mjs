// Test-only fixture for transfers whose source was frozen by an older version.
// Production admission refuses a new freeze until independent archive proof is
// available. Never import this module from a production Worker.
import { initializeOwnerFence, freezeOwnerFence } from '../worker/owner-fence.js';
import { readTextPreflightMarker, writeTextPreflightSeal } from '../worker/relocation-text-marker.js';
import { validateRelocationSourceSchema } from '../worker/relocation-manifest.js';

export async function syntheticHistoricalFreeze(owner, callProduction, route, moveId, marker) {
  if (owner.env.MAPI_LOCAL_TEST !== '1' && !owner.env.MAPI_STAGING_PROOF_TOKEN) throw Error('Synthetic freeze fixture is not enabled');
  try {
    return await callProduction();
  } catch (error) {
    if (!String(error).includes('Relocation admission unavailable: independent archive proof is not configured')) throw error;
  }
  // Recheck the marker in the same transaction as the fixture's historical
  // fence. A write between the rejected request and this fixture cannot be
  // silently frozen as if it were covered by the previous preflight.
  const frozen = owner.ctx.storage.transactionSync(() => {
    if (readTextPreflightMarker(owner.ctx.storage) !== marker) return false;
    validateRelocationSourceSchema(owner.ctx.storage, route, { textGuard: true });
    initializeOwnerFence(owner.ctx.storage, route);
    writeTextPreflightSeal(owner.ctx.storage, route, moveId, marker);
    freezeOwnerFence(owner.ctx.storage, route, moveId);
    return true;
  });
  if (!frozen) return { state: 'stale' };
  return callProduction();
}
