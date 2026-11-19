# Nextgen parity inventory

The authoritative upstream pin is [v0.7.0 at b0b74cd4a198428ea9b82910c217259ffc62b65c](https://github.com/zitadel/nextgen/tree/b0b74cd4a198428ea9b82910c217259ffc62b65c). Generate this file with `node scripts/parity-inventory.mjs > docs/parity-inventory.md`. Run `node scripts/parity-inventory.mjs --check` to detect drift.

The pinned OpenAPI document declares **107 operations**. The Go adapter mounts **14**. Optional management and events builds each mount two operations; the account build mounts seven, with separate test builds adding user creation and deletion. Other test builds mount four passkey, five self-service read, five team, four invitation, and three session operations. Some routes appear in more than one build. Mounts alone do not establish public ingress or parity.

The coverage column describes evidence from the checked-in tests, rather than a claim that every status, permission, or response field has full parity. All entries retain a full-parity test gap until the operation has a comprehensive native-versus-Worker comparison.

## OpenAPI operations

| Area | Operation | Route | Go adapter | Existing evidence | Remaining parity gap |
| --- | --- | --- | --- | --- | --- |
| System | `getLive` | `GET /livez` | adapter only, no public ingress | native/workerd adapter GET parity | partial behavior only |
| System | `getReady` | `GET /readyz` | adapter only, no public ingress | native/workerd adapter GET parity | partial behavior only |
| Users | `createUser` | `POST /users` | experimental user-creation build only | experimental native/workerd user creation, team membership and mutation-audit checks; cross-object authorization unproven | partial behavior only |
| Users | `queryUsers` | `POST /users/query` | experimental management build only | experimental native/workerd authorization checks | partial behavior only |
| Users | `getUser` | `GET /users/{user_id}` | experimental management, account and user-deletion builds | experimental native/workerd authorization checks, experimental native/workerd account and authorization comparisons; foreign-credential status differs, experimental native/workerd user-deletion authorization, owner guard and audit checks; cross-object state unproven | partial behavior only |
| Users | `updateUser` | `PATCH /users/{user_id}` | experimental account build only | experimental native/workerd account and authorization comparisons; foreign-credential status differs | partial behavior only |
| Users | `deleteUser` | `DELETE /users/{user_id}` | experimental user-deletion build only | experimental native/workerd user-deletion authorization, owner guard and audit checks; cross-object state unproven | partial behavior only |
| Users | `listUserIdentityLinks` | `GET /users/{user_id}/identity_links` | experimental self-service build only | experimental native/workerd paginated self-service authorization checks; foreign-credential status differs | partial behavior only |
| Users | `listUserPasskeys` | `GET /users/{user_id}/passkeys` | experimental passkey build only | experimental native/workerd virtual authenticator checks; foreign-credential status differs | partial behavior only |
| Users | `createUserPasskeyRegistration` | `POST /users/{user_id}/passkeys/registrations` | experimental passkey build only | experimental native/workerd virtual authenticator checks; foreign-credential status differs | partial behavior only |
| Users | `completeUserPasskeyRegistration` | `POST /users/{user_id}/passkeys/registrations/{registration_id}` | experimental passkey build only | experimental native/workerd virtual authenticator checks; foreign-credential status differs | partial behavior only |
| Users | `getUserPasswordState` | `GET /users/{user_id}/password` | experimental account build only | experimental native/workerd account and authorization comparisons; foreign-credential status differs | partial behavior only |
| Users | `setUserPassword` | `PUT /users/{user_id}/password` | experimental account build only | experimental native/workerd account and authorization comparisons; foreign-credential status differs | partial behavior only |
| Users | `listUserTeams` | `GET /users/{user_id}/teams` | experimental self-service build only | experimental native/workerd paginated self-service authorization checks; foreign-credential status differs | partial behavior only |
| Users | `getMyUser` | `GET /users/me` | experimental account build only | experimental native/workerd account and authorization comparisons; foreign-credential status differs | partial behavior only |
| Users | `updateMyUser` | `PATCH /users/me` | experimental account build only | experimental native/workerd account and authorization comparisons; foreign-credential status differs | partial behavior only |
| Users | `listMyIdentityLinks` | `GET /users/me/identity_links` | experimental self-service build only | experimental native/workerd paginated self-service authorization checks; foreign-credential status differs | partial behavior only |
| Users | `listMyPasskeys` | `GET /users/me/passkeys` | experimental passkey build only | experimental native/workerd virtual authenticator checks; foreign-credential status differs | partial behavior only |
| Users | `getMyPasswordState` | `GET /users/me/password` | experimental account build only | experimental native/workerd account and authorization comparisons; foreign-credential status differs | partial behavior only |
| Projects | `listMyProjects` | `GET /users/me/projects` | not mounted | none | native-versus-Worker test needed |
| Users | `getMyUserSchema` | `GET /users/me/schema` | experimental self-service build only | experimental native/workerd paginated self-service authorization checks; foreign-credential status differs | partial behavior only |
| Users | `listMyTeams` | `GET /users/me/teams` | experimental self-service build only | experimental native/workerd paginated self-service authorization checks; foreign-credential status differs | partial behavior only |
| Flows | `createFlow` | `POST /flows` | experimental MVP build only | none | native-versus-Worker test needed |
| Flows | `getFlowStep` | `GET /flows/{flow_id}` | experimental MVP build only | none | native-versus-Worker test needed |
| Flows | `submitFlowStep` | `POST /flows/{flow_id}/submit` | experimental MVP build only | none | native-versus-Worker test needed |
| Authentication Attempts | `createAuthAttempt` | `POST /auth_attempts` | mounted | native/Worker parity harness, application journey | partial behavior only |
| Authentication Attempts | `getAuthAttempt` | `GET /auth_attempts/{attempt_id}` | not mounted | none | native-versus-Worker test needed |
| Authentication Attempts | `createAuthAttemptChallenge` | `POST /auth_attempts/{attempt_id}/challenges` | mounted | native/Worker parity harness, application journey | partial behavior only |
| Authentication Attempts | `verifyAuthAttemptChallenge` | `POST /auth_attempts/{attempt_id}/challenges/{challenge_id}/verify` | mounted | native/Worker parity harness, application journey | partial behavior only |
| Authentication Attempts | `createAuthAttemptHandoff` | `POST /auth_attempts/{attempt_id}/handoff` | mounted | native/Worker parity harness, application journey | partial behavior only |
| Projects | `createProject` | `POST /projects` | not mounted | none | native-versus-Worker test needed |
| Projects | `queryProjects` | `POST /projects/query` | not mounted | none | native-versus-Worker test needed |
| Projects | `getProject` | `GET /projects/{project_id}` | not mounted | none | native-versus-Worker test needed |
| Projects | `updateProject` | `PATCH /projects/{project_id}` | not mounted | none | native-versus-Worker test needed |
| Projects | `listProjectAdmins` | `GET /projects/{project_id}/admins` | not mounted | none | native-versus-Worker test needed |
| Projects | `createProjectClaim` | `POST /projects/{project_id}/claim/init` | not mounted | none | native-versus-Worker test needed |
| Projects | `getProjectClaimStatus` | `GET /projects/{project_id}/claim/status` | not mounted | none | native-versus-Worker test needed |
| Projects | `completeProjectClaim` | `POST /projects/{project_id}/claim/complete` | not mounted | none | native-versus-Worker test needed |
| Projects | `getProjectClaimWindow` | `GET /projects/{project_id}/claim/window` | not mounted | none | native-versus-Worker test needed |
| Projects | `addProjectOrigin` | `POST /projects/{project_id}/origins` | not mounted | none | native-versus-Worker test needed |
| Projects | `removeProjectOrigin` | `POST /projects/{project_id}/origins/remove` | not mounted | none | native-versus-Worker test needed |
| Previews | `listProjectPreviews` | `GET /projects/{project_id}/previews` | not mounted | none | native-versus-Worker test needed |
| Previews | `removeProjectPreview` | `POST /projects/{project_id}/previews/remove` | not mounted | none | native-versus-Worker test needed |
| Sessions | `createSession` | `POST /sessions` | experimental session build only | experimental native/workerd session creation, operator permissions and pagination checks; foreign-credential status differs | partial behavior only |
| Sessions | `querySessions` | `POST /sessions/query` | experimental session build only | experimental native/workerd session creation, operator permissions and pagination checks; foreign-credential status differs | partial behavior only |
| Sessions | `exchangeHandoff` | `POST /sessions/exchange` | mounted | native/Worker parity harness, application journey | partial behavior only |
| Sessions | `getSession` | `GET /sessions/{session_id}` | experimental session build only | experimental native/workerd session creation, operator permissions and pagination checks; foreign-credential status differs | partial behavior only |
| Sessions | `revokeSession` | `DELETE /sessions/{session_id}` | mounted | native/Worker parity harness | partial behavior only |
| Sessions | `getMySession` | `GET /sessions/me` | mounted | native/Worker parity harness, application journey | partial behavior only |
| Sessions | `revokeMySession` | `DELETE /sessions/me` | mounted | application journey | partial behavior only |
| Sessions | `getMySessionCsrfToken` | `GET /sessions/me/csrf` | mounted | application journey | partial behavior only |
| Schemas | `publishSchema` | `POST /schemas` | not mounted | none | native-versus-Worker test needed |
| Schemas | `listSchemas` | `GET /schemas` | not mounted | none | native-versus-Worker test needed |
| Schemas | `getSchema` | `GET /schemas/{schema_id}` | not mounted | none | native-versus-Worker test needed |
| Flow Definitions | `publishFlowDefinition` | `POST /flow_definitions` | not mounted | none | native-versus-Worker test needed |
| Flow Definitions | `listFlowDefinitions` | `GET /flow_definitions` | not mounted | none | native-versus-Worker test needed |
| Flow Definitions | `getFlowDefinition` | `GET /flow_definitions/{flow_definition_id}` | not mounted | none | native-versus-Worker test needed |
| Teams | `createTeam` | `POST /teams` | experimental team build only | experimental native/workerd team authorization and mutation-audit checks; cross-object grants unproven | partial behavior only |
| Teams | `queryTeams` | `POST /teams/query` | experimental team build only | experimental native/workerd team authorization and mutation-audit checks; cross-object grants unproven | partial behavior only |
| Teams | `getTeam` | `GET /teams/{team_id}` | experimental team build only | experimental native/workerd team authorization and mutation-audit checks; cross-object grants unproven | partial behavior only |
| Teams | `deactivateTeam` | `DELETE /teams/{team_id}` | experimental team build only | experimental native/workerd team authorization and mutation-audit checks; cross-object grants unproven | partial behavior only |
| Teams | `updateTeam` | `PATCH /teams/{team_id}` | experimental team build only | experimental native/workerd team authorization and mutation-audit checks; cross-object grants unproven | partial behavior only |
| Search | `search` | `POST /search` | not mounted | none | native-versus-Worker test needed |
| Branding | `publishBranding` | `POST /branding` | not mounted | none | native-versus-Worker test needed |
| Branding | `listBranding` | `GET /branding` | not mounted | none | native-versus-Worker test needed |
| Branding | `getBranding` | `GET /branding/{branding_id}` | not mounted | none | native-versus-Worker test needed |
| OAuth Settings | `getOAuthSettings` | `GET /oauth_settings/{oauth_settings_id}` | not mounted | none | native-versus-Worker test needed |
| Identity Providers | `publishIdp` | `POST /idps` | not mounted | none | native-versus-Worker test needed |
| Identity Providers | `queryIdps` | `POST /idps/query` | not mounted | none | native-versus-Worker test needed |
| Identity Providers | `getIdp` | `GET /idps/{idp_id}` | not mounted | none | native-versus-Worker test needed |
| Identity Providers | `listIdpRevisions` | `GET /idps/{idp_id}/revisions` | not mounted | none | native-versus-Worker test needed |
| Identity Providers | `getIdpRevision` | `GET /idps/revisions/{revision_id}` | not mounted | none | native-versus-Worker test needed |
| Applications | `publishApplication` | `POST /applications` | not mounted | none | native-versus-Worker test needed |
| Applications | `getApplication` | `GET /applications/{application_id}` | not mounted | none | native-versus-Worker test needed |
| Policies | `listPolicies` | `GET /policies` | not mounted | none | native-versus-Worker test needed |
| Policies | `publishPolicy` | `POST /policies` | not mounted | none | native-versus-Worker test needed |
| Policies | `evaluatePolicy` | `POST /policies/evaluate` | not mounted | none | native-versus-Worker test needed |
| Policies | `getPolicy` | `GET /policies/{policy_id}` | not mounted | none | native-versus-Worker test needed |
| Policies | `listPolicyRevisions` | `GET /policies/{policy_id}/revisions` | not mounted | none | native-versus-Worker test needed |
| Policies | `getPolicyRevision` | `GET /policies/revisions/{revision_id}` | not mounted | none | native-versus-Worker test needed |
| Releases | `createRelease` | `POST /releases` | not mounted | none | native-versus-Worker test needed |
| Releases | `listReleases` | `GET /releases` | not mounted | none | native-versus-Worker test needed |
| Releases | `buildRelease` | `POST /releases/build` | not mounted | none | native-versus-Worker test needed |
| Releases | `getRelease` | `GET /releases/{release_id}` | not mounted | none | native-versus-Worker test needed |
| Releases | `revokeRelease` | `POST /releases/{release_id}/revoke` | not mounted | none | native-versus-Worker test needed |
| Grants | `createGrant` | `POST /grants` | not mounted | none | native-versus-Worker test needed |
| Grants | `queryGrants` | `POST /grants/query` | not mounted | none | native-versus-Worker test needed |
| Grants | `getGrant` | `GET /grants/{grant_id}` | not mounted | none | native-versus-Worker test needed |
| Grants | `deleteGrant` | `DELETE /grants/{grant_id}` | not mounted | none | native-versus-Worker test needed |
| Invitations | `createInvitation` | `POST /invitations` | experimental invitation build only | experimental native/workerd invitation admin and audit checks; claim and cross-object authorization unproven | partial behavior only |
| Invitations | `listInvitations` | `GET /invitations` | experimental invitation build only | experimental native/workerd invitation admin and audit checks; claim and cross-object authorization unproven | partial behavior only |
| Invitations | `lookupInvitation` | `POST /invitations/lookup` | not mounted | none | native-versus-Worker test needed |
| Invitations | `acceptInvitation` | `POST /invitations/accept` | not mounted | none | native-versus-Worker test needed |
| Invitations | `rejectInvitation` | `POST /invitations/reject` | not mounted | none | native-versus-Worker test needed |
| Invitations | `getInvitation` | `GET /invitations/{invitation_id}` | experimental invitation build only | experimental native/workerd invitation admin and audit checks; claim and cross-object authorization unproven | partial behavior only |
| Invitations | `cancelInvitation` | `DELETE /invitations/{invitation_id}` | experimental invitation build only | experimental native/workerd invitation admin and audit checks; claim and cross-object authorization unproven | partial behavior only |
| Events | `listEvents` | `GET /events` | experimental events build only | experimental native/workerd authorization and pagination checks | partial behavior only |
| Events | `getEvent` | `GET /events/{event_id}` | experimental events build only | experimental native/workerd authorization and pagination checks | partial behavior only |
| Variables | `listVariables` | `GET /variables` | not mounted | none | native-versus-Worker test needed |
| Variables | `setVariables` | `PATCH /variables` | not mounted | none | native-versus-Worker test needed |
| Variables | `getVariable` | `GET /variables/{variable_name}` | not mounted | none | native-versus-Worker test needed |
| Variables | `deleteVariable` | `DELETE /variables/{variable_name}` | not mounted | none | native-versus-Worker test needed |
| Deployments | `createDeployment` | `POST /deployments` | not mounted | none | native-versus-Worker test needed |
| Deployments | `listDeployments` | `GET /deployments` | not mounted | none | native-versus-Worker test needed |
| Deployments | `getDeployment` | `GET /deployments/{deployment_id}` | not mounted | none | native-versus-Worker test needed |
| Deployments | `rollbackDeployment` | `POST /deployments/{deployment_id}/rollback` | not mounted | none | native-versus-Worker test needed |
| Deployments | `listDeploymentVariables` | `GET /deployments/{deployment_id}/variables` | not mounted | none | native-versus-Worker test needed |

## Other native HTTP and runtime surfaces

These are not all represented as separate operations in the bundled OpenAPI document. Their MaPi parity coverage is pending.

| Surface | Native behavior | MaPi gap |
| --- | --- | --- |
| Resource API aliases | `/api/v1` and root aliases, deprecation and link headers, legacy `/flow` aliases and deployment target compatibility | Headers and alias behavior need native comparison |
| OpenAPI and probes | `/api/v1/openapi.json`, `/livez`, `/readyz` and API-prefixed probes | GET probes and OpenAPI document compared through adapter; default ingress, error cases, and readiness failure still need coverage |
| Console | Configurable Console asset path and `/console/runtime.json` | Upstream Console and runtime bootstrap need porting and browser tests |
| External IdP callbacks | `/idp/{slug}/callback` and `/__nextgen/idp/{slug}/callback` | Callback, binding, egress and provider failure tests needed |
| Retention and security reports | Optional `/cron/events-retention` and `/csp-report` | Scheduling, authorization and report handling need tests |
| OAuth/OIDC issuer scaffolding | Optional metadata routes and `/oauth` handlers | v0.7.0 denies issuer admission and its OP server is unimplemented. The MVP issuer is an additional extension and needs protocol conformance tests |

## Upstream acceptance suites

| Suite | Upstream source | MaPi evidence gap |
| --- | --- | --- |
| Browser journeys | [e2e/journey](https://github.com/zitadel/nextgen/tree/b0b74cd4a198428ea9b82910c217259ffc62b65c/e2e/journey) | Official component journeys against MaPi are not yet run |
| Console | [e2e/console](https://github.com/zitadel/nextgen/tree/b0b74cd4a198428ea9b82910c217259ffc62b65c/e2e/console) | Console suites against MaPi are not yet run |
| CLI | [e2e/cli](https://github.com/zitadel/nextgen/tree/b0b74cd4a198428ea9b82910c217259ffc62b65c/e2e/cli) | Upstream CLI deployment suite against MaPi is not yet run |
| SDKs | [conformance](https://github.com/zitadel/nextgen/tree/b0b74cd4a198428ea9b82910c217259ffc62b65c/conformance) | Framework and SDK conformance against MaPi is not yet run |

## Draft and extension capabilities

| Capability | Pinned status | MaPi follow-up |
| --- | --- | --- |
| OAuth/OIDC provider | [ADR 082](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/docs/adrs/082-oauth-and-oidc-server.md) describes the intended protocol profile. Server wiring denies admission and the provider handlers are unimplemented. | Deliver and test the MVP issuer as an extension. |
| TOTP, recovery codes, and password recovery | [ADR 038](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/docs/adrs/038-user-credential-migration-and-recovery.md) is proposed. Storage or domain types alone do not establish a shipped user journey. | Check the public contract at the selected pin before classifying each journey as parity or an extension. |
| Notifications and background jobs | The release and shipped server behavior must be verified independently for each channel and job. | Classify each delivered job or notification as parity and planned additions as extensions. |

The current MaPi evidence is in `scripts/parity.mjs`, `scripts/test-worker.mjs`, `scripts/test-app.mjs`, and `scripts/test-browser.mjs`. Hosted results and their limits are recorded in `REPORT.md`.
