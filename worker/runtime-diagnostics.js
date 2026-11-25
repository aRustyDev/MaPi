// A failed diagnostic sink must never change a request or initialization.
export function logRuntimeDiagnostic(event) {
  try { console.log(JSON.stringify(event)); }
  catch { /* Keep the original request outcome. */ }
}

export function logRuntimeError(...details) {
  try { console.error(...details); }
  catch { /* Keep the original request outcome. */ }
}

// Log only the platform's boolean overload classification. Error messages can
// contain request details and are intentionally excluded.
export function logOverload(error, component) {
  // Diagnostics are best effort. A failed log sink or unusual error object
  // must not replace the ingress's retryable response with an exception.
  try {
    if (error?.overloaded === true) console.error(JSON.stringify({ event: 'mapi.overload', component }));
  } catch { /* Keep the original request outcome. */ }
}

// Lifecycle markers are diagnostics only. Correlate repeated attempts in a
// single owner instance without exposing inputs or exception messages. A log
// sink failure must not change initialization or the application's response.
export function logReactorLifecycle(enabled, phase, bootId, objectId, attempt, initializations, wasmHighWaterBytes) {
  if (!enabled) return;
  try {
    if (phase === 'start' || phase === 'failure') {
      console.log(JSON.stringify({ event: `mapi.reactor.${phase}`, bootId, objectId, attempt }));
    } else if (phase === 'ready') {
      console.log(JSON.stringify({ event: 'mapi.reactor.ready', bootId, objectId, initialization: initializations, wasmHighWaterBytes, attempt }));
    }
  } catch { /* Observability is best-effort and cannot change business behavior. */ }
}

// Report only sampled growth, scoped to the owner instance. Logs can be lost
// and sampling at call boundaries does not observe every possible peak.
export function observeWasmHighWater(previous, bytes, enabled, bootId, objectId) {
  const highWater = Math.max(previous, bytes);
  if (enabled && highWater > previous) {
    try { console.log(JSON.stringify({ event: 'mapi.wasm.highwater', bootId, objectId, wasmHighWaterBytes: highWater })); }
    catch { /* Diagnostics must not change the application result. */ }
  }
  return highWater;
}
