#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# The regular build checks out the pinned revision and installs the overlay.
bash scripts/build.sh
output="$PWD/worker/generated/nextgen-flow.wasm"
cd .mapi/nextgen/apps/api
GOWORK=off GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 GOTOOLCHAIN=go1.26.9 \
  go build -tags mapi_flow -trimpath -ldflags='-s -w' -buildmode=c-shared -o "$output" ./cmd/mapi-wasm
