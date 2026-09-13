# CI/CD do AppRifa

O workflow [.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml) usa GitHub Actions para testar a aplicação, publicar a imagem aprovada no GHCR e atualizar uma instalação existente em servidor local por SSH. Os testes, build e publicação usam runners hospedados no GitHub; somente o deploy usa um runner na rede local.

## Fluxo

1. Pull requests e pushes em `main` ou `master`: instalação com `npm ci`, análise de sintaxe JavaScript/shell, testes PIX e auditoria npm. Vulnerabilidades altas ou críticas bloqueiam o pipeline.
2. Build do Dockerfile e 32 testes em containers temporários: 4 testes locais PIX, 17 de API e 11 de integração PIX. A contagem pode mudar conforme a suíte evoluir.
3. Na branch padrão do repositório, após todos os testes: publicação no GHCR com tag `sha-COMMIT`. O job recebe um arquivo da imagem testada, sem reconstruí-la.
4. Acionamento manual com `deploy` habilitado na branch padrão: atualização por SSH, usando o digest publicado e o ambiente `producao`, sem confirmação de backup no formulário.

Não há compilação, TypeScript ou configuração de lint no projeto. O pipeline verifica sintaxe e comportamento; não inventa comandos de build/lint ausentes. Não executa scripts de pagamento externo. O teste de integração tem rede interna, banco próprio, senha aleatória a cada execução e uploads na camada descartável do container. Os arquivos `.env` e os volumes de desenvolvimento/produção não são utilizados.

## Executar a validação local

Pré-requisitos: Bash, Node.js, Docker com BuildKit e acesso ao Docker Hub/registro npm para obter imagens e dependências.

```bash
npm run test:ci
```

O script constrói a imagem, cria rede interna e MySQL 8.4 com nomes exclusivos e monta somente os testes e o script de teste como arquivos somente leitura. Ao terminar, remove exclusivamente esses containers, seu volume anônimo de banco, rede e tag temporária. Não usa os serviços `app-test`/`mysql-test` do Compose existente.

No ambiente Linux em que o cliente Docker estiver configurado com um helper Windows incompatível, corrija essa configuração antes de executar. Isso não exige mudanças no workflow.

## Configurar o GitHub

1. Adicione os arquivos do projeto a um repositório GitHub e habilite Actions. Este diretório de trabalho não tinha metadados `.git` durante a configuração; nenhum push ou mudança remota foi feito.
2. Use `main` ou `master` como branch padrão, ou ajuste o filtro `push.branches` do workflow.
3. Em regras de proteção da branch, exija os checks **Syntax, PIX and security** e **Docker and isolated integration tests**, além da revisão de código desejada. Criar o YAML não ativa regras de proteção no GitHub.
4. Permita publicação de pacotes para o workflow. O job `publish` solicita `packages: write` e usa o `GITHUB_TOKEN` fornecido pelo GitHub; não precisa de PAT de publicação armazenado no repositório.
5. Crie o ambiente **production**, restrinja-o à branch padrão e configure revisores quando seu plano permitir. As regras de aprovação dependem do plano e da visibilidade do repositório: [documentação de ambientes](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

### Secrets do ambiente production

| Secret | Conteúdo |
| --- | --- |
| `SSH_PRIVATE_KEY` | Chave privada dedicada ao deploy, compatível com autenticação não interativa; chave pública autorizada no servidor |
| `SSH_KNOWN_HOSTS` | Linha(s) de `known_hosts` para o servidor, verificadas por um canal confiável; em porta diferente de 22, use a entrada correspondente a `[host]:porta` |

O pipeline exige verificação estrita da identidade SSH. Não usa `StrictHostKeyChecking=no` nem confia automaticamente em uma chave obtida durante o deploy.

### Variables do ambiente production

| Variável | Exemplo / finalidade |
| --- | --- |
| `SSH_HOST` | Nome DNS ou IPv4 do servidor na rede local; `127.0.0.1` se o runner estiver no próprio servidor |
| `SSH_USER` | Usuário Linux dedicado, como `deploy` |
| `SSH_PORT` | Porta SSH; padrão `22` |
| `DEPLOY_PATH` | Diretório absoluto da instalação, como `/opt/apprifa`, sem espaços |

As credenciais de MySQL, JWT, OAuth e pagamentos permanecem no `.env` do servidor. Não são copiadas para os jobs de teste ou build.

## Preparar o runner na rede local

Em **Settings → Actions → Runners → New self-hosted runner**, siga as instruções geradas pelo GitHub para Linux x64. Instale o runner em uma máquina com acesso à rede do servidor e acrescente a label **apprifa-deploy**, além das labels padrão `self-hosted`, `linux` e `x64`.

Execute-o como serviço para receber jobs sem depender de um terminal aberto. Ele precisa de Git, Bash, cliente OpenSSH e acesso de saída ao GitHub por HTTPS. O servidor de destino precisa acessar o GHCR para baixar a imagem. Não é necessário publicar a porta SSH no roteador.

Se o runner estiver no próprio servidor da aplicação, use `SSH_HOST=127.0.0.1`, configure o serviço SSH e autorize a chave de deploy para esse acesso local. Se estiver em outra máquina, use o endereço privado do servidor.

Dedique esse runner ao deploy de código confiável e restrinja seu uso ao repositório e à branch autorizados. Os jobs de pull request deste workflow não usam o runner local. Sem um runner online com as quatro labels, o job de deploy ficará na fila.

## Preparar o servidor

O deploy automatizado atualiza uma instalação existente. Ele não provisiona o servidor nem migra volumes de outro ambiente.

Requisitos:

- Linux **amd64**, compatível com a imagem construída pelo runner Ubuntu padrão.
- Docker, plugin Compose com suporte a `up --wait`, Bash e `flock`.
- Usuário SSH com acesso ao Docker, escrita no diretório de instalação e leitura de `.env`.
- `docker-compose.yml` ou `docker-compose.install.yml`, `.env` e `uploads/` já preparados em `DEPLOY_PATH`. O script exige exatamente um desses arquivos para evitar selecionar outra instalação por engano. Nos comandos operacionais abaixo, substitua `docker-compose.install.yml` pelo nome usado no servidor.
- Serviços `app` e `mysql` existentes; MySQL saudável antes do deploy.
- Uploads graváveis pelo UID/GID `65534:65534` e os volumes atuais preservados.
- Acesso ao GHCR pelo usuário de deploy. Para pacote privado, faça login no servidor com uma credencial de leitura de pacotes; não coloque o token no Compose. Consulte [autenticação no GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
- Proxy HTTPS e URLs de OAuth/webhook configurados conforme o [README](README.md).

Para a primeira instalação, use o procedimento de [deploy e operação](README.md#deploy-e-operação). Antes de habilitar atualizações, confira que ele aponta para os dados corretos: `docker-compose.install.yml` usa o volume `apprifa_mysql_data`, enquanto o Compose de desenvolvimento pode usar outro volume. Não troque os arquivos Compose sobre uma instalação existente sem avaliar essa diferença.

O workflow não envia ou sobrescreve `.env`, Compose, uploads ou dados do MySQL no servidor. Mudanças posteriores na configuração Compose precisam ser revisadas e aplicadas separadamente.

## Fazer deploy

1. Confira backup consistente do banco, cópia protegida da chave OAuth e compatibilidade das migrações com a versão anterior.
2. Em **Actions → CI/CD → Run workflow**, selecione a branch padrão.
3. Habilite `deploy`. O workflow não solicita confirmação de backup.
4. Aguarde os testes e a publicação; aprove o ambiente `production` caso essa proteção esteja configurada.

O script [deploy-ssh.sh](scripts/deploy-ssh.sh) valida o Compose antes da atualização, baixa a imagem por digest e atualiza somente `app` com `--no-deps --pull never --wait`. O serviço MySQL não é atualizado. A execução é serializada pelo workflow e por um lock no servidor.

O início da aplicação pode aplicar migrações automaticamente. O healthcheck confirma resposta HTTP, não homologação financeira. O deploy aguarda até 180 segundos pela saúde da aplicação.

Após sucesso, o servidor guarda:

- `.deployed-image`: referência GHCR por digest.
- `.deployed-image.yml`: override com essa imagem.
- `.previous-image`: ID local da imagem anterior, para análise de rollback.

Para operações posteriores que recriem a aplicação, inclua o override persistido. Executar apenas o Compose base pode selecionar novamente `apprifa-app:latest`:

```bash
docker compose --env-file .env -f docker-compose.install.yml -f .deployed-image.yml ps
docker compose --env-file .env -f docker-compose.install.yml -f .deployed-image.yml logs -f app
```

## Falhas e rollback

Falhas de teste ou auditoria impedem a publicação. Falhas de publicação impedem o deploy. Falhas de saúde no servidor fazem o job falhar; pode haver indisponibilidade durante a recriação do container.

Não há rollback automático de banco ou aplicação: a inicialização executa migrações e pode cifrar tokens, tornando um retorno automático incompatível. O script preserva a imagem anterior e não remove volumes.

Se o deploy falhar, examine a aplicação atual e os logs com `docker compose -f docker-compose.install.yml logs --tail=100 app`. O arquivo `.deployed-image.yml` representa o último deploy concluído; após uma tentativa com falha, ele pode não representar a imagem que está rodando.

Depois de confirmar compatibilidade do schema e da chave OAuth, um operador pode gerar um override com o ID salvo em `.previous-image`, validar a configuração e recriar somente `app`. Exemplo no diretório de instalação, **somente após essa revisão**:

```bash
previous_image=$(cat .previous-image)
docker image inspect "$previous_image" >/dev/null
printf 'services:\n  app:\n    image: %s\n' "$previous_image" > .rollback-image.yml
docker compose --env-file .env -f docker-compose.install.yml -f .rollback-image.yml config --quiet
docker compose --env-file .env -f docker-compose.install.yml -f .rollback-image.yml up -d --no-deps --pull never --wait --wait-timeout 180 app
```

Após um rollback bem-sucedido, registre a imagem ativa e substitua o override persistido pelo de rollback antes de outras operações. Não restaure um banco antigo sobre pagamentos posteriores sem reconciliação. Não use comandos de prune ou remoção de volumes como parte do deploy.

## Validação realizada e pendências

Foram executados localmente o build e os 32 testes em ambiente Docker isolado. A auditoria npm passou no limiar de alta gravidade, com cinco ocorrências moderadas no momento da configuração.

Também foram verificadas a sintaxe dos scripts, a estrutura YAML e os links locais. O script de deploy foi exercitado com Docker simulado para conferir sucesso, falha de saúde, rejeição de referência inválida e preservação dos arquivos de ambiente. Isso não substitui uma execução real no servidor.

A ativação remota depende de um repositório GitHub, configuração de Secrets/Variables e preparação do servidor. Sem esses dados, não foram executados publicação no GHCR ou deploy real por SSH.
