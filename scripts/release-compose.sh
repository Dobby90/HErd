#!/bin/sh
set -eu

# The validation stack always uses its own network, database volume and ports.
project="herd-release-$$"
temp=$(mktemp -d)
cleanup() {
  docker compose --project-name "$project" --env-file "$temp/env" down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  rm -r "$temp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export HERD_HTTP_PORT=0 HERD_DB_PORT=0 HERD_NODE_ENV=development HERD_DEV_LOGIN=1
export APP_ORIGIN=http://127.0.0.1:8080 HERD_DB_PASSWORD=herd-ci-fixture
export DATABASE_URL=postgresql://herd:herd-ci-fixture@db:5432/herd
export HERD_MIGRATION_DATABASE_URL="$DATABASE_URL" OIDC_ISSUER= OIDC_CLIENT_ID= OIDC_CLIENT_SECRET=
export SQL_JOB_MAX_INPUT_BYTES=5242880 SQL_JOB_TIMEOUT_MS=10000 SQL_JOB_TTL_MS=600000
touch "$temp/env"
compose() { docker compose --project-name "$project" --env-file "$temp/env" "$@"; }

compose up -d --build --wait --wait-timeout 120
address=$(compose port web 8080)
node scripts/release-smoke.mjs "http://$address"
compose exec -T db psql -X -U herd -d herd -Atc 'SHOW server_version_num' | grep -x 170012
