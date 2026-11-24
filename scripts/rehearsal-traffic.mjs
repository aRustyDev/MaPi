import { drainBounded } from './rehearsal-body.mjs';
// The coordinator is the only mover in this rehearsal. Its committed result
// is a cutover boundary; never count a sample spanning it as closure proof.
export function classifyClosure(previousPhase, nextPhase) {
  const closed = ['frozen', 'importing', 'reconciling'];
  if (!closed.includes(previousPhase)) throw Error('Traffic sampled outside fenced move');
  if (nextPhase === 'committed') return 'cutover-boundary-excluded';
  if (!closed.includes(nextPhase)) throw Error('Unexpected coordinator phase during traffic sample');
  return 'fenced';
}
// Traffic for a newly generated synthetic rehearsal only. No credentials or
// cookies are returned to the caller or emitted in journal records.
export function createRehearsalTraffic(fixture, { fetcher = fetch, allowLoopback = false, clock = () => performance.now() } = {}) {
  if (!fixture || fixture.state !== 'prepared' || !/^[0-9a-f]{32}$/.test(fixture.rehearsalId ?? '') || !fixture.email || !fixture.otherEmail || !fixture.password || !fixture.cookie) throw Error('Synthetic traffic fixture is incomplete');
  const origins = [fixture.origin, fixture.otherOrigin].map((value, index) => {
    const origin = new URL(value);
    const role = index ? 'router' : 'owner';
    const generated = origin.protocol === 'https:' && origin.hostname.split('.')[0] === `mapi-p1-rehearsal-${fixture.rehearsalId}-${role}` && /^[a-z0-9-]+\.workers\.dev$/.test(origin.hostname.split('.').slice(1).join('.'));
    const local = allowLoopback && origin.protocol === 'http:' && origin.hostname === '127.0.0.1';
    if ((!generated && !local) || origin.origin !== value) throw Error('Traffic origin is not the generated synthetic rehearsal');
    return origin.origin;
  });
  if (origins[0] === origins[1]) throw Error('Synthetic origins must be distinct');
  let otherCookie;
  async function run(base, path, options) {
    const started = clock();
    const controller = new AbortController();
    const response = await fetcher(new URL(path, base), { ...options, redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    await drainBounded(response, controller);
    const ended = clock();
    return { status: response.status, started, ended, cookie };
  }
  const login = (base, email) => run(base, '/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password: fixture.password }) });
  const session = (base, cookie) => run(base, '/app', { headers: { cookie } });
  return {
    async prepare() {
      const result = await login(origins[1], fixture.otherEmail);
      if (result.status !== 303 || !result.cookie) throw Error('Other-project traffic session setup failed');
      otherCookie = result.cookie;
    },
    async sample() {
      if (!otherCookie) throw Error('Traffic session setup missing');
      const outcomes = await Promise.allSettled([
        login(origins[0], fixture.email), session(origins[0], fixture.cookie),
        login(origins[1], fixture.otherEmail), session(origins[1], otherCookie),
      ]);
      const failure = outcomes.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      const [sourceLogin, sourceSession, otherLogin, otherSession] = outcomes.map(result => result.value);
      if (otherLogin.status !== 303 || !otherLogin.cookie || otherSession.status !== 200) throw Error(`Other project traffic failed (login ${otherLogin.status}, session ${otherSession.status})`);
      if (sourceLogin.status !== 503 || sourceSession.status !== 503) throw Error(`Moving project traffic returned unexpected status (login ${sourceLogin.status}, session ${sourceSession.status})`);
      return Object.fromEntries(Object.entries({ sourceLogin, sourceSession, otherLogin, otherSession }).map(([key, { status, started, ended }]) => [key, { status, started, ended }]));
    },
  };
}
