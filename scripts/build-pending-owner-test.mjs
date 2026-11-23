// Test-only generated owner; production app.js contains no fault injection.
import { readFile, writeFile } from 'node:fs/promises';
let app = await readFile('worker/app.js', 'utf8');
const replaceOnce = (before, after) => {
  if (!app.includes(before) || app.indexOf(before) !== app.lastIndexOf(before)) throw Error(`Pending test hook anchor missing or ambiguous: ${before}`);
  app = app.replace(before, after);
};
replaceOnce('  #pendingAuthority;', '  #pendingAuthority;\n  #failPendingAfterGo = false;');
replaceOnce('      const result = this.#provision(name, origin);', `      const result = this.#provision(name, origin);
      if (this.env.MAPI_LOCAL_TEST === "1" && this.#failPendingAfterGo) {
        this.#failPendingAfterGo = false;
        throw new Error("Injected interruption after provisioning commit");
      }`);
replaceOnce('  provisioningAttestation(origin, objectName, generation) {', `  failPendingAfterGo() {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    this.#failPendingAfterGo = true;
  }

  provisioningAttestation(origin, objectName, generation) {`);
app = app.replace('"./generated/baseline.json"', '"./baseline.json"').replace(/from "\.\/([^"/]+\.js)"/g, 'from "../$1"');
await writeFile('worker/generated/pending-owner-test-app.js', app);
