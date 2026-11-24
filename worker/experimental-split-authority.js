// Unmounted local prototype. Do not expose it through a public handler until
// credential policy, admission, schema privilege and recovery proofs pass.
import { assertOwnerFence } from './owner-fence.js';
import { canonicalOrigin } from './registry.js';

export function experimentalSplitAuthority({ storage, env, objectId, origin, coverage }) {
  if (env.MAPI_SPLIT_PASSWORD_EXPERIMENT !== '1' || typeof objectId !== 'string' || !objectId || typeof coverage !== 'function') throw new Error('Split experiment unavailable');
  const canonical = canonicalOrigin(origin);
  let epochs;
  try { epochs = JSON.parse(env.MAPI_SPLIT_RECOVERY_EPOCHS); } catch { throw new Error('Split recovery epoch unavailable'); }
  if (!epochs || typeof epochs !== 'object' || Array.isArray(epochs) || typeof epochs[objectId] !== 'string' || !epochs[objectId]) throw new Error('Split recovery epoch unavailable');
  const expectedEpoch = epochs[objectId];
  let route;
  return {
    async resolve() {
      const current = await env.PROJECT_REGISTRY.getByName('projects').resolve(canonical);
      if (!current || current.state !== 'active' || !current.project_id || current.origin !== canonical ||
          env.NEXTGEN_APPLICATION.idFromName(current.object_name).toString() !== objectId) throw new Error('Split route unavailable');
      route = { projectId: current.project_id, origin: current.origin, objectName: current.object_name, generation: current.generation };
      return route;
    },
    // Invoke inside the same synchronous transaction as admission or commit.
    check() {
      assertOwnerFence(storage, route);
      const epochs = storage.sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray();
      if (epochs.length !== 1 || epochs[0].epoch !== expectedEpoch || coverage(storage).length) throw new Error('Split authority is stale');
      return { route, epoch: expectedEpoch };
    },
  };
}
