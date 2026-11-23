// Exercises the real public Go-backed flow and one-time session exchange.
export async function createPendingHandoff(origin, projectId, email, password) {
  let cookie = '';
  async function step(path, body) {
    const response = await fetch(new URL(`/__nextgen${path}`, origin), { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000) });
    const next = response.headers.getSetCookie().find(value => value.startsWith('_zflow='));
    if (next) cookie = next.split(';', 1)[0];
    if (!response.ok) throw Error(`Synthetic flow returned HTTP ${response.status}`);
    return response.json();
  }
  let flow = await step('/flows', { project_id: projectId, purpose: 'login' });
  for (let hop = 0; hop < 6 && !flow.handoff_token; hop++) {
    const fields = {};
    for (const field of flow.step.fields ?? []) {
      const name = field.name.split(/[#/.]/).at(-1).toLowerCase();
      if (['email', 'login_name', 'identifier'].includes(name)) fields[field.name] = email;
      else if (name === 'password') fields[field.name] = password;
      else throw Error('Unexpected synthetic flow field');
    }
    flow = await step(`/flows/${encodeURIComponent(flow.id)}/submit`, { action: 'submit', fields, ...(flow.session_token ? { session_token: flow.session_token } : {}) });
  }
  if (!flow.handoff_token) throw Error('Synthetic flow did not produce a handoff');
  return { handoff: flow.handoff_token, cookie };
}

export async function exchangeHandoffOnce(origin, projectId, pending) {
  const exchange = () => fetch(new URL(`/__nextgen/sessions/exchange?project_id=${encodeURIComponent(projectId)}`, origin), { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(pending.cookie ? { cookie: pending.cookie } : {}) }, body: JSON.stringify({ handoff_token: pending.handoff }), redirect: 'error', signal: AbortSignal.timeout(60000) });
  const responses = await Promise.all([exchange(), exchange()]);
  const statuses = responses.map(response => response.status).sort((a, b) => a - b);
  if (statuses[0] !== 200 || statuses[1] < 400 || statuses[1] >= 500) throw Error(`Pending handoff did not exchange exactly once (${statuses.join(',')})`);
  return statuses;
}
