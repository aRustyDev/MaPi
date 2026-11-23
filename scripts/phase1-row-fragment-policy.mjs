// The disposable probe must be explicitly enabled by its local test runner.
export function allowsLocalProbe(request, env) {
  return env.MAPI_LOCAL_TEST === '1' && new URL(request.url).hostname === '127.0.0.1';
}
