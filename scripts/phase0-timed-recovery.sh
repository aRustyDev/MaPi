#!/usr/bin/env bash
set -euo pipefail
: "${MAPI_URL:?}" "${MAPI_OPERATOR_TOKEN:?}" "${MAPI_RECOVERY_EPOCH:?}"
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-/tmp/mapi-phase0-wrangler.log}" WRANGLER_SEND_METRICS=false
node scripts/phase0-hosted-recovery.mjs bookmark
node -e 'const fs=require("fs"),p="wrangler.phase0-app.json",x=JSON.parse(fs.readFileSync(p));x.vars.MAPI_MAINTENANCE="1";x.vars.MAPI_RECOVERY_EPOCH=process.env.MAPI_RECOVERY_EPOCH;fs.writeFileSync(p,JSON.stringify(x,null,2));'
./node_modules/.bin/wrangler deploy --config wrangler.phase0-app.json --secrets-file .mapi/app-staging-secrets.json
node scripts/phase0-hosted-recovery.mjs restore
node scripts/phase0-hosted-recovery.mjs recover
node -e 'const fs=require("fs"),p="wrangler.phase0-app.json",x=JSON.parse(fs.readFileSync(p));delete x.vars.MAPI_MAINTENANCE;fs.writeFileSync(p,JSON.stringify(x,null,2));'
./node_modules/.bin/wrangler deploy --config wrangler.phase0-app.json --secrets-file .mapi/app-staging-secrets.json
node scripts/phase0-hosted-recovery.mjs verify
