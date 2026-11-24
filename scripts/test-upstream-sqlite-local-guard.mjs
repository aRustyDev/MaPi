import assert from 'node:assert/strict';
import { isLocalSQLiteTestRequest } from './upstream-sqlite-local-guard.mjs';

assert.equal(isLocalSQLiteTestRequest({ url: 'http://127.0.0.1:8787/' }, { MAPI_LOCAL_TEST: '1' }), true);
for (const [url, env] of [
  ['http://127.0.0.1:8787/', {}],
  ['http://127.0.0.1:8787/', { MAPI_LOCAL_TEST: 1 }],
  ['https://127.0.0.1:8787/', { MAPI_LOCAL_TEST: '1' }],
  ['http://localhost:8787/', { MAPI_LOCAL_TEST: '1' }],
  ['https://example.invalid/', { MAPI_LOCAL_TEST: '1' }],
  ['not a URL', { MAPI_LOCAL_TEST: '1' }],
]) assert.equal(isLocalSQLiteTestRequest({ url }, env), false);
console.log('Upstream SQLite test ingress requires the explicit loopback fixture setting.');
