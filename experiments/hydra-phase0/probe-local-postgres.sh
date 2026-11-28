#!/bin/bash
set -euo pipefail

hydra=${1:?usage: probe-local-postgres.sh HYDRA_BINARY BUILD_DIRECTORY}
build=${2:?usage: probe-local-postgres.sh HYDRA_BINARY BUILD_DIRECTORY}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/mapi-hydra-check.XXXXXX")
container_id=''
server_pid=''

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ -n "$container_id" ]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT

password=$(openssl rand -hex 24)
system_secret=$(openssl rand -hex 32)
client_secret=$(openssl rand -hex 32)
chmod 700 "$fixture"
printf 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=%s\n' "$password" > "$fixture/local-postgres.env"
printf '%s\n' "$system_secret" > "$fixture/local-hydra-system-secret"
printf '%s\n' "$client_secret" > "$fixture/local-hydra-client-secret"

container_id=$(docker run --rm -d -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=mapi_spike -p 127.0.0.1::5432 postgres:17-alpine)
port=$(docker port "$container_id" 5432/tcp | awk -F: '{print $NF}')
for i in $(seq 1 40); do
  if docker exec "$container_id" pg_isready -U postgres -d mapi_spike >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Reserve distinct ephemeral ports while selecting them. Hydra must subsequently
# own the admin port before any client is created, even if another process races.
ports=$(python3 - <<'PY'
import socket

with socket.socket() as admin, socket.socket() as public:
    admin.bind(("127.0.0.1", 0))
    public.bind(("127.0.0.1", 0))
    print(admin.getsockname()[1], public.getsockname()[1])
PY
)
read -r admin_port public_port <<< "$ports"
export DSN="postgres://postgres:$password@127.0.0.1:$port/mapi_spike?sslmode=disable"
export SECRETS_SYSTEM="$system_secret" URLS_SELF_ISSUER=https://hydra-phase0.invalid
export SERVE_ADMIN_HOST=127.0.0.1 SERVE_PUBLIC_HOST=127.0.0.1
export SERVE_ADMIN_PORT="$admin_port" SERVE_PUBLIC_PORT="$public_port"
export URLS_LOGIN="http://127.0.0.1:$public_port/fixture-login"
export URLS_CONSENT="http://127.0.0.1:$public_port/fixture-consent"

"$hydra" migrate sql up -e -y > "$fixture/migrate.log" 2>&1
"$hydra" serve all --dev > "$fixture/hydra.log" 2>&1 &
server_pid=$!
ready=false
for i in $(seq 1 40); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Hydra exited before its admin service was ready" >&2
    exit 1
  fi
  if lsof -nP -a -p "$server_pid" -iTCP:"$admin_port" -sTCP:LISTEN >/dev/null 2>&1 &&
     curl -fsS -o /dev/null "http://127.0.0.1:$admin_port/health/ready" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ] || ! kill -0 "$server_pid" 2>/dev/null ||
   ! lsof -nP -a -p "$server_pid" -iTCP:"$admin_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "The fixture Hydra process does not own a ready admin service" >&2
  exit 1
fi

"$hydra" create oauth2-client -e "http://127.0.0.1:$admin_port" --id mapi-phase0-local-cc --secret "$client_secret" --grant-type client_credentials --scope probe --token-endpoint-auth-method client_secret_basic --format json > "$fixture/client.json"
if [ "${MAPI_HYDRA_SKIP_BASIC_PROBE:-0}" != 1 ]; then
  node experiments/hydra-phase0/probe-local.mjs "$build" "$fixture" "$port" workerd
fi
if [ "${MAPI_HYDRA_BOUND_PROBE:-0}" = 1 ]; then
  docker exec -i "$container_id" psql -v ON_ERROR_STOP=1 -U postgres -d mapi_spike < experiments/hydra-phase0/bound-schema.sql >/dev/null
  "$hydra" create oauth2-client -e "http://127.0.0.1:$admin_port" --id mapi-bound-rp --secret "$client_secret" --grant-type authorization_code,refresh_token --response-type code --redirect-uri https://rp.example/callback --scope openid,offline_access --token-endpoint-auth-method client_secret_basic --format json > "$fixture/bound-client.json"
  node experiments/hydra-phase0/probe-bound-local.mjs "$build" "$fixture" "$port"
fi
