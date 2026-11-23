// The local fixture reports only non-sensitive checkpoint summaries. Each
// observation is independent; these are not an atomic snapshot or a retry.
export async function inspectLocalMoveAfterTimeout(probe) {
  const parts = ['moveStatus', 'exportStatus', 'importStatus'];
  const results = await Promise.all(parts.map(async action => {
    try {
      const value = await probe(action);
      if (action === 'moveStatus') {
        const states = ['active', 'moving', 'recovering'];
        const phases = ['moving', 'committed'];
        return { action, outcome: 'read', storedRouteState: states.includes(value?.storedRouteState) ? value.storedRouteState : null, phase: phases.includes(value?.phase) ? value.phase : null, finalized: value?.finalized === true };
      }
      if (value === null || value === undefined) return { action, outcome: 'missing' };
      const next = value?.next_chunk;
      if (!Number.isSafeInteger(next) || next < 0 || ![true, false, 0, 1].includes(value?.done)) return { action, outcome: 'invalid' };
      return { action, outcome: 'read', nextChunk: next, done: value.done === true || value.done === 1 };
    } catch { return { action, outcome: 'unavailable' }; }
  }));
  return { event: 'local.move.timeout.checkpoints', observations: results };
}
