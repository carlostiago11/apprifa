#!/usr/bin/env bash
# Receives an immutable GHCR reference and an existing installation directory.
set -Eeuo pipefail
# Informa a etapa e a linha da falha sem imprimir comandos ou credenciais.
deploy_stage="validar argumentos"
trap 'status=$?; printf "Erro no deploy remoto: etapa %s, linha %s (código %s).\n" "$deploy_stage" "$LINENO" "$status" >&2; exit "$status"' ERR
fail() { printf 'Erro no deploy remoto: %s\n' "$1" >&2; exit 1; }
echo 'Conexão SSH estabelecida. Iniciando verificações no servidor.'
deploy_dir="${1:?Installation directory required}"
image_ref="${2:?Image digest required}"
[[ "$deploy_dir" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Invalid deployment directory' >&2; exit 1; }
[[ "$image_ref" =~ ^ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Expected a GHCR image digest' >&2; exit 1; }
deploy_stage="acessar diretório da instalação"
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
[[ -f .env && -r .env ]] || fail "Arquivo .env ausente ou sem permissão de leitura em DEPLOY_PATH."
command -v flock >/dev/null || fail "Comando flock não instalado no servidor."
deploy_stage="obter lock de deploy"
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment is in progress' >&2; exit 1; }

compose=(docker compose --env-file .env -f "$compose_file")
deploy_stage="validar configuração Compose"
"${compose[@]}" config --quiet
# This deploy updates only an existing application; provisioning is separate.
deploy_stage="verificar serviços existentes"
app_id="$("${compose[@]}" ps -q app)"
mysql_id="$("${compose[@]}" ps -q mysql)"
[[ -n "$app_id" ]] || fail "Serviço app não está em execução neste projeto Compose. Confira DEPLOY_PATH e a instalação existente."
[[ -n "$mysql_id" ]] || fail "Serviço mysql não está em execução neste projeto Compose. Confira DEPLOY_PATH e a instalação existente."
mysql_health="$(docker inspect --format '{{.State.Health.Status}}' "$mysql_id")"
[[ "$mysql_health" == healthy ]] || fail "MySQL não está saudável (estado: $mysql_health). Verifique o banco antes de atualizar app."
previous_image="$(docker inspect --format '{{.Image}}' "$app_id")"
deploy_stage="baixar imagem do GHCR"
echo 'Instalação validada. Baixando a imagem publicada.'
docker pull "$image_ref"

deploy_stage="preparar atualização de app"
umask 077
override="$(mktemp "$deploy_dir/.deploy-image.XXXXXX.yml")"
trap 'rm -f "$override"' EXIT
printf 'services:\n  app:\n    image: %s\n' "$image_ref" > "$override"
"${compose[@]}" -f "$override" config --quiet
printf '%s\n' "$previous_image" > .previous-image
deploy_stage="atualizar app e aguardar healthcheck"
echo 'Atualizando app e aguardando o healthcheck.'
if ! "${compose[@]}" -f "$override" up -d --no-deps --pull never --wait --wait-timeout 180 app; then
  echo 'Deploy failed. Previous image ID is stored in .previous-image.' >&2
  echo 'Review database migrations before attempting a rollback.' >&2
  exit 1
fi
deploy_stage="registrar imagem implantada"
mv "$override" .deployed-image.yml
trap - EXIT
printf '%s\n' "$image_ref" > .deployed-image
echo "Deployment healthy: $image_ref"
