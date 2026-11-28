import app, { NextgenApplication, ProjectRegistry } from './generated/phase1-owner-app.js';
import { handleManagementApp } from './management-ingress.js';
import { logRuntimeDiagnostic } from './runtime-diagnostics.js';

export { NextgenApplication, ProjectRegistry };
export { RelocationCoordinator } from './relocation-coordinator.js';
let workerBootId;
let recordedBoot = false;
export default {
  fetch(request, env) {
    if (env.MAPI_RUNTIME_DIAGNOSTICS === '1' && !recordedBoot) {
      recordedBoot = true;
      workerBootId = crypto.randomUUID();
      logRuntimeDiagnostic({ event: 'mapi.worker.boot', bootId: workerBootId });
    }
    return handleManagementApp(request, env, app);
  },
};
