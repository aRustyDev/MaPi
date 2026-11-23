// Deliberately fail closed until a benchmark-specific live verifier establishes
// fresh synthetic namespaces, active versions, private control bindings and
// route privacy. The relocation-control verifier does not prove these facts
// for the separate benchmark control Worker.
export async function requireBenchmarkProvenance() {
  throw new Error('Hosted benchmark disabled until benchmark-specific provenance is verified');
}
