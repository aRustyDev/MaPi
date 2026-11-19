import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const commit = "b0b74cd4a198428ea9b82910c217259ffc62b65c";
const source = resolve(process.env.MAPI_NEXTGEN_SOURCE ?? ".mapi/nextgen");
const openapiPath = "apps/api/api/openapi/bundled/openapi.json";
const spec = JSON.parse(execFileSync("git", ["-C", source, "show", `${commit}:${openapiPath}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
const routeSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_routes_wasip1.go", "utf8");
const mounts = [...routeSource.matchAll(/mount\("([A-Z]+)",\s*"([^"]+)",\s*func\([^]*?s\.handle([A-Za-z0-9]+)Request\(/g)]
  .map((match) => ({ method: match[1], path: match[2], operationId: match[3][0].toLowerCase() + match[3].slice(1) }));
const normalize = (path) => path.replace(/\{[^}]+\}/g, "{}");
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).filter(([method, operation]) => methods.has(method) && operation.operationId)
    .map(([method, operation]) => ({ path, method: method.toUpperCase(), id: operation.operationId, tag: operation.tags?.[0] ?? "Other" })));
if (operations.length !== 107) throw new Error(`Pinned OpenAPI operation count changed: ${operations.length}`);
if (new Set(operations.map(({ id }) => id)).size !== operations.length) throw new Error("Duplicate OpenAPI operation ID");
for (const mount of mounts) {
  if (!operations.some((operation) => operation.id === mount.operationId && operation.method === mount.method && normalize(operation.path) === normalize(mount.path))) {
    throw new Error(`Go mount has no matching pinned OpenAPI operation: ${mount.method} ${mount.path} ${mount.operationId}`);
  }
}
if (new Set(mounts.map(({ operationId }) => operationId)).size !== mounts.length) throw new Error("Duplicate Go mount");

// These are explicit coverage claims for the current checked-in suites. A route
// mounted in Go is not necessarily exposed by either Worker or parity-tested.
const parity = new Set(["createAuthAttempt", "createAuthAttemptChallenge", "verifyAuthAttemptChallenge", "createAuthAttemptHandoff", "exchangeHandoff", "getMySession", "revokeSession"]);
const browser = new Set(["createAuthAttempt", "createAuthAttemptChallenge", "verifyAuthAttemptChallenge", "createAuthAttemptHandoff", "exchangeHandoff", "getMySession", "getMySessionCsrfToken", "revokeMySession"]);
const experimentalFlow = new Set(["createFlow", "getFlowStep", "submitFlowStep"]);
const experimentalManagement = new Set(["getUser", "queryUsers", "listEvents", "getEvent"]);
const experimentalBranding = new Set(["publishBranding", "listBranding", "getBranding"]);
const brandingSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_branding_wasip1.go", "utf8");
for (const operation of experimentalBranding) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!brandingSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental branding mount missing: ${operation}`); }
const experimentalSchemas = new Set(["publishSchema", "listSchemas", "getSchema"]);
const schemasSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_schemas_wasip1.go", "utf8");
for (const operation of experimentalSchemas) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!schemasSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental schema mount missing: ${operation}`); }
const experimentalReleaseDeployment = new Set(["createRelease", "listReleases", "getRelease", "revokeRelease", "createDeployment", "listDeployments", "getDeployment", "listDeploymentVariables", "rollbackDeployment"]);
const releaseDeploymentSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_release_deployment_wasip1.go", "utf8");
for (const operation of experimentalReleaseDeployment) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!releaseDeploymentSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental release/deployment mount missing: ${operation}`); }
const experimentalReleaseVariables = new Set(["listVariables", "setVariables", "getVariable", "deleteVariable"]);
const releaseVariablesSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_release_variables_wasip1.go", "utf8");
for (const operation of experimentalReleaseVariables) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!releaseVariablesSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental variable mount missing: ${operation}`); }
const experimentalUserCreate = new Set(["createUser"]);
const userCreateSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_usercreate_wasip1.go", "utf8");
if (!userCreateSource.includes("s.handleCreateUserRequest(")) throw new Error("Experimental user-creation mount missing");
const experimentalUserDelete = new Set(["getUser", "deleteUser"]);
const userDeleteSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_userdelete_wasip1.go", "utf8");
for (const operation of experimentalUserDelete) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!userDeleteSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental user-deletion mount missing: ${operation}`); }
const experimentalInvitations = new Set(["createInvitation", "listInvitations", "getInvitation", "cancelInvitation"]);
const invitationSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_invitations_wasip1.go", "utf8");
for (const operation of experimentalInvitations) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!invitationSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental invitation mount missing: ${operation}`); }
const experimentalTeams = new Set(["createTeam", "queryTeams", "getTeam", "updateTeam", "deactivateTeam"]);
const teamsSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_teams_wasip1.go", "utf8");
for (const operation of experimentalTeams) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!teamsSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental team mount missing: ${operation}`); }
const experimentalSelf = new Set(["getMyUserSchema", "listMyTeams", "listMyIdentityLinks", "listUserTeams", "listUserIdentityLinks"]);
const selfSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_self_wasip1.go", "utf8");
for (const operation of experimentalSelf) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!selfSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental self-service mount missing: ${operation}`); }
const experimentalPasskey = new Set(["listUserPasskeys", "createUserPasskeyRegistration", "completeUserPasskeyRegistration", "listMyPasskeys"]);
const passkeySource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_passkey_wasip1.go", "utf8");
for (const operation of experimentalPasskey) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!passkeySource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental passkey mount missing: ${operation}`); }
const experimentalAccount = new Set(["getUser", "updateUser", "getUserPasswordState", "setUserPassword", "getMyUser", "updateMyUser", "getMyPasswordState"]);
const accountSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_account_wasip1.go", "utf8");
for (const operation of experimentalAccount) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!accountSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental account mount missing: ${operation}`); }
const experimentalSession = new Set(["createSession", "getSession", "querySessions"]);
const sessionSource = await readFile("upstream/overlay/apps/api/internal/api/generated/mapi_session_extra_wasip1.go", "utf8");
for (const operation of experimentalSession) { const handler = operation[0].toUpperCase() + operation.slice(1); if (!sessionSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental session mount missing: ${operation}`); }
const managementSource = (await Promise.all(["mapi_management_wasip1.go", "mapi_events_wasip1.go"].map(name => readFile(`upstream/overlay/apps/api/internal/api/generated/${name}`, "utf8")))).join("\n");
for (const operation of experimentalManagement) {
  const handler = operation[0].toUpperCase() + operation.slice(1);
  if (!managementSource.includes(`s.handle${handler}Request(`)) throw new Error(`Experimental management mount missing: ${operation}`);
}
for (const id of [...parity, ...browser]) if (!operations.some((operation) => operation.id === id)) throw new Error(`Coverage references unknown operation: ${id}`);
const proofLinks = [
  [parity, "[shared parity harness](../scripts/parity.mjs)"],
  [browser, "[application journey](../scripts/test-app.mjs)"],
  [experimentalManagement, "[management](management-read-proof.md) and [events](events-read-proof.md) proofs"],
  [experimentalAccount, "[account proof](account-adapter-proof.md)"],
  [experimentalPasskey, "[passkey proof](passkey-adapter-proof.md)"],
  [experimentalSelf, "[self-service proof](self-service-reads-proof.md)"],
  [experimentalInvitations, "[invitations proof](invitations-proof.md)"],
  [experimentalTeams, "[teams proof](team-management-proof.md)"],
  [experimentalUserDelete, "[user deletion proof](user-deletion-proof.md)"],
  [experimentalUserCreate, "[user creation proof](user-create-proof.md)"],
  [experimentalSession, "[session test](../scripts/test-session-extra-parity.mjs)"],
  [experimentalBranding, "[branding proof](branding-parity-proof.md)"],
  [experimentalSchemas, "[schemas proof](schemas-parity-proof.md)"],
  [experimentalReleaseDeployment, "[release/deployment proof](release-deployment-parity-proof.md)"],
  [experimentalReleaseVariables, "[release variables proof](release-variables-parity-proof.md)"],
  [experimentalFlow, "[Console flow proof](console-flow-proof.md)"],
];
const proofGaps = [
  [experimentalReleaseVariables, "Test authorized session CSRF, key rotation, and cross-object grants"],
  [experimentalReleaseDeployment, "Test competing release writes, authorized session CSRF, and cross-object grants"],
  [experimentalSchemas, "Test remote schema ingestion, delegated grants, and complete audit payloads"],
  [experimentalBranding, "Test full response and audit payloads, delegated grants, and hosted execution"],
  [experimentalSession, "Test separate-object authorization, complete response bodies, and hosted execution"],
  [experimentalUserCreate, "Test separate-object authorization and delegated grants"],
  [experimentalUserDelete, "Test cross-object state, delegated grants, and complete audit payloads"],
  [experimentalInvitations, "Test invitation claim, cross-object authorization, and full audit payloads"],
  [experimentalTeams, "Test cross-object grants, delegated authorization, and full audit payloads"],
  [experimentalSelf, "Test actual external IdP, cross-object grants, and all schema bodies and filters"],
  [experimentalPasskey, "Test official login component, deletion and recovery, hardware authenticators, and hosted origin"],
  [experimentalAccount, "Test separate-object authorization, complete status and response bodies, and hosted execution"],
  [experimentalManagement, "Test cross-object grants, complete response and audit payloads, and hosted execution"],
  [experimentalFlow, "Compare native flow response and publishable-key exchange authorization; test complete browser suite"],
  [parity, "Compare native authorization, error envelopes, response fields and audit payloads across password, handoff and session cases"],
  [browser, "Compare native authorization and errors and run the pinned browser suite"],
];
const lines = [
  "# Nextgen parity inventory", "",
  `The authoritative upstream pin is [v0.7.0 at ${commit}](https://github.com/zitadel/nextgen/tree/${commit}). Generate this file with \`node scripts/parity-inventory.mjs > docs/parity-inventory.md\`. Run \`node scripts/parity-inventory.mjs --check\` to detect drift.`, "",
  `The pinned OpenAPI document declares **${operations.length} operations**. The Go adapter mounts **${mounts.length}**. Optional management and events builds each mount two operations; the account build mounts seven, with separate test builds adding user creation and deletion. Other test builds mount four passkey, five self-service read, five team, four invitation, three session, three branding, and three schema operations. Some routes appear in more than one build. Mounts alone do not establish public ingress or parity.`, "",
  "The coverage column describes evidence from the checked-in tests, rather than a claim that every status, permission, or response field has full parity. All entries retain a full-parity test gap until the operation has a comprehensive native-versus-Worker comparison.", "",
  "## OpenAPI operations", "",
  "| Area | Operation | Route | Go adapter | Existing evidence | Remaining parity gap |",
  "| --- | --- | --- | --- | --- | --- |",
];
for (const op of operations) {
  const mounted = mounts.some((mount) => mount.operationId === op.id);
  const evidence = [];
  if (parity.has(op.id)) evidence.push("native/Worker parity harness");
  if (browser.has(op.id)) evidence.push("application journey");
  if (["getLive", "getReady"].includes(op.id)) evidence.push("native/workerd adapter GET parity");
  if (experimentalManagement.has(op.id)) evidence.push(["listEvents", "getEvent"].includes(op.id) ? "experimental native/workerd authorization and pagination checks" : "experimental native/workerd authorization checks");
  if (experimentalAccount.has(op.id)) evidence.push("experimental native/workerd account and authorization comparisons; foreign-credential status differs");
  if (experimentalPasskey.has(op.id)) evidence.push("experimental native/workerd virtual authenticator checks; foreign-credential status differs");
  if (experimentalSelf.has(op.id)) evidence.push("experimental native/workerd paginated self-service authorization checks; foreign-credential status differs");
  if (experimentalInvitations.has(op.id)) evidence.push("experimental native/workerd invitation admin and audit checks; claim and cross-object authorization unproven");
  if (experimentalTeams.has(op.id)) evidence.push("experimental native/workerd team authorization and mutation-audit checks; cross-object grants unproven");
  if (experimentalUserDelete.has(op.id)) evidence.push("experimental native/workerd user-deletion authorization, owner guard and audit checks; cross-object state unproven");
  if (experimentalUserCreate.has(op.id)) evidence.push("experimental native/workerd user creation, team membership and mutation-audit checks; cross-object authorization unproven");
  if (experimentalSession.has(op.id)) evidence.push("experimental native/workerd session creation, operator permissions and pagination checks; foreign-credential status differs");
  if (experimentalBranding.has(op.id)) evidence.push("experimental native/workerd branding authorization, pagination, audit rollback and redaction checks; foreign-credential status differs");
  if (experimentalSchemas.has(op.id)) evidence.push("experimental native/workerd schema revision, authorization, pagination and audit rollback checks; foreign-credential status differs");
  if (experimentalReleaseDeployment.has(op.id)) evidence.push("experimental native/workerd release and deployment lifecycle, authorization and audit rollback checks; foreign-credential status differs");
  if (experimentalReleaseVariables.has(op.id)) evidence.push("experimental native/workerd variable, frozen deployment snapshot, redaction and audit rollback checks; foreign-credential status differs");
  for (const [covered, link] of proofLinks) if (covered.has(op.id)) evidence.push(link);
  if (["getLive", "getReady"].includes(op.id)) evidence.push("[system parity test](../scripts/test-system-parity.mjs)");
  const adapter = mounted ? (experimentalFlow.has(op.id) ? "experimental MVP build only" : ["getLive", "getReady"].includes(op.id) ? "adapter only, no public ingress" : "mounted") : ["listEvents", "getEvent"].includes(op.id) ? "experimental events build only" : experimentalReleaseVariables.has(op.id) ? "experimental variable build only" : experimentalReleaseDeployment.has(op.id) ? "experimental release/deployment build only" : experimentalSchemas.has(op.id) ? "experimental schema build only" : experimentalBranding.has(op.id) ? "experimental branding build only" : experimentalSession.has(op.id) ? "experimental session build only" : experimentalUserCreate.has(op.id) ? "experimental user-creation build only" : op.id === "getUser" && experimentalUserDelete.has(op.id) ? "experimental management, account and user-deletion builds" : experimentalUserDelete.has(op.id) ? "experimental user-deletion build only" : experimentalInvitations.has(op.id) ? "experimental invitation build only" : experimentalTeams.has(op.id) ? "experimental team build only" : experimentalSelf.has(op.id) ? "experimental self-service build only" : experimentalPasskey.has(op.id) ? "experimental passkey build only" : experimentalAccount.has(op.id) && experimentalManagement.has(op.id) ? "experimental management and account builds" : experimentalAccount.has(op.id) ? "experimental account build only" : experimentalManagement.has(op.id) ? "experimental management build only" : "not mounted";
  const gap = proofGaps.find(([covered]) => covered.has(op.id))?.[1] ?? (["getLive", "getReady"].includes(op.id) ? "Test public ingress and readiness failure against native" : `Exercise ${op.method} ${op.path} against native and Worker, including authorization and errors`);
  lines.push(`| ${op.tag} | \`${op.id}\` | \`${op.method} ${op.path}\` | ${adapter} | ${evidence.join(", ") || "none"} | ${gap} |`);
}
lines.push("", "## Other native HTTP and runtime surfaces", "",
  `These are not all represented as separate operations in the bundled OpenAPI document. See the pinned [resource mounts](https://github.com/zitadel/nextgen/blob/${commit}/apps/api/internal/api/mount.go) and [server mounts](https://github.com/zitadel/nextgen/blob/${commit}/apps/api/cmd/server/server.go). Their MaPi parity coverage is pending.`, "",
  "| Surface | Native behavior | MaPi gap |", "| --- | --- | --- |",
  "| Resource API aliases | `/api/v1` and root aliases, deprecation and link headers, legacy `/flow` aliases and deployment target compatibility | Headers and alias behavior need native comparison |",
  "| OpenAPI and probes | `/api/v1/openapi.json`, `/livez`, `/readyz` and API-prefixed probes | GET probes and OpenAPI document compared through adapter; default ingress, error cases, and readiness failure still need coverage |",
  "| Console | Configurable Console asset path and `/console/runtime.json` | Local [static](console-static-investigation.md), [runtime](console-runtime-proof.md), [flow](console-flow-proof.md) and [management](console-management-proof.md) proofs cover slices; hosted integration and upstream Console suites remain untested |",
  "| External IdP callbacks | `/idp/{slug}/callback` and `/__nextgen/idp/{slug}/callback` | [Local callback egress proof](idp-callback-egress-proof.md) uses a synthetic provider; actual flow state, browser binding, audit and hosted provider tests remain |",
  "| Retention and security reports | Optional `/cron/events-retention` and `/csp-report` | Scheduling, authorization and report handling need tests |",
  "| OAuth/OIDC issuer scaffolding | Optional metadata routes and `/oauth` handlers | v0.7.0 denies issuer admission and its OP server is unimplemented. The MVP issuer is an additional extension and needs protocol conformance tests |",
  "", "## Upstream acceptance suites", "",
  "| Suite | Upstream source | MaPi evidence gap |", "| --- | --- | --- |",
  `| Browser journeys | [e2e/journey](https://github.com/zitadel/nextgen/tree/${commit}/e2e/journey) | [Local Console password journey](console-flow-proof.md) covers a slice; run the pinned official journey suite against MaPi |`,
  `| Console | [e2e/console](https://github.com/zitadel/nextgen/tree/${commit}/e2e/console) | [Local flow](console-flow-proof.md) and [management](console-management-proof.md) proofs cover slices; run pinned Console suites against MaPi |`,
  `| CLI | [e2e/cli](https://github.com/zitadel/nextgen/tree/${commit}/e2e/cli) | Upstream CLI deployment suite against MaPi is not yet run |`,
  `| SDKs | [conformance](https://github.com/zitadel/nextgen/tree/${commit}/conformance) | [API client](sdk-api-parity-proof.md) and [session/CSRF](sdk-session-csrf-proof.md) local slices exist; run pinned framework and SDK conformance against MaPi |`,
  "", "## Draft and extension capabilities", "",
  "| Capability | Pinned status | MaPi follow-up |", "| --- | --- | --- |",
  `| OAuth/OIDC provider | [ADR 082](https://github.com/zitadel/nextgen/blob/${commit}/docs/adrs/082-oauth-and-oidc-server.md) describes the intended protocol profile. Server wiring denies admission and the provider handlers are unimplemented. | Deliver and test the MVP issuer as an extension. |`,
  `| TOTP and recovery codes | The pinned [OpenAPI](https://github.com/zitadel/nextgen/blob/${commit}/apps/api/api/openapi/bundled/openapi.json) describes examples, but the public [challenge handler](https://github.com/zitadel/nextgen/blob/${commit}/apps/api/internal/api/auth_attempt.go) accepts identifier, password and passkey methods and proofs only. | Do not claim a shipped TOTP or recovery-code authentication journey; test any implementation as an extension. |`,
  `| Password recovery, notifications and background jobs | The pinned OpenAPI has password read/set but no named password-recovery operation; the [native server](https://github.com/zitadel/nextgen/blob/${commit}/apps/api/cmd/server/server.go) mounts optional event retention. | Check each password recovery and notification channel against public runtime behavior before classifying; test retention scheduling and authorization. |`,
  "", "The current MaPi evidence is in `scripts/parity.mjs`, `scripts/test-worker.mjs`, `scripts/test-app.mjs`, and `scripts/test-browser.mjs`. Hosted results and their limits are recorded in `REPORT.md`.", "");
const output = lines.join("\n");
if (process.argv.includes("--check")) {
  const actual = await readFile("docs/parity-inventory.md", "utf8");
  if (actual !== output) throw new Error("Parity inventory is stale; regenerate docs/parity-inventory.md");
  console.log(`Parity inventory matches ${operations.length} operations and ${mounts.length} Go mounts.`);
} else process.stdout.write(output);
