// This test Worker is intended to run only through its loopback test runner.
export function isLocalSQLiteTestRequest(request, env) {
  if (env?.MAPI_LOCAL_TEST !== '1') return false;
  let url;
  try { url = new URL(request.url); } catch { return false; }
  return url.protocol === 'http:' && url.hostname === '127.0.0.1';
}
