// Separate opt-in Worker build. The default worker/app.js remains unchanged.
import app, { NextgenApplication, ProjectRegistry } from './generated/management-app-base.js';
import { handleManagementApp } from './management-ingress.js';
export { NextgenApplication, ProjectRegistry };
export default { fetch(request, env) { return handleManagementApp(request, env, app); } };
