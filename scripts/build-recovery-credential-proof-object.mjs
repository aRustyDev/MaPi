import { readFile, writeFile } from 'node:fs/promises';

// Test-only object exposes existing private Go calls; it is not a Worker entry.
let app = await readFile('worker/app.js', 'utf8');
app = app.replace('"./generated/baseline.json"', '"./baseline.json"')
  .replace('"./wasm-module.js"', '"./recovery-token-proof.wasm"')
  .replace(/from "\.\/([^"/]+\.js)"/g, 'from "../$1"');
const anchor = '  handleRequest(request) {';
if (!app.includes(anchor)) throw Error('Application test anchor changed');
app = app.replace(anchor, `
  testCredentialProof(args) { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("test only"); this.#initialize(); return this.#call("mapi_recovery_token_proof", {...args, ProjectID: args.ProjectID ?? this.projectId()}); }
  testLegacyBearer(token) { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("test only"); this.#initialize(); return this.#upstream('POST', '/auth_attempts', {project_id:this.projectId()}, {authorization:'Bearer ' + token}); }
  testRecoveryBatch(recoveryId) { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("test only"); this.#initialize(); return this.#call("mapi_recover_batch", {projectId: this.projectId(), recoveryId}); }
  testPrepareVerifiedAttempt(email, password) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("test only");
    this.#initialize(); const projectId = this.projectId(); const { token } = this.#call("mapi_project_token", {projectId}); const auth = {authorization: "Bearer " + token};
    const start = this.#upstream("POST", "/auth_attempts", {project_id: projectId}, auth);
    if (start.status >= 300 || !start.data?.attempt_id) throw Error("attempt creation failed");
    const path = '/auth_attempts/' + start.data.attempt_id + '/challenges'; let challengeId;
    for (const [method, proof] of [["identifier", {login_name:email}], ["password", {password}]]) {
      const challenge = this.#upstream("POST", path, {method}, auth);
      if (challenge.status >= 300 || !challenge.data?.challenge_id) throw Error("challenge creation failed");
      challengeId = challenge.data.challenge_id;
      if (this.#upstream("POST", path + '/' + challengeId + '/verify', proof, auth).status >= 300) throw Error("challenge verification failed");
    }
    return {attemptId: start.data.attempt_id, challengeId};
  }
  testResumeVerifiedAttempt(attemptId, challengeId, password, operation) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("test only"); this.#initialize();
    const {token} = this.#call("mapi_project_token", {projectId:this.projectId()}); const auth = {authorization:"Bearer " + token};
    return operation === 'handoff' ? this.#upstream('POST', '/auth_attempts/' + attemptId + '/handoff', undefined, auth) : this.#upstream('POST', '/auth_attempts/' + attemptId + '/challenges/' + challengeId + '/verify', {password}, auth);
  }
  testMintHandoff(email, password) { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("test only"); this.#initialize(); return this.#mintHandoff(email, password); }
  testExchangeHandoff(handoff) { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("test only"); this.#initialize(); return this.#exchangeHandoff(handoff); }
${anchor}`);
await writeFile('worker/generated/recovery-credential-proof-object.js', app);
