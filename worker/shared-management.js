import { handleManagementApp } from './management-ingress.js';
const fallback = { fetch() { return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }); } };
// The bound classes are owned by another Worker; no application or Wasm is
// imported here, and remote DO methods execute the owner's implementation.
export default { fetch(request, env) { return handleManagementApp(request, env, fallback); } };
