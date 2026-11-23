// One entry per synthetic OAuth state. State values remain in memory only;
// reporting uses only the sanitized failure returned by finish().
export function createRpOperations({ settleTimeoutMs = 5000 } = {}) {
  const slots = new Map();
  function register(state) {
    if (!state || slots.has(state)) throw new Error('Invalid RP operation state');
    let resolve;
    const settled = new Promise(done => { resolve = done; });
    slots.set(state, { controller: new AbortController(), settled, resolve, active: false, done: false, failure: null });
  }
  function begin(state) {
    const slot = slots.get(state);
    if (!slot || slot.active || slot.done) throw new Error('Unknown RP operation');
    slot.active = true;
    return slot.controller.signal;
  }
  function complete(state, failure = null) {
    const slot = slots.get(state);
    if (!slot || !slot.active || slot.done) return;
    slot.done = true; slot.failure = failure; slot.resolve();
  }
  async function finish(state, { abort = false, reason = 'aborted' } = {}) {
    const slot = slots.get(state);
    if (!slot) return null;
    if (abort && !slot.done) slot.controller.abort(reason);
    if (!slot.active) {
      slots.delete(state);
      return abort ? { stage: 'callback', kind: reason, status: null } : null;
    }
    if (!slot.done) {
      let timeout;
      const timedOut = await Promise.race([slot.settled.then(() => false), new Promise(resolve => { timeout = setTimeout(() => resolve(true), settleTimeoutMs); })]);
      clearTimeout(timeout);
      if (timedOut) {
        slots.delete(state);
        return { stage: 'callback', kind: 'unsettled', status: null };
      }
    }
    slots.delete(state);
    return slot.failure;
  }
  return { register, begin, complete, finish, canStart: state => { const slot = slots.get(state); return Boolean(slot && !slot.active && !slot.done); }, size: () => slots.size };
}
