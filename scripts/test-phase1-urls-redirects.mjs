import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { hostedOrigin, loopbackOrigin } from './phase1-urls.mjs';
import { requestJson } from './phase1-request.mjs';
import { rpFetch } from './phase1-rp-evidence.mjs';

assert.equal(hostedOrigin('https://synthetic.example/'), 'https://synthetic.example');
assert.equal(loopbackOrigin('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234');
for (const value of ['not a url private', 'https://u:secret@host.test', 'https://host.test/path', 'https://host.test/?x=private', 'https://host.test/#private', 'https://host.test/?', 'http://host.test']) {
  assert.throws(() => hostedOrigin(value), error => { assert.equal(error.message, 'Invalid hosted issuer origin'); return true; });
}
for (const value of ['not a url private', 'http://user:secret@127.0.0.1', 'http://127.0.0.1/private', 'http://127.0.0.1/?x=private', 'http://127.0.0.1/#private', 'http://other.test']) {
  assert.throws(() => loopbackOrigin(value), error => { assert.equal(error.message, 'Invalid loopback control origin'); return true; });
}
let sinkRequests = 0;
const sink = createServer((_request, response) => { sinkRequests++; response.end('unexpected'); });
sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
const source = createServer((request, response) => { response.writeHead(request.url === '/308' ? 308 : 307, { location: `http://127.0.0.1:${sink.address().port}/sink` }); response.end(); });
source.listen(0, '127.0.0.1'); await once(source, 'listening');
try {
  const origin = `http://127.0.0.1:${source.address().port}`;
  const options = { method: 'POST', headers: { authorization: 'Bearer private', 'content-type': 'application/json' }, body: '{"secret":"private"}', redirect: 'follow' };
  for (const status of [307, 308]) {
    for (const operation of ['oidc-init', 'project-token']) await assert.rejects(requestJson(`${origin}/${status}`, options, { operation }), error => { assert.deepEqual(error.phase1Failure, { operation, kind: 'transport', status: null }); return true; });
    for (const stage of ['token', 'replay', 'jwks']) {
      const input = stage === 'jwks' ? { method: 'GET', redirect: 'follow' } : options;
      await assert.rejects(rpFetch(`${origin}/${status}`, input, stage), error => { assert.deepEqual(error.phase1RpFailure, { stage, kind: 'transport', status: null }); return true; });
    }
  }
  assert.equal(sinkRequests, 0, 'credentials or bodies must never reach a redirect destination');
  console.log('Controlled requests reject cross-origin 307/308 redirects and URL errors are sanitized.');
} finally {
  source.closeAllConnections(); sink.closeAllConnections();
  await Promise.all([new Promise(done => source.close(done)), new Promise(done => sink.close(done))]);
}
