#!/usr/bin/env bash
# Receives an immutable GHCR reference and an existing installation directory.
set -euo pipefail
deploy_dir="${1:?Installation directory required}"
image_ref="${2:?Image digest required}"
[[ "$deploy_dir" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Invalid deployment directory' >&2; exit 1; }
[[ "$image_ref" =~ ^ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Expected a GHCR image digest' >&2; exit 1; }
cd "$deploy_dir"
compose_files=()
for candidate in docker-compose.yml docker-compose.install.yml; do
  if [[ -f "$candidate" ]]; then
    compose_files+=("$candidate")
  fi
done
if [[ ${#compose_files[@]} -ne 1 ]]; then
  echo 'Expected exactly one deployment Compose file: docker-compose.yml or docker-compose.install.yml' >&2
  exit 1
fi
compose_file="${compose_files[0]}"
test -f .env
command -v flock >/dev/null
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment is in progress' >&2; exit 1; }

compose=(docker compose --env-file .env -f "$compose_file")
"${compose[@]}" config --quiet
# This deploy updates only an existing application; provisioning is separate.
app_id="$("${compose[@]}" ps -q app)"
mysql_id="$("${compose[@]}" ps -q mysql)"
test -n "$app_id" && test -n "$mysql_id"
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$mysql_id")" == healthy ]]
previous_image="$(docker inspect --format '{{.Image}}' "$app_id")"
docker pull "$image_ref"

umask 077
override="$(mktemp "$deploy_dir/.deploy-image.XXXXXX.yml")"
trap 'rm -f "$override"' EXIT
printf 'services:\n  app:\n    image: %s\n' "$image_ref" > "$override"
"${compose[@]}" -f "$override" config --quiet
printf '%s\n' "$previous_image" > .previous-image
if ! "${compose[@]}" -f "$override" up -d --no-deps --pull never --wait --wait-timeout 180 app; then
  echo 'Deploy failed. Previous image ID is stored in .previous-image.' >&2
  echo 'Review database migrations before attempting a rollback.' >&2
  exit 1
fi
mv "$override" .deployed-image.yml
trap - EXIT
printf '%s\n' "$image_ref" > .deployed-image
echo "Deployment healthy: $image_ref"
