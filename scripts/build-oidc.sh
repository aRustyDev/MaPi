#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/build.sh
output="$PWD/worker/generated/nextgen-oidc.wasm"
cd .mapi/nextgen/apps/api
GOWORK=off GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 GOTOOLCHAIN=go1.26.9 \
  go build -tags mapi_flow,mapi_oauth -trimpath -ldflags='-s -w' -buildmode=c-shared -o "$output" ./cmd/mapi-wasm
