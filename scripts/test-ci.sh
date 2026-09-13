#!/usr/bin/env bash
# Runs the production image against disposable MySQL, without host data or secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

ci_id="apprifa-ci-$(date +%s)-$$"
ci_network="$ci_id"
ci_database="$ci_id-db"
ci_app="$ci_id-app"
ci_image="$ci_id:check"
ci_root="$(pwd)"
ci_password="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"

cleanup() {
  ci_status=$?
  trap - EXIT
  docker rm -f -v "$ci_app" "$ci_database" >/dev/null 2>&1 || true
  docker network rm "$ci_network" >/dev/null 2>&1 || true
  docker image rm "$ci_image" >/dev/null 2>&1 || true
  exit "$ci_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build --check .
docker build -t "$ci_image" .
docker pull mysql:8.4
# Neither the application nor the test database can reach external gateways.
docker network create --internal "$ci_network" >/dev/null
MYSQL_PASSWORD="$ci_password" docker run -d --name "$ci_database" \
  --network "$ci_network" --network-alias mysql-test \
  --env MYSQL_DATABASE=apprifa_test --env MYSQL_USER=apprifa_test \
  --env MYSQL_PASSWORD --env MYSQL_RANDOM_ROOT_PASSWORD=yes \
  --health-cmd='MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -u apprifa_test -D apprifa_test -e "SELECT 1"' \
  --health-interval=3s --health-timeout=3s --health-retries=40 \
  mysql:8.4 >/dev/null

ci_ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$ci_database")" == healthy ]]; then
    ci_ready=true
    break
  fi
  sleep 3
done
if [[ "$ci_ready" != true ]]; then
  echo 'The disposable MySQL database did not become healthy.' >&2
  exit 1
fi

DB_PASSWORD="$ci_password" docker run --name "$ci_app" --network "$ci_network" \
  --no-healthcheck \
  --env DB_HOST=mysql-test --env DB_PORT=3306 \
  --env DB_NAME=apprifa_test --env DB_USER=apprifa_test --env DB_PASSWORD \
  --env PAYMENT_PROVIDER=mock --env SEED_DEMO_DATA=false \
  --env JWT_SECRET=ci-only-jwt-secret \
  --env PLATFORM_ADMIN_EMAIL=admin@apprifa.com \
  --env PLATFORM_ADMIN_PASSWORD=admin_plataforma_teste \
  --env ADMIN_REGISTRATION_TOKEN=admin_token_forte \
  --mount "type=bind,src=$ci_root/tests,dst=/app/tests,readonly" \
  --mount "type=bind,src=$ci_root/scripts/ci-tests-in-container.sh,dst=/app/ci-tests.sh,readonly" \
  "$ci_image" sh /app/ci-tests.sh

if [[ -n "${CI_IMAGE_ARCHIVE:-}" ]]; then
  # Export the tested image; publishing must not rebuild a different image.
  docker save "$ci_image" -o "$CI_IMAGE_ARCHIVE"
fi
