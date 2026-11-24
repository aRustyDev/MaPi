import { drainBounded, jsonBounded } from './rehearsal-body.mjs';

export function requestFailure(operation, kind, status = null) {
  const error = new Error('Benchmark request failed');
  error.phase1Failure = { operation, kind, status };
  return error;
}

// The error surface retains only the operation, classification and status;
// malformed or hostile response bodies and credentials never enter reports.
export async function requestJson(url, options, { operation, fetcher = fetch, timeoutMs = 60000, expectedStatus } = {}) {
  const controller = new AbortController(), timeout = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.any([controller.signal, timeout]) });
    if (expectedStatus === undefined ? !response.ok : response.status !== expectedStatus) {
      await drainBounded(response, controller);
      throw requestFailure(operation, 'http', response.status);
    }
    return await jsonBounded(response, controller);
  } catch (error) {
    if (error?.phase1Failure) throw error;
    throw requestFailure(operation, timeout.aborted ? 'timeout' : response ? 'response' : 'transport', response?.status ?? null);
  }
}
