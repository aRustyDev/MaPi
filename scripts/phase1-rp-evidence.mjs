import { drainBounded, jsonBounded } from './rehearsal-body.mjs';

export function rpFailure(stage, status = null, kind = 'invalid') {
  const error = new Error('Independent RP operation failed');
  error.phase1RpFailure = { stage, kind, status };
  return error;
}

export async function rpFetch(url, options, stage, fetcher = fetch) {
  try { return await fetcher(url, { ...options, redirect: 'error' }); }
  catch { throw rpFailure(stage, null, 'transport'); }
}

// The pinned OAuth provider maps a reused code to HTTP 400 invalid_grant.
// A throttle or server error must never count as replay rejection evidence.
export async function assertExpectedReplay(response, controller) {
  try {
    if (response.status !== 400) {
      await drainBounded(response, controller);
      throw rpFailure('replay', response.status, response.status >= 400 ? 'http' : 'invalid');
    }
    const body = await jsonBounded(response, controller);
    if (body?.error !== 'invalid_grant') throw rpFailure('replay', response.status);
  } catch (error) {
    throw error?.phase1RpFailure ? error : rpFailure('replay', response.status, 'response');
  }
}
