#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: build.sh <upstream Hydra checkout> <output directory>" >&2
  exit 2
fi

spike_dir=$(cd "$(dirname "$0")" && pwd -P)
upstream=$(cd "$1" && pwd -P)
mkdir -p "$2"
output=$(cd "$2" && pwd -P)
pin=0b84568fffccf151dc5e6c7955fdfb738555bf4b
test "$(git -C "$upstream" rev-parse 'v26.2.0^{commit}')" = "$pin"

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/source"
git -C "$upstream" archive "$pin" | tar -x -C "$scratch/source"
source_dir="$scratch/source"
go_runtime=$(GOTOOLCHAIN=go1.26.9 go env GOROOT)
go_command="$go_runtime/bin/go"
export GOTOOLCHAIN=local
export GOMODCACHE="${MAPI_HYDRA_MODULE_CACHE:-$output/go-mod}"
export GOCACHE="${MAPI_HYDRA_GO_CACHE:-$output/go-cache}"
"$go_command" -C "$source_dir" mod download github.com/docker/go-connections
docker_module=$("$go_command" -C "$source_dir" list -mod=readonly -m -f '{{.Dir}}' github.com/docker/go-connections)
cp -R "$docker_module" "$scratch/docker-connections"
chmod -R u+w "$scratch/docker-connections"
"$go_command" -C "$source_dir" mod edit -replace "github.com/docker/go-connections=$scratch/docker-connections"

# These optional native integrations are outside the Worker experiment.
python3 - "$source_dir" "$scratch/docker-connections" <<'PY'
from pathlib import Path
import sys

source, docker = map(Path, sys.argv[1:])
jaeger = source / "oryx/otelx/jaeger.go"
assert "func SetupJaeger" in jaeger.read_text()
jaeger.write_text("""// Copyright © 2023 Ory Corp
// SPDX-License-Identifier: Apache-2.0
package otelx

import (
    "errors"
    "go.opentelemetry.io/otel/trace"
)

func SetupJaeger(_ *Tracer, _ string, _ *Config) (trace.Tracer, error) {
    return nil, errors.New("Jaeger UDP is unavailable in the Worker spike")
}
""")
sockets = docker / "sockets/sockets.go"
content = sockets.read_text()
assert content.count("func configureUnixTransport(") == 1
content = content.split("func configureUnixTransport(", 1)[0]
for name in ("context", "fmt", "syscall"):
    content = content.replace(f'\t"{name}"\n', "")
content = content.replace("\n\tmaxUnixSocketPathSize = len(syscall.RawSockaddrUnix{}.Path)", "")
sockets.write_text(content + "func configureUnixTransport(*http.Transport, string, string) error { return ErrProtocolNotAvailable }\n")

# A request-scoped registry gets one start attempt. The host bounds socket I/O.
registry = source / "driver/registry_sql.go"
content = registry.read_text()
changes = {
    "resilience.Retry(m.l, 5*time.Second, 5*time.Minute, c.Open)": "c.Open()",
    "m.initialPing(ctx, m.Logger(), m.basePersister)": "m.basePersister.Ping(ctx)",
}
for old, new in changes.items():
    assert content.count(old) == 1, old
    content = content.replace(old, new)
registry.write_text(content)

# Install the fence at the only token-response write boundary. Keep the
# attempt receipt on the same transaction context as Hydra's token writes.
handler = source / "oauth2/handler.go"
content = handler.read_text()
changes = {
    "\tvar accessResponse fosite.AccessResponder\n\tif err := h.r.Transaction(ctx, func(ctx context.Context) (err error) {\n\t\taccessResponse, err = h.r.OAuth2Provider().NewAccessResponse(ctx, accessRequest)":
    """	fence := phase0RefreshFence(ctx, accessRequest)
	if fence != nil {
		if err := phase0FenceError(fence.Begin(ctx, accessRequest.GetID(), accessRequest.GetRequestForm().Get("refresh_token"))); err != nil {
			h.r.OAuth2Provider().WriteAccessError(ctx, w, accessRequest, err)
			return
		}
	}
	var accessResponse fosite.AccessResponder
	if err := h.r.Transaction(ctx, func(ctx context.Context) (err error) {
		if fence != nil {
			if err := phase0FenceError(fence.Receipt(ctx)); err != nil {
				return err
			}
		}
		accessResponse, err = h.r.OAuth2Provider().NewAccessResponse(ctx, accessRequest)
		if err == nil && fence != nil {
			err = phase0FenceError(true, fence.BeforeCommit())
		}""",
    "\th.r.OAuth2Provider().WriteAccessResponse(ctx, w, accessRequest, accessResponse)\n}":
    """	if fence != nil {
		if err := phase0FenceError(fence.Release(ctx)); err != nil {
			h.r.OAuth2Provider().WriteAccessError(ctx, w, accessRequest, err)
			return
		}
	}
	h.r.OAuth2Provider().WriteAccessResponse(ctx, w, accessRequest, accessResponse)
}""",
}
for old, new in changes.items():
    assert content.count(old) == 1, old
    content = content.replace(old, new)
handler.write_text(content)
PY

mkdir -p "$source_dir/cmd/mapi-phase0"
cp "$spike_dir/"{main,fence,code}.go "$source_dir/cmd/mapi-phase0/"
cp "$spike_dir/routes.go.in" "$source_dir/oauth2/mapi_phase0_routes.go"
cp "$spike_dir/authorization.go.in" "$source_dir/oauth2/mapi_phase0_authorization.go"
cp "$spike_dir/consent.go.in" "$source_dir/consent/mapi_phase0_consent.go"
cp "$spike_dir/jwks.go.in" "$source_dir/jwk/mapi_phase0_jwks.go"
CGO_ENABLED=0 GOOS=js GOARCH=wasm "$go_command" -C "$source_dir" build -mod=readonly \
  -ldflags="-s -w -buildid=" -o "$output/hydra-phase0.wasm" ./cmd/mapi-phase0
install -m 0644 "$go_runtime/lib/wasm/wasm_exec.js" "$output/wasm_exec.js"
cp "$spike_dir/"{runtime,worker,session-fence}.mjs "$output/"
if [[ -n "${MAPI_HYDRA_WASM_OPT:-}" ]]; then
  "$MAPI_HYDRA_WASM_OPT" --version | grep -Eq 'version 133($| )'
  "$MAPI_HYDRA_WASM_OPT" --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int \
    --vacuum --remove-unused-module-elements -O1 \
    "$output/hydra-phase0.wasm" -o "$output/hydra-phase0.optimized.wasm"
  mv "$output/hydra-phase0.optimized.wasm" "$output/hydra-phase0.wasm"
fi
node --input-type=module -e 'import { readFileSync } from "node:fs";
const data = readFileSync(process.argv[1]);
if (!WebAssembly.validate(data)) throw new Error("invalid WASM for this JavaScript runtime");' "$output/hydra-phase0.wasm"
wc -c "$output/hydra-phase0.wasm"
