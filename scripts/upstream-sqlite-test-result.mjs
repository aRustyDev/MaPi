// A successful WASI process may have skipped the requested test or run none.
// Evidence requires the exact top-level test to have both run and passed.
export function upstreamTestResult(name, result) {
  if (typeof name !== 'string' || !/^Test[A-Za-z0-9_]+$/.test(name) || typeof result?.logs !== 'string') {
    return { ran: false, passed: false };
  }
  const lines = result.logs.split(/\r?\n/);
  const ran = lines.includes(`=== RUN   ${name}`);
  const pass = lines.some(line => line.startsWith(`--- PASS: ${name} (`));
  const rejected = lines.some(line => line.startsWith(`--- SKIP: ${name} (`) || line.startsWith(`--- FAIL: ${name} (`));
  return { ran, passed: ran && pass && !rejected && result.exitCode === 0 };
}
