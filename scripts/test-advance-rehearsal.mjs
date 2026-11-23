import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

let count = 0;
const server = createServer((request, response) => {
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer synthetic-token');
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(++count === 1 ? { done: false, phase: 'importing' } : { done: true, phase: 'retired' }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  async function run(url) {
    const child = spawn(process.execPath, ['scripts/advance-rehearsal.mjs'], { env: { ...process.env, MAPI_REHEARSAL_CONTROL_URL: url, MAPI_REHEARSAL_OPERATOR_TOKEN: 'synthetic-token', MAPI_REHEARSAL_CALL_LIMIT: '4' }, stdio: 'ignore' });
    return (await once(child, 'exit'))[0];
  }
  assert.notEqual(await run('https://example.test'), 0);
  assert.equal(await run(`http://127.0.0.1:${server.address().port}/`), 0);
  assert.equal(count, 2);
  console.log('Verified rehearsal driver rejects non-loopback targets and stops on completion.');
} finally { server.close(); }
