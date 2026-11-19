# Isolated hosted recovery rehearsal

Source archive: MaPi `12555ef02d60d5ee76f328319dc988db75fc6833`, pinned Nextgen `b0b74cd4a198428ea9b82910c217259ffc62b65c`. Scripts in `scripts/phase0-{config,instrument,hosted-recovery}.mjs` and `scripts/phase0-timed-recovery.sh` are test-only; `phase0-instrument.patch` records the deployed temporary diff. The instrumentation adds an operator-authenticated endpoint that mints/exchanges a synthetic handoff and counts users and events; it is neither part of the clean baseline nor suitable for normal deployment. It is gated by the operator secret and a dedicated variable. Use a new Worker name and isolated namespaces only. Never run this against existing deployments. Its local state file contains credentials, cookies and a bookmark; do not publish it.

In a clean checkout, after `npm ci`, `npm run build`, `npm run baseline`, copying the Phase 0 scripts as described in the [baseline](phase-0-baseline.md), and selecting an authenticated account, choose two new Worker names. Use the account's workers.dev subdomain. Check each name before deploying; an API error `10007` saying that Worker does not exist establishes absence for the selected account. An authentication, network or other error does not. If either exists, choose another name.

```sh
export MAPI_PHASE0_ACCOUNT=YOUR_ACCOUNT_ID
export CLOUDFLARE_ACCOUNT_ID="$MAPI_PHASE0_ACCOUNT"
export MAPI_PHASE0_NAME=mapi-phase0-replace-with-unique-app
export MAPI_PHASE0_POC_NAME=mapi-phase0-replace-with-unique-poc
export MAPI_PHASE0_SUBDOMAIN=YOUR_WORKERS_DEV_SUBDOMAIN
npx wrangler deployments list --name "$MAPI_PHASE0_NAME" --json
npx wrangler deployments list --name "$MAPI_PHASE0_POC_NAME" --json
node scripts/phase0-config.mjs
npm run prepare:app-staging
npx wrangler deploy --config wrangler.phase0-app.json --dry-run
npx wrangler deploy --config wrangler.phase0-app.json --secrets-file .mapi/app-staging-secrets.json
export MAPI_URL="https://${MAPI_PHASE0_NAME}.${MAPI_PHASE0_SUBDOMAIN}.workers.dev"
export MAPI_OPERATOR_TOKEN="$(node -p "require('./.mapi/app-staging-secrets.json').MAPI_OPERATOR_TOKEN")"
node scripts/mapi.mjs admin status
npm run test:app
```

Names and subdomain must be lowercase. Save the newly generated secrets securely. Record the clean deployment's version ID as `CLEAN_VERSION`. Before provisioning, status should show `ready=false` and `schemaVersion=2`.

Run the following after setting `CLEAN_VERSION` to the version recorded above. Record the instrumented deploy's version as `PROOF_VERSION`, and set a new, never reused recovery epoch before the timed script.

```sh
node scripts/phase0-instrument.mjs
node -e 'const fs=require("fs"),p="wrangler.phase0-app.json",x=JSON.parse(fs.readFileSync(p));x.vars.MAPI_PHASE0_PROOF="1";fs.writeFileSync(p,JSON.stringify(x,null,2)+"\n")'
npx wrangler deploy --config wrangler.phase0-app.json --secrets-file .mapi/app-staging-secrets.json
node scripts/phase0-hosted-recovery.mjs setup
npx wrangler rollback "$CLEAN_VERSION" --config wrangler.phase0-app.json --yes
node scripts/phase0-hosted-recovery.mjs rollback-check
npx wrangler rollback "$PROOF_VERSION" --config wrangler.phase0-app.json --yes
export MAPI_RECOVERY_EPOCH=YOUR_NEW_UNIQUE_RECOVERY_EPOCH
scripts/phase0-timed-recovery.sh
```

The timed script bookmarks with a pending handoff, creates a later synthetic user, deploys maintenance, requests restore, checks restored counts, invokes recover and checks audit/epoch, reopens traffic, and tests both cookies and the handoff. It rejects a result reached after the pinned one-minute handoff expiry. If it fails, leave maintenance enabled or confirm recovery readiness before reopening; do not reuse an epoch.

Finally restore clean `worker/app.js` from the source commit, remove the proof and maintenance flags, retain the fresh epoch, and deploy:

```sh
git show 12555ef02d60d5ee76f328319dc988db75fc6833:worker/app.js > worker/app.js
node -e 'const fs=require("fs"),p="wrangler.phase0-app.json",x=JSON.parse(fs.readFileSync(p));delete x.vars.MAPI_PHASE0_PROOF;delete x.vars.MAPI_MAINTENANCE;fs.writeFileSync(p,JSON.stringify(x,null,2)+"\n")'
npx wrangler deploy --config wrangler.phase0-app.json --secrets-file .mapi/app-staging-secrets.json
node scripts/mapi.mjs admin status
```

Confirm status has `ready` and `recoveryReady` true and the temporary endpoint returns 404. Do not roll back to the original configuration after restoring: it lacks the current recovery epoch. Script and config files are sanitized; `.mapi/phase0-recovery-state.json` and secret files are not.

For the shared fixture Worker, after generating and testing the single native fixture with `npm run test:baseline`, run:

```sh
npm run prepare:staging
npx wrangler deploy --config wrangler.phase0-poc.json --dry-run
npx wrangler deploy --config wrangler.phase0-poc.json --secrets-file .mapi/staging-secrets.json
MAPI_WORKER_URL="https://${MAPI_PHASE0_POC_NAME}.${MAPI_PHASE0_SUBDOMAIN}.workers.dev" npm run test:worker
```

It uses the same private fixture and gate secret. Keep these files private. The Worker has its own fresh namespace and does not use the application namespace.
