// Acknowledgement follows actual primary-page start-request observations.
// If the attempts all settle before four starts are observed, the parent
// receives a partial acknowledgement and fails the wave without management.
export async function beginObservedWave(factories, now = () => performance.timeOrigin + performance.now()) {
  if (!Array.isArray(factories) || factories.length !== 4 || factories.some(factory => typeof factory !== 'function')) throw new Error('Invalid benchmark journey factories');
  const started = new Set();
  let signalAll;
  const allStarted = new Promise(resolve => { signalAll = resolve; });
  const attempts = factories.map((factory, index) => Promise.resolve().then(() => factory(() => { started.add(index); if (started.size === factories.length) signalAll(); })));
  const settled = Promise.allSettled(attempts);
  await Promise.race([allStarted, settled]);
  return { attempts: attempts.length, started: started.size, childAcknowledgedAtMs: now(), settled };
}
