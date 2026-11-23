import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { observeBrowser } from './phase1-browser-observation.mjs';
import { classifyJourneyFailure } from './phase1-benchmark-report.mjs';

const issuer = createServer((request, response) => {
  if (request.url.startsWith('/__nextgen/hang')) { response.writeHead(200, { 'access-control-allow-origin': '*' }); response.write('partial'); return; }
  setTimeout(() => { if (!response.destroyed) { response.writeHead(503, { 'access-control-allow-origin': '*' }); response.end('private-error-body'); } }, 250);
});
issuer.listen(0, '127.0.0.1'); await once(issuer, 'listening');
const issuerOrigin = `http://127.0.0.1:${issuer.address().port}`;
const rp = createServer((request, response) => {
  if (request.url === '/sw.js') {
    response.writeHead(200, { 'content-type': 'application/javascript' });
    response.end("self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));");
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  if (request.url.startsWith('/start?')) { response.end('<h1>start</h1>'); return; }
  if (['/popup-host', '/sw-host'].includes(request.url)) { response.end('<h1>ready</h1>'); return; }
  const path = request.url === '/hang' ? 'hang' : 'late';
  response.end(`<h1>callback complete</h1><script>fetch('${issuerOrigin}/__nextgen/${path}?private=secret').catch(() => {});</script>`);
});
rp.listen(0, '127.0.0.1'); await once(rp, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(), page = await context.newPage();
  const rpOrigin = `http://127.0.0.1:${rp.address().port}`;
  const starts = [];
  const observation = observeBrowser(context, { primaryPage: page, issuerOrigin, rpOrigin, projectId: 'proj_synthetic', journeyState: 'synthetic', timings: new Map(), classifyFlowSubmission: () => null, onFirstRequest: value => starts.push(value) });
  const journeyStarted = performance.now();
  await page.goto(`${rpOrigin}/start?state=wrong`);
  assert.equal(starts.length, 0, 'a different state must not acknowledge this journey');
  await page.goto(`${rpOrigin}/start?state=synthetic`);
  assert.equal(starts.length, 1, 'the primary page actual start request must acknowledge the journey');
  assert.ok(starts[0] >= journeyStarted && starts[0] <= performance.now());
  await page.goto(`${rpOrigin}/start?state=synthetic`);
  assert.equal(starts.length, 1, 'a repeated start must not acknowledge twice');
  await page.goto(`${rpOrigin}/callback?state=synthetic`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'callback complete' }).waitFor();
  assert.ok(observation.callbackStarted() >= journeyStarted && observation.callbackStarted() <= performance.now());
  assert.ok(observation.snapshot().pendingRequests > 0, 'issuer response must still be outstanding after callback');
  await observation.settle({ timeoutMs: 3000, quietMs: 50 });
  await context.close();
  await observation.settle({ timeoutMs: 1000, quietMs: 0 });
  observation.assertNetworkClean();
  assert.throws(() => observation.assertHttpClean(), /Unexpected browser HTTP/);
  assert.deepEqual(observation.unexpectedHttp(), [{ group: 'flow', status: 503, count: 1 }]);
  assert.ok(!JSON.stringify(observation.unexpectedHttp()).includes('private'));
  const hangingContext = await browser.newContext(), hangingPage = await hangingContext.newPage();
  const hanging = observeBrowser(hangingContext, { primaryPage: hangingPage, issuerOrigin, rpOrigin, projectId: 'proj_synthetic', journeyState: 'synthetic', timings: new Map(), classifyFlowSubmission: () => null });
  await hangingPage.goto(`${rpOrigin}/hang`, { waitUntil: 'domcontentloaded' });
  await hangingPage.getByRole('heading', { name: 'callback complete' }).waitFor();
  await assert.rejects(hanging.settle({ timeoutMs: 100, quietMs: 10 }), error => {
    assert.equal(classifyJourneyFailure(error).category, 'browser_requests_incomplete');
    assert.equal(error.phase1BrowserFailure.kind, 'timeout');
    assert.ok(error.phase1BrowserFailure.pendingRequests > 0);
    return true;
  });
  hanging.beginCleanup(); await hangingContext.close();
  const popupContext = await browser.newContext(), popupPrimary = await popupContext.newPage();
  const popupObservation = observeBrowser(popupContext, { primaryPage: popupPrimary, issuerOrigin, rpOrigin, projectId: 'proj_synthetic', journeyState: 'synthetic', timings: new Map(), classifyFlowSubmission: () => null });
  await popupPrimary.goto(`${rpOrigin}/popup-host`);
  const popupEvent = popupContext.waitForEvent('page');
  await popupPrimary.evaluate(url => { window.open(url, '_blank'); }, `${rpOrigin}/callback?state=synthetic`);
  const popup = await popupEvent; await popup.waitForLoadState('domcontentloaded');
  await popupObservation.settle({ timeoutMs: 3000, quietMs: 50 });
  await popupContext.close(); await popupObservation.settle({ timeoutMs: 1000, quietMs: 0 });
  assert.equal(popupObservation.snapshot().extraPages, 1);
  assert.equal(popupObservation.callbackStarted(), undefined, 'popup callback must not replace primary-page timing');
  assert.throws(() => popupObservation.assertNetworkClean(), /Unexpected browser network/);
  assert.deepEqual(popupObservation.unexpectedHttp(), [{ group: 'flow', status: 503, count: 1 }]);
  const swContext = await browser.newContext(), swPage = await swContext.newPage();
  const swObservation = observeBrowser(swContext, { primaryPage: swPage, issuerOrigin, rpOrigin, projectId: 'proj_synthetic', journeyState: 'synthetic', timings: new Map(), classifyFlowSubmission: () => null });
  await swPage.goto(`${rpOrigin}/sw-host`);
  const swEvent = swContext.waitForEvent('serviceworker');
  await swPage.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  const sw = await swEvent;
  assert.equal(await sw.evaluate(async url => (await fetch(url)).status, `${issuerOrigin}/__nextgen/worker?private=secret`), 503);
  await swObservation.settle({ timeoutMs: 3000, quietMs: 50 });
  await swContext.close(); await swObservation.settle({ timeoutMs: 1000, quietMs: 0 });
  assert.ok(swObservation.snapshot().serviceWorkers > 0);
  assert.throws(() => swObservation.assertNetworkClean(), /Unexpected browser network/);
  assert.ok(swObservation.unexpectedHttp().some(item => item.group === 'flow' && item.status === 503));
  const wrongStateContext = await browser.newContext(), wrongStatePage = await wrongStateContext.newPage();
  const wrongState = observeBrowser(wrongStateContext, { primaryPage: wrongStatePage, issuerOrigin, rpOrigin, projectId: 'proj_synthetic', journeyState: 'synthetic', timings: new Map(), classifyFlowSubmission: () => null });
  await wrongStatePage.goto(`${rpOrigin}/callback?state=wrong`, { waitUntil: 'domcontentloaded' });
  await wrongState.settle({ timeoutMs: 3000, quietMs: 50 });
  assert.equal(wrongState.snapshot().stateMismatches, 1, 'a primary-page callback with the wrong state must be recorded');
  assert.throws(() => wrongState.assertNetworkClean(), /Unexpected browser network/);
  await wrongStateContext.close();
  const failedContext = await browser.newContext(), failedPage = await failedContext.newPage();
  const failed = observeBrowser(failedContext, { primaryPage: failedPage, issuerOrigin, rpOrigin, projectId: 'proj_synthetic', journeyState: 'synthetic', timings: new Map(), classifyFlowSubmission: () => null });
  await failedPage.goto(`${rpOrigin}/start?state=synthetic`);
  await failedPage.route(`${issuerOrigin}/network-failure`, route => route.abort('failed'));
  await failedPage.evaluate(url => fetch(url).catch(() => {}), `${issuerOrigin}/network-failure`);
  await failed.settle({ timeoutMs: 3000, quietMs: 50 });
  assert.equal(failed.snapshot().networkFailures, 1, 'a failed same-origin request must fail the network check');
  assert.equal(failed.snapshot().unexpectedOrigins, 0);
  assert.throws(() => failed.assertNetworkClean(), /Unexpected browser network/);
  await failedContext.close();
  const timeout = new Error('private'); timeout.phase1BrowserFailure = { kind: 'timeout', pendingRequests: 1, networkFailures: 0, cleanupAborts: 0, unexpectedOrigins: 0, stateMismatches: 0 };
  assert.equal(classifyJourneyFailure(timeout).category, 'browser_requests_incomplete');
  console.log('Delayed issuer 503 after callback is observed before journey success.');
} finally {
  if (browser) await browser.close();
  rp.closeAllConnections(); issuer.closeAllConnections();
  await Promise.all([new Promise(done => rp.close(done)), new Promise(done => issuer.close(done))]);
}
