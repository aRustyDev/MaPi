// Classify only the kind of a flow submission. Never return field names,
// field values, session tokens, or any part of the request body.
export function classifyFlowSubmission(pathname, body) {
  if (!/^(?:\/__nextgen)?\/api\/v1\/flows\/flow_[A-Za-z0-9_-]+\/submit$/.test(pathname) && !/^\/__nextgen\/flows\/flow_[A-Za-z0-9_-]+\/submit$/.test(pathname)) return null;
  try {
    const fields = JSON.parse(body).fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return 'other';
    const types = Object.keys(fields).map(field => field.split(/[#/.]/).at(-1).toLowerCase());
    if (types.includes('password')) return 'password';
    if (types.some(type => ['email', 'login_name', 'identifier'].includes(type))) return 'identifier';
    return 'other';
  } catch { return 'other'; }
}
