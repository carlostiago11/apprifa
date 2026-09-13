# Docker Instructions

Antes de alterar um docker-compose:

docker compose config

Verificar:

- serviços
- volumes
- networks
- ports
- depends_on
- healthcheck
- restart
- environment
- secrets

Nunca remover volumes existentes.

Nunca executar:

docker compose down -v

sem autorização.

Nunca executar:

docker system prune -a
docker volume prune

automaticamente.

Para upgrades:

1. identificar versão atual;
2. verificar versão desejada;
3. avaliar breaking changes;
4. verificar persistência;
5. definir rollback;
6. somente depois atualizar.