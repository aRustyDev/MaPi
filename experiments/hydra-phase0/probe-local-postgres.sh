#!/bin/bash
set -euo pipefail
fixture=$(mktemp -d "${TMPDIR:-/tmp}/mapi-hydra-check.XXXXXX")
hydra=${1:?usage: probe-local-postgres.sh HYDRA_BINARY BUILD_DIRECTORY}
build=${2:?usage: probe-local-postgres.sh HYDRA_BINARY BUILD_DIRECTORY}
container="mapi-hydra-check-$$"
server_pid=''
cleanup() { if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi; docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$fixture"; }
trap cleanup EXIT
password=$(openssl rand -hex 24)
system_secret=$(openssl rand -hex 32)
client_secret=$(openssl rand -hex 32)
chmod 700 "$fixture"
printf 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=%s\n' "$password" > "$fixture/local-postgres.env"
printf '%s\n' "$system_secret" > "$fixture/local-hydra-system-secret"
printf '%s\n' "$client_secret" > "$fixture/local-hydra-client-secret"
docker run -d --name "$container" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=mapi_spike -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
port=$(docker port "$container" 5432/tcp | awk -F: '{print $NF}')
for i in $(seq 1 40); do if docker exec "$container" pg_isready -U postgres -d mapi_spike >/dev/null 2>&1; then break; fi; sleep 1; done
export DSN="postgres://postgres:$password@127.0.0.1:$port/mapi_spike?sslmode=disable" SECRETS_SYSTEM="$system_secret" URLS_SELF_ISSUER=https://hydra-phase0.invalid SERVE_ADMIN_HOST=127.0.0.1 SERVE_PUBLIC_HOST=127.0.0.1 SERVE_ADMIN_PORT=46345 SERVE_PUBLIC_PORT=46344 URLS_LOGIN=http://127.0.0.1:46344/fixture-login URLS_CONSENT=http://127.0.0.1:46344/fixture-consent
"$hydra" migrate sql up -e -y > "$fixture/migrate.log" 2>&1
"$hydra" serve all --dev > "$fixture/hydra.log" 2>&1 &
server_pid=$!
for i in $(seq 1 40); do if curl -sS -o /dev/null http://127.0.0.1:46345/health/ready 2>/dev/null; then break; fi; sleep 1; done
"$hydra" create oauth2-client -e http://127.0.0.1:46345 --id mapi-phase0-local-cc --secret "$client_secret" --grant-type client_credentials --scope probe --token-endpoint-auth-method client_secret_basic --format json > "$fixture/client.json"
node experiments/hydra-phase0/probe-local.mjs "$build" "$fixture" "$port" workerd
