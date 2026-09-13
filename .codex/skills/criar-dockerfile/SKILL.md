---
name: criar-dockerfile
description: Cria ou adapta Dockerfile e .dockerignore após analisar linguagens, bibliotecas, frameworks, versões e gerenciadores de pacotes do projeto. Use quando o usuário pedir um Dockerfile ou empacotar uma aplicação em imagem Docker; não se destina a administrar containers ou fazer deploy.
---

# Criar Dockerfile a partir do projeto

Entregue um Dockerfile funcional, adequado ao projeto real, com contexto de build definido e instruções de build e execução. Por padrão, prepare uma imagem de produção, salvo indicação diferente do usuário ou do projeto. Sempre analise o projeto antes de escrever; não aplique um template apenas pela extensão de um arquivo.

## Analisar antes de gerar

1. Leia as instruções aplicáveis de `AGENTS.md`, veja o estado das alterações locais e examine a estrutura com `rg --files`, incluindo arquivos ocultos relevantes. Exclua dependências instaladas e artefatos volumosos da pesquisa. Leia Dockerfiles, `.dockerignore`, documentação de execução, scripts e CI existentes.
2. Identifique as linguagens realmente usadas pela aplicação e pelo build, frameworks e bibliotecas que afetam a imagem: extensões nativas, drivers, clientes de banco, geração de código, navegadores, bibliotecas de mídia, certificados e ferramentas do sistema. Confirme pelos manifests, imports e configuração; arquivos de exemplo ou dependências vendorizadas não definem a stack.
3. Determine o gerenciador e sua versão por declarações do projeto, lockfiles e comandos usados na CI. Exemplos de evidências:

   | Ecossistema | Arquivos a examinar |
   | --- | --- |
   | JavaScript/TypeScript | `package.json` (scripts, engines, packageManager), `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`, `.yarnrc.yml`, `bun.lock`, `bun.lockb`, `.nvmrc` |
   | Python | `pyproject.toml`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `requirements*.txt`, `.python-version` |
   | Go | `go.mod`, `go.sum`, `go.work`, vendor e configuração de CGO |
   | Rust | `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, workspaces |
   | JVM | `pom.xml`, Maven Wrapper, `build.gradle*`, Gradle Wrapper e toolchains |
   | .NET | `*.csproj`, `*.fsproj`, `*.sln*`, `global.json`, `NuGet.config`, `packages.lock.json` |
   | PHP/Ruby | `composer.json`, `composer.lock`, `Gemfile`, `Gemfile.lock`, `.ruby-version` |

   Para outras linguagens, faça a mesma investigação nos manifests e ferramentas nativas. Não troque o gerenciador nem regenere lockfiles para facilitar a imagem. Em caso de sinais conflitantes, confira CI, documentação e escopo de cada subprojeto; pergunte somente se uma ambiguidade relevante persistir. Sem lockfile, preserve o fluxo existente e informe a limitação de reprodutibilidade.
4. Identifique versões de runtime, comandos efetivos de instalação, build e início, diretório dos artefatos, arquivos necessários em execução, porta e endereço de escuta, variáveis obrigatórias e diretórios graváveis. Separe configurações de build das de runtime. Não leia nem exiba valores de segredos para descobrir nomes de variáveis; use schemas e exemplos sem credenciais.
5. Em monorepos ou projetos com várias linguagens, mapeie os serviços e dependências locais. Escolha o contexto que inclua workspaces, pacotes compartilhados e arquivos necessários; `COPY` não acessa arquivos fora dele. Respeite o serviço solicitado. Se houver vários executáveis sem alvo inferível, esclareça qual deve ser empacotado antes de implementar a parte dependente dessa resposta.
6. Antes da edição, apresente um diagnóstico curto com evidências: linguagens/frameworks, gerenciador e lockfile, versões, build, início e contexto. Indique hipóteses sem apresentá-las como fatos.

## Escolher e construir a imagem

- Selecione uma imagem oficial ou de fornecedor confiável, compatível com a versão do projeto e a arquitetura alvo. Verifique tags e suporte na documentação oficial; evite `latest` e nunca invente tags ou digests. Prefira versões explícitas; quando fixar digest, confirme-o no registro e preserve uma estratégia de atualização. Não atualize runtimes ou dependências fora do escopo.
- Escolha a variante pela compatibilidade, além do tamanho. Alpine usa musl e pode ser inadequada para wheels, módulos nativos ou binários que esperam glibc. Use `scratch` ou distroless somente quando o artefato, as bibliotecas compartilhadas, certificados e necessidades operacionais forem compatíveis.
- Use estágios separados quando houver compilação, geração de assets ou ferramentas dispensáveis em produção. Mantenha as dependências de desenvolvimento necessárias no build; leve para o runtime apenas artefatos, dependências de execução e arquivos necessários. Preserve compatibilidade de ABI e arquitetura entre estágios, especialmente para extensões nativas e ambientes virtuais.
- Respeite a instalação determinística suportada pela versão detectada: por exemplo, `npm ci`, pnpm com lockfile congelado, Yarn moderno com `--immutable`, Yarn clássico com `--frozen-lockfile`, ou o equivalente do gerenciador identificado. Não imponha flags de outra versão. Inclua configuração e manifests dos workspaces necessários antes de instalar. Copie código antes da instalação quando hooks ou dependências locais precisarem dele.
- Organize camadas para reutilizar dependências quando apenas código mudar. Use cache mounts do BuildKit quando úteis e compatíveis; eles não substituem arquivos necessários à imagem final. Instale pacotes do sistema mínimos; em bases apt, combine atualização, instalação com `--no-install-recommends` e limpeza de listas no mesmo `RUN`.
- Defina `WORKDIR`, prefira `COPY` para arquivos locais e use `COPY --chown` quando necessário. Rode a aplicação como usuário sem privilégios sempre que suportado e configure permissões apenas nos diretórios necessários. Não use `chmod 777` como solução.
- Não grave credenciais em `ARG`, `ENV`, URLs, arquivos copiados ou camadas intermediárias. Para dependências privadas, use secrets/SSH mounts do BuildKit e explique como fornecê-los, sem expor valores. Verifique se os comandos não persistem credenciais nos artefatos. Receba segredos da aplicação em runtime.
- Use `CMD`/`ENTRYPOINT` na forma exec para preservar sinais. Se um script for necessário, termine com `exec` do processo principal. Use o servidor de produção que o projeto suporta; não invente dependências ou comandos. Em frontend estático, sirva a saída de build; em SSR, preserve o runtime do framework. Não execute migrations ou tarefas destrutivas automaticamente no build ou início.
- Declare `EXPOSE` somente para portas confirmadas; ele não publica portas. Garanta que servidores aceitem conexões fora do loopback. Adicione `HEALTHCHECK` apenas quando houver uma verificação adequada e ferramentas disponíveis; não invente endpoints. Workers e CLIs podem não ter portas ou healthchecks HTTP.
- Crie ou ajuste `.dockerignore` no contexto correto, respeitando arquivos específicos de Dockerfile já existentes. Exclua `.git`, dependências locais, caches, logs e segredos (incluindo `.env` reais e chaves privadas). Preserve exemplos sem segredos quando necessários. Não exclua indiscriminadamente lockfiles, código de workspaces, assets, patches ou artefatos consumidos pelo build. Confira os padrões contra cada `COPY`.

## Respeitar configuração existente

Preserve alterações do usuário e convenções do repositório. Criar um Dockerfile não exige alterar Compose ou fazer deploy.

Se uma alteração de Compose for necessária e estiver no escopo, execute `docker compose config` antes de editar e confira serviços, volumes, networks, ports, depends_on, healthcheck, restart, environment e secrets. Não divulgue a saída resolvida se contiver segredos. Nunca remova volumes existentes. Não execute `docker compose down -v` sem autorização nem execute automaticamente `docker system prune -a` ou `docker volume prune`.

Para upgrades solicitados, identifique a versão atual, verifique a desejada, avalie breaking changes, confira persistência e defina rollback antes da atualização.

## Validar e entregar

1. Revise caminhos de `COPY`, contexto, arquivos ignorados, estágios, dependências nativas, permissões e existência dos comandos de início. Confira que manifests e lockfiles do projeto foram preservados.
2. Quando as ferramentas estiverem disponíveis, execute os checks de build suportados (`docker build --check` ou equivalente disponível) e construa a imagem com tag local específica da tarefa. Não instale ferramentas extras apenas para lint sem necessidade. Se Docker, rede ou credenciais impedirem o build, descreva o bloqueio e forneça o comando exato; não afirme validação que não ocorreu.
3. Quando viável sem efeitos externos, faça smoke test isolado: inicialização, usuário, sinal de término e resposta do serviço ou comando da CLI. Não conecte automaticamente a serviços de produção, execute migrations ou monte dados reais. Remova somente containers temporários criados para o teste, preservando volumes e recursos existentes.
4. Entregue links para os arquivos criados, justificativa breve da imagem base e dos estágios, comandos executáveis de build e execução com o contexto correto, variáveis/volumes necessários e resultado real da validação. Explique dependências externas e hipóteses pendentes. Não publique a imagem nem faça deploy sem pedido do usuário.

## Referências oficiais

Consulte estas referências quando precisar confirmar sintaxe ou comportamento, além da documentação oficial do runtime e gerenciador detectados:

- [Boas práticas de build](https://docs.docker.com/build/building/best-practices/)
- [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Otimização de cache](https://docs.docker.com/build/cache/optimize/)
- [Segredos de build](https://docs.docker.com/build/building/secrets/)
- [Referência do Dockerfile](https://docs.docker.com/reference/dockerfile/)
