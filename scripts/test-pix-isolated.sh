#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  docker compose --profile test stop app-test mysql-test >/dev/null 2>&1 || true
  docker compose --profile test rm -fsv app-test mysql-test >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose --profile test up -d --no-build --pull never mysql-test app-test

echo "Aguardando API e MySQL de teste em http://localhost:3001/api/health ..."
curl -fsS --retry 40 --retry-all-errors --retry-delay 2 http://localhost:3001/api/health >/dev/null

docker compose --profile test exec -T app-test node --test tests/pix.integration.test.js
