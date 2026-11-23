# Synthetic hosted relocation rehearsal

This is the original reviewable procedure, not permission to deploy. It targets newly generated Worker names and namespaces only. Keep the existing Woven owner and its namespaces out of every binding. Later isolated hosted runs and their remaining gaps are recorded in `phase1-hosted-handoff-repeat.md` and `phase1-hosted-restart-rehearsal.md`; statements below about mocked or unmeasured evidence describe the original preparation, not those later runs. They do not establish sign-off for current source or authorize a real move.

From the implementation checkout, build the candidate and run the local prerequisites:

```sh
npm run baseline
npm run build:login-assets
npm run build:phase1-owner
node scripts/test-relocation-manifest.mjs
node scripts/test-relocation-rehearsal-provenance.mjs
node scripts/test-relocation-rehearsal-control.mjs
node scripts/test-relocation-rehearsal-fixture.mjs
node scripts/test-rehearsal-management.mjs
node scripts/test-relocation-rehearsal.mjs
```

The candidate's generated Wasm manifest records its hash. The current local real-owner rehearsal also needs to pass after the final build. Preserve the resulting build, test and hash records; do not assume a dirty checkout corresponds to its Git commit alone.

Set `CLOUDFLARE_ACCOUNT_ID` to the intended account and `MAPI_REHEARSAL_WORKERS_SUBDOMAIN` to its workers.dev subdomain. Choose a **new nonexistent** path in `MAPI_REHEARSAL_DIR`, outside the shared checkout. These commands create files only:

```sh
node scripts/relocation-rehearsal-config.mjs "$MAPI_REHEARSAL_DIR"
node scripts/relocation-rehearsal-secrets.mjs "$MAPI_REHEARSAL_DIR"
```

The generated owner, router and control names share a fresh 128-bit random suffix. The caller is local only. Owner `MAPI_RELOCATION_ENABLED` and `MAPI_FENCE_WRITERS_DRAINED`, and control `MAPI_REHEARSAL_SYNTHETIC_ONLY`, are `0`; all configurations request 100% invocation logs. No generated binding names an existing Worker. The secret directory is mode 0700 and its files are mode 0600. `owner.json` contains a fresh master key, application operator token, relocation token and Phase 1 control token; `control.json` contains the matching relocation and Phase 1 control tokens and a different control operator token; `operator.env` contains the two operator tokens for local commands. Keep these files private, preserve the master key securely for this disposable deployment, and do not print them or use shell tracing.

Refresh the existing Wrangler OAuth session using the project-local CLI, or supply a separate read-only account API token. For the existing macOS Wrangler session, point the checker at the protected OAuth config; it reads the token in-process and does not print it:

```sh
node_modules/.bin/wrangler whoami --account "$CLOUDFLARE_ACCOUNT_ID"
export MAPI_REHEARSAL_WRANGLER_OAUTH_PATH="$HOME/Library/Preferences/.wrangler/config/default.toml"
node scripts/relocation-rehearsal-provenance.mjs "$MAPI_REHEARSAL_DIR" before
```

The `before` inventory must show no generated names or namespaces. This read-only path passed against Woven with a fresh generated name; it enumerated 22 Worker scripts and 19 namespaces on one page. Re-run it immediately before any future creation. Save the mode-0600 report with the configs. Check the complete owner bundle without creating a Worker:

```sh
node_modules/.bin/wrangler deploy --config "$MAPI_REHEARSAL_DIR/owner.json" --dry-run --outdir "$MAPI_REHEARSAL_DIR/dry-owner"
node_modules/.bin/wrangler deploy --config "$MAPI_REHEARSAL_DIR/router.json" --dry-run --outdir "$MAPI_REHEARSAL_DIR/dry-router"
node_modules/.bin/wrangler deploy --config "$MAPI_REHEARSAL_DIR/control.json" --dry-run --outdir "$MAPI_REHEARSAL_DIR/dry-control"
```

**Stop for review here.** Once a separate authorization has been given for disabled synthetic creation, the exact creation commands are below. They create only the randomly named Workers, not the caller; no movement is enabled. Confirm each displayed Worker name matches `manifest.json` before executing it.

```sh
node_modules/.bin/wrangler deploy --config "$MAPI_REHEARSAL_DIR/owner.json" --secrets-file "$MAPI_REHEARSAL_DIR/secrets/owner.json"
node_modules/.bin/wrangler deploy --config "$MAPI_REHEARSAL_DIR/router.json"
node_modules/.bin/wrangler deploy --config "$MAPI_REHEARSAL_DIR/control.json" --secrets-file "$MAPI_REHEARSAL_DIR/secrets/control.json"
```

Record the reviewed active version UUIDs for each Worker in mode-0600 `approved-versions.json` with the keys `owner`, `router`, and `control`. Obtain the deployment records read-only with:

```sh
node_modules/.bin/wrangler deployments list --json --config "$MAPI_REHEARSAL_DIR/owner.json"
node_modules/.bin/wrangler deployments list --json --config "$MAPI_REHEARSAL_DIR/router.json"
node_modules/.bin/wrangler deployments list --json --config "$MAPI_REHEARSAL_DIR/control.json"
node scripts/relocation-rehearsal-provenance.mjs "$MAPI_REHEARSAL_DIR" after
node scripts/relocation-rehearsal-provenance.mjs "$MAPI_REHEARSAL_DIR" after codehash
```

The checker verifies the generated names, namespace IDs not present in the before record, three SQLite owner classes, matching approved 100% active versions, active version bindings, no deployed caller, no control route, disabled control workers.dev and preview URLs, and invocation logging settings. It fails closed on incomplete metadata. **The after-deployment response shapes are mocked and have not been verified with a newly created Cloudflare Worker.** The check does not prove global version propagation; independently verify that all writer instances run the fence-aware build before enabling a move.

Only after the disabled deployment is reviewed and its provenance passes, load `operator.env` without echoing it and run `node scripts/relocation-rehearsal-fixture.mjs "$MAPI_REHEARSAL_DIR" prepare`. It creates the disposable legacy singleton and a second project, users, an active session, a revoked session and a pending handoff. The file `fixture.private.json` contains their credentials and must remain private. Generate, but do not deploy, the exact enabled config candidates with `node scripts/relocation-rehearsal-enable-config.mjs "$MAPI_REHEARSAL_DIR"`. These bind the fixed fixture IDs and origins, enable relocation and `MAPI_PHASE1_ALLOW_BOOTSTRAP=1`; the private control uses the latter to initialize the other project's fence before obtaining its Go-backed management token. Review both files. Deploy the enabled owner and control as **new versions** only after independently confirming the writer drain.

Record the reviewed new version UUIDs in `MAPI_ENABLED_OWNER_VERSION` and `MAPI_ENABLED_CONTROL_VERSION`, then run `node scripts/relocation-rehearsal-approve-enabled.mjs "$MAPI_REHEARSAL_DIR"` and `node scripts/relocation-rehearsal-provenance.mjs "$MAPI_REHEARSAL_DIR" enabled`. These read-only/local commands require the exact allowed config changes, fixed synthetic identities, unchanged owner/control/router script etags from the disabled deployment, the unchanged router version and namespace IDs, 100% active reviewed versions, required secret-binding names, enabled flags, logs and private routing. They also compare the local owner Wasm hash with its recorded build manifest. **That local Wasm comparison is not proof of the deployed Wasm bytes**; Cloudflare's script etag and the local Wasm hash are separate evidence. The verification is a point-in-time account observation and does not prove rollout to every location or prevent a later deployment. The control and driver require a matching enabled report generated within five minutes before starting; to refresh it, rerun the provenance command with a unique suffix and set `MAPI_REHEARSAL_ENABLED_REPORT` to the corresponding `provenance-enabled-<suffix>.json` basename.

Run a loopback-only local caller whose remote service binding points to the fresh no-route control Worker. Set `MAPI_REHEARSAL_CONTROL_URL` and `MAPI_REHEARSAL_OPERATOR_TOKEN`, then run `node scripts/get-rehearsal-management-token.mjs "$MAPI_REHEARSAL_DIR"`. It uses the private, fixed-second-project control route and saves the token in mode-0600 `secrets/management.env`; load it without echoing it. Set `MAPI_REHEARSAL_FIXTURE` to `fixture.private.json`, `MAPI_REHEARSAL_VERIFY_EVIDENCE=1` and `MAPI_REHEARSAL_VERIFY_STALE=1`, then run `node scripts/advance-rehearsal.mjs`. It overlaps each move step with one second-project Go management read, reads the durable users/events digest journal after completion, and probes the retired singleton with a stale route. Save output and platform limit-error telemetry securely. Run `node scripts/relocation-rehearsal-fixture.mjs "$MAPI_REHEARSAL_DIR" verify` to check the original project ID, active and revoked sessions, exactly one exchange of the pending handoff, user credentials, a post-cutover user write and cross-project rejection. If the handoff expires before verification, the test fails; an expired token is not evidence of a successful move.

The four-Worker local rehearsal passed 119 concurrent, alternating Go `GetUser` and `QueryUsers` reads during 119 coordinator advances, five other-project logins, a pending handoff exchanged exactly once, the durable user/audit digest journal, stale-source rejection, active and revoked sessions and a post-cutover user write. Its source fixture had 31 historical audit rows. A client restart at import, reconciliation and committed checkpoints is covered locally; explicit owner/coordinator eviction and interruption after activation are covered by the separate local real-owner test. This is still not hosted sign-off: the enabled-version checker has only mocked coverage, and actual hosted handoff, management traffic, limit telemetry and interruption after activation remain unmeasured. Never substitute a successful disabled deploy for those results or use this procedure on the real singleton.
