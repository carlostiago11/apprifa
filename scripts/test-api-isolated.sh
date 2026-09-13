#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  docker compose --profile test stop app-test mysql-test >/dev/null 2>&1 || true
  docker compose --profile test rm -fsv app-test mysql-test >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose --profile test up --build -d mysql-test app-test

echo "Aguardando API de teste em http://localhost:3001/api/health ..."
curl -fsS --retry 40 --retry-all-errors --retry-delay 2 http://localhost:3001/api/health >/dev/null

API_BASE=http://localhost:3001 ADMIN_REGISTRATION_TOKEN=admin_token_forte npm run test:api
