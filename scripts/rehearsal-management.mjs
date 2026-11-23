import { drainBounded, jsonBounded } from './rehearsal-body.mjs';

// Each synthetic project is seeded with exactly one distinct user. The API's
// user response does not contain a project ID, so check the expected user and
// reject extra rows instead of inferring identity from HTTP 200.
export function validateRehearsalManagementResult(body, fixture, query) {
  if (!fixture?.otherUserId || !fixture?.userId || fixture.otherUserId === fixture.userId) throw Error('Synthetic user identities are incomplete or overlap');
  if (query) {
    if (!Array.isArray(body?.users) || body.users.length !== 1 || body.users[0]?.id !== fixture.otherUserId || body.next_page_token) throw Error('Unexpected other-project management query result');
  } else if (body?.id !== fixture.otherUserId) {
    throw Error('Unexpected other-project management user result');
  }
}
// The other project's reads use a separately issued synthetic credential.
export async function rehearsalManagementRead(fixture, token, index, fetcher = fetch) {
  if (!fixture || fixture.state !== 'prepared' || !/^[0-9a-f]{32}$/.test(fixture.rehearsalId ?? '') || typeof token !== 'string' || !token || typeof fixture.otherProjectId !== 'string' || !fixture.otherProjectId || typeof fixture.otherUserId !== 'string' || !fixture.otherUserId || typeof fixture.userId !== 'string' || !fixture.userId || fixture.userId === fixture.otherUserId) throw Error('Synthetic management fixture is incomplete');
  const origin = new URL(fixture.otherOrigin);
  if (origin.protocol !== 'https:' || origin.hostname.split('.')[0] !== `mapi-p1-rehearsal-${fixture.rehearsalId}-router` || !/^[a-z0-9-]+\.workers\.dev$/.test(origin.hostname.split('.').slice(1).join('.')) || origin.origin !== fixture.otherOrigin) throw Error('Management origin is not the generated synthetic router');
  const query = index % 2 === 1;
  const path = query ? `/api/v1/users/query?project_id=${encodeURIComponent(fixture.otherProjectId)}` : `/api/v1/users/${encodeURIComponent(fixture.otherUserId)}`;
  const controller = new AbortController();
  const response = await fetcher(new URL(path, origin), { method: query ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, origin: origin.origin, 'sec-fetch-site': 'same-origin', ...(query ? { 'content-type': 'application/json' } : {}) }, ...(query ? { body: '{}' } : {}), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
  if (!response.ok) {
    await drainBounded(response, controller);
    throw Error(`Other project management read returned HTTP ${response.status}`);
  }
  validateRehearsalManagementResult(await jsonBounded(response, controller), fixture, query);
}
