import { assertNoUnexpectedHttp, recordUnexpectedHttp, unexpectedHttpSummary } from './phase1-benchmark-report.mjs';

// Observed requests remain in the set until Playwright reports finished or
// failed, even if response headers arrived before the RP callback completed.
export function observeBrowser(context, { primaryPage, issuerOrigin, rpOrigin, projectId, journeyState, timings, classifyFlowSubmission, onFirstRequest = () => {}, clock = () => performance.now() }) {
  if (!primaryPage || !context.pages().includes(primaryPage)) throw new Error('Primary browser page is missing');
  const starts = new WeakMap(), pending = new Set(), http = new Map();
  let lastChange = clock(), wake, firstRequestStarted, callbackStarted, lastHttpFailure = null;
  let unexpectedOrigins = 0, stateMismatches = 0, networkFailures = 0, cleanupAborts = 0, cleanup = false;
  let extraPages = context.pages().filter(page => page !== primaryPage).length, serviceWorkers = context.serviceWorkers().length, unattributedRequests = 0;
  function changed() { lastChange = clock(); wake?.(); }
  context.on('page', page => { if (page !== primaryPage) { extraPages++; changed(); } });
  context.on('serviceworker', () => { serviceWorkers++; changed(); });
  context.on('request', request => {
    const url = new URL(request.url()), started = clock();
    starts.set(request, { started, flowKind: classifyFlowSubmission(url.pathname, request.postData()) });
    pending.add(request); changed();
    let primary = false;
    try { primary = request.frame().page() === primaryPage; } catch { unattributedRequests++; }
    if (url.origin !== issuerOrigin && url.origin !== rpOrigin) unexpectedOrigins++;
    if (primary && url.origin === rpOrigin && url.pathname === '/start' && url.searchParams.get('state') === journeyState && firstRequestStarted === undefined) {
      firstRequestStarted = started;
      onFirstRequest(started);
    }
    if (primary && url.origin === issuerOrigin && url.pathname.endsWith('/authorize') && url.searchParams.get('state') !== journeyState) stateMismatches++;
    if (primary && url.origin === rpOrigin && url.pathname === '/callback') {
      callbackStarted = started;
      if (url.searchParams.get('state') !== journeyState) stateMismatches++;
    }
  });
  context.on('response', response => {
    const request = response.request(), url = new URL(request.url()), info = starts.get(request);
    if (!info) return;
    if (response.status() >= 400) {
      const source = url.origin === rpOrigin ? 'rp' : url.origin === issuerOrigin ? 'issuer' : 'other-origin';
      const group = source === 'rp' ? 'rp' : source === 'other-origin' ? 'other-origin' : url.pathname.startsWith('/__nextgen/') ? 'flow' : url.pathname.startsWith('/oauth/') ? 'oauth' : 'other';
      lastHttpFailure = { group, status: response.status() };
      recordUnexpectedHttp(http, url.pathname, response.status(), source);
    }
    if (url.origin === issuerOrigin) {
      const path = url.pathname.replace(/flow_[A-Za-z0-9_-]+/g, ':flow').replace(projectId, ':project');
      const key = `${request.method()} ${path}${info.flowKind ? ` [${info.flowKind}]` : ''}`;
      if (!timings.has(key)) timings.set(key, []);
      timings.get(key).push(clock() - info.started);
    }
    changed();
  });
  context.on('requestfinished', request => { pending.delete(request); changed(); });
  context.on('requestfailed', request => { if (cleanup) cleanupAborts++; else networkFailures++; pending.delete(request); changed(); });
  function snapshot(kind = null) {
    return { kind, pendingRequests: pending.size, networkFailures, cleanupAborts, unexpectedOrigins, stateMismatches, extraPages, serviceWorkers, unattributedRequests };
  }
  async function settle({ timeoutMs = 5000, quietMs = 100 } = {}) {
    const deadline = clock() + timeoutMs;
    for (;;) {
      const now = clock(), quietRemaining = Math.max(0, quietMs - (now - lastChange));
      if (now >= deadline) { const error = new Error('Browser requests did not settle'); error.phase1BrowserFailure = snapshot('timeout'); throw error; }
      if (!pending.size && !quietRemaining) return;
      const waitMs = Math.max(1, Math.min(deadline - now, pending.size ? deadline - now : quietRemaining));
      await new Promise(resolve => {
        const timer = setTimeout(() => { wake = null; resolve(); }, waitMs);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
    }
  }
  function assertNetworkClean() {
    if (pending.size || networkFailures || unexpectedOrigins || stateMismatches || extraPages || serviceWorkers || unattributedRequests) {
      const error = new Error('Unexpected browser network outcome'); error.phase1BrowserFailure = snapshot('network'); throw error;
    }
  }
  return { settle, assertNetworkClean, assertHttpClean: () => assertNoUnexpectedHttp(http), beginCleanup: () => { cleanup = true; }, snapshot, callbackStarted: () => callbackStarted, lastHttpFailure: () => lastHttpFailure, unexpectedHttp: () => unexpectedHttpSummary(http) };
}
