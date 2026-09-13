# AppRifa

Plataforma de rifas online com gestão de múltiplos clientes, venda de números e integração de pagamentos PIX. Cada organizador administra suas rifas e pode conectar sua própria conta Mercado Pago para receber pagamentos.

**Versão do pacote:** 1.0.0. A homologação financeira deve ser acompanhada pelo roteiro em [HOMOLOGACAO_PIX.md](HOMOLOGACAO_PIX.md); a presença da integração no código não comprova liquidação ou repasse real.

## Sumário

- [Sobre o projeto](#sobre-o-projeto)
- [Funcionalidades](#funcionalidades)
- [Tecnologias](#tecnologias)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Execução local](#execução-local)
- [Execução com Docker](#execução-com-docker)
- [Como usar](#como-usar)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Testes e qualidade](#testes-e-qualidade)
- [API e integrações](#api-e-integrações)
- [Deploy e operação](#deploy-e-operação)
- [CI/CD](#cicd)
- [Solução de problemas](#solução-de-problemas)
- [Contribuição](#contribuição)
- [Licença](#licença)
- [Contato](#contato)

## Sobre o projeto

O AppRifa reúne três perfis de acesso:

- **Administrador da plataforma:** cria e administra clientes, usuários e configurações da plataforma pelo painel `/gestao.html`.
- **Organizador (`owner` ou `admin`):** cadastra produtos, gerencia rifas, acompanha pagamentos e conecta a conta recebedora.
- **Comprador:** acessa o cliente pelo identificador da loja, escolhe números e acompanha seus tickets.

O backend Express serve a API e os arquivos HTML, CSS e JavaScript de `public/`. Os dados são armazenados em MySQL por meio do Sequelize. Não há etapa de compilação do frontend.

## Funcionalidades

- Gestão de clientes e usuários com autenticação JWT e permissões por perfil.
- Cadastro de produtos e upload de imagens.
- Rifas dos tipos `BICHO_25`, `NUMERICA_100` e `NUMERICA_1000`, este último com quantidade personalizada de até 1.000 números.
- Configuração de um a cinco ganhadores, respeitando a quantidade de números da rifa.
- Desconto configurável de 0% a 100% para compras de três ou mais números, com valor inicial de 10%.
- Reserva de números e proteção contra compras concorrentes, com transações e índice único por rifa/número.
- Checkout PIX, autorização OAuth do vendedor, comissão da plataforma e acompanhamento de pagamentos.
- Reconciliação de pagamentos pendentes e tratamento de webhooks Mercado Pago.
- Apuração de ganhadores e geração de etiquetas de envio em PDF.

O modo `mock` confirma pagamentos imediatamente e serve para desenvolvimento. Estornos e disputas requerem tratamento operacional próprio.

## Tecnologias

As versões das bibliotecas abaixo correspondem ao `package-lock.json`. O Node.js 24 é definido pelo Dockerfile; o `package.json` não fixa versões de Node ou npm.

| Categoria | Tecnologia | Versão / definição | Uso |
| --- | --- | --- | --- |
| Linguagem / runtime | JavaScript / Node.js | Node 24 na imagem | Backend e scripts |
| Gerenciador | npm | Lockfile v3 | Instalação com `npm ci` |
| API | Express | 4.22.2 | HTTP e arquivos estáticos |
| Persistência | MySQL / Sequelize / mysql2 | 8.4 / 6.37.8 / 3.24.2 | Banco relacional e ORM |
| Autenticação | jsonwebtoken / bcryptjs | 9.0.3 / 2.4.3 | Tokens e hashes de senha |
| Pagamentos | Mercado Pago / Stripe | SDKs 3.6.0 / 16.12.0 | Integrações financeiras |
| Upload / documentos | Multer / PDFKit | 1.4.5-lts.2 / 0.17.2 | Imagens e PDFs |
| Interface | HTML, CSS e JavaScript | Sem framework de build | Portais web |
| Infraestrutura | Docker e Compose | Imagem `node:24-bookworm-slim` | Empacotamento e serviços |

## Pré-requisitos

- Para execução local: Node.js 24, npm e MySQL 8.4 acessível pela aplicação.
- Para execução em containers: Docker com BuildKit e plugin Docker Compose.
- Para os scripts de integração: Bash, curl e as dependências npm instaladas no host.
- Para pagamentos externos: aplicação e contas adequadas no Mercado Pago, URLs HTTPS de retorno/webhook e credenciais do ambiente escolhido.

## Instalação

Obtenha o código pelo canal de distribuição do projeto e abra um terminal na raiz, onde está `package.json`. A URL do repositório não está definida nesta documentação.

Para desenvolver ou executar testes no host:

```bash
npm ci
```

Prepare o arquivo de configuração, caso ainda não exista:

```bash
cp -n .env.example .env
```

Edite `.env` antes de iniciar. A execução exclusivamente com Docker instala as dependências durante o build e dispensa `npm ci` no host.

## Configuração

O arquivo [.env.example](.env.example) lista as variáveis disponíveis. O servidor usa `dotenv` na execução local; o Compose fornece `.env` ao container. As variáveis da aplicação são lidas em runtime e os segredos não são incorporados à imagem.

| Variável | Finalidade | Configuração |
| --- | --- | --- |
| `PORT` | Porta HTTP interna | `3000`; mantenha alinhada ao mapeamento e ao healthcheck |
| `DB_HOST` | Endereço do MySQL | `mysql` no Compose; `127.0.0.1` para acesso pelo host |
| `DB_PORT` | Porta do banco | `3306` no ambiente principal |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Acesso ao banco | Devem corresponder ao banco provisionado |
| `JWT_SECRET` | Assinatura dos tokens | Defina um segredo próprio |
| `UPLOAD_DIR` | Diretório de arquivos enviados | `uploads`, relativo ao diretório da aplicação |
| `PLATFORM_ADMIN_EMAIL` | Login do administrador da plataforma | Defina o endereço do operador |
| `PLATFORM_ADMIN_PASSWORD` | Senha do administrador da plataforma | Substitua o valor de exemplo |
| `ADMIN_REGISTRATION_TOKEN`, `ADMIN_EMAILS` | Configuração de cadastro/perfis administrativos | Confira o fluxo usado antes de habilitar |
| `PAYMENT_PROVIDER` | Provedor de pagamento | `mock` no desenvolvimento; `mercadopago` no fluxo PIX externo |
| `SEED_DEMO_DATA` | Carga de dados demonstrativos | `false`; habilite somente no ambiente de desenvolvimento |

O `docker-compose.yml` contém credenciais fixas de desenvolvimento. Alterar somente `DB_PASSWORD` em `.env` não altera a senha configurada nesse serviço MySQL. O arquivo `docker-compose.install.yml` usa as variáveis do ambiente para provisionar o banco; em volumes já inicializados, mudanças nessas variáveis não substituem automaticamente os usuários e senhas existentes.

### Mercado Pago

| Variável | Finalidade |
| --- | --- |
| `MERCADOPAGO_APP_ID`, `MERCADOPAGO_CLIENT_SECRET` | Identificação e autenticação da aplicação OAuth |
| `MERCADOPAGO_PUBLIC_KEY` | Chave pública da integração |
| `MERCADOPAGO_REDIRECT_URI` | URL HTTPS terminada em `/api/payments/mercadopago/connect/callback` |
| `MERCADOPAGO_NOTIFICATION_URL` | URL HTTPS terminada em `/api/webhooks/mercadopago?source_news=webhooks` |
| `MERCADOPAGO_WEBHOOK_SECRET` | Verificação da assinatura das notificações |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | Chave de 32 bytes aleatórios em base64 para cifrar tokens OAuth |
| `MARKETPLACE_FEE_PERCENT` | Percentual padrão da comissão; exemplo: `10` |
| `PIX_EXPIRATION_MINUTES` | Prazo do PIX; padrão `30` |
| `PIX_RECONCILE_INTERVAL_MS` | Intervalo de reconciliação; padrão `60000` |
| `MERCADOPAGO_WEBHOOK_MAX_AGE_SECONDS` | Janela de validade das notificações; padrão `600` |
| `MERCADOPAGO_ACCESS_TOKEN` | Token da conta marketplace usado nas verificações e scripts; não substitui o OAuth de cada vendedor |

Substitua os domínios de exemplo pelos do seu ambiente e cadastre as mesmas URLs no provedor. Preserve uma cópia protegida da chave de criptografia: os tokens já cifrados dependem dela. Consulte [HOMOLOGACAO_PIX.md](HOMOLOGACAO_PIX.md) para a preparação e as limitações do fluxo.

### Banco de dados e dados iniciais

Na inicialização, `server.js` conecta ao banco, executa `sequelize.sync()`, aplica as migrações de `migrations/` e ajustes adicionais de schema antes de abrir a porta HTTP. Há até 20 tentativas, com intervalo de três segundos após falhas.

Não existe um script npm separado para migrações. Iniciar uma nova versão pode modificar o banco; prepare backup e avalie compatibilidade antes de atualizar. A carga demonstrativa depende de `SEED_DEMO_DATA=true`.

## Execução local

Com MySQL disponível, configure `.env` com o endereço e as credenciais corretos. Para usar apenas o banco de desenvolvimento do Compose:

```bash
docker compose up -d mysql
```

Nesse caso, use `DB_HOST=127.0.0.1` e `DB_PORT=3306` em `.env`. Aguarde o MySQL ficar disponível e execute:

```bash
npm start
```

Acesse `http://localhost:3000` e o painel de plataforma em `http://localhost:3000/gestao.html`. Use `Ctrl+C` para encerrar o processo local. Não inicie simultaneamente a aplicação local e o serviço `app` na mesma porta.

### Execução de produção sem container

Não há comando de compilação. Em uma instalação dedicada, com as variáveis e o banco preparados:

```bash
npm ci --omit=dev
NODE_ENV=production npm start
```

São necessários `server.js`, `lib/`, `migrations/`, `public/`, dependências instaladas e um diretório de uploads gravável e persistente.

## Execução com Docker

O [Dockerfile](Dockerfile) usa a raiz como contexto, separa a instalação de dependências da imagem final e inicia `node server.js`. O processo roda como UID/GID `65534:65534`. O diretório `uploads/` montado no host precisa permitir escrita para esse usuário; em uma instalação nova, crie-o e atribua a propriedade adequada antes de iniciar.

### Build da imagem

```bash
docker build --check .
docker build -t apprifa-app:1.0.0 .
```

### Ambiente de desenvolvimento com Compose

Com `.env` configurado para `DB_HOST=mysql`:

```bash
docker compose config
docker compose up --build -d mysql app
docker compose ps
docker compose logs -f app
```

A saída de `config` pode conter segredos resolvidos; não a compartilhe sem removê-los.

| Serviço | Porta host:container | Persistência | Ativação |
| --- | --- | --- | --- |
| `mysql` | `3306:3306` | Volume `mysql_data` em `/var/lib/mysql` | Ambiente principal |
| `app` | `3000:3000` | `./uploads:/app/uploads` | Ambiente principal |
| `mysql-test` | `3307:3306` | Volume `mysql_test_data` | Profile `test` |
| `app-test` | `3001:3000` | Mesmo `./uploads` do ambiente principal | Profile `test`; requer `.env.test` |

O healthcheck consulta `/api/health`. Esse endpoint confirma a resposta do processo HTTP, mas não realiza uma consulta de saúde ao banco a cada chamada.

Para interromper os serviços sem remover dados:

```bash
docker compose stop
```

## Como usar

1. Acesse `/gestao.html` com `PLATFORM_ADMIN_EMAIL` e `PLATFORM_ADMIN_PASSWORD`.
2. Cadastre o cliente, seu identificador de loja e o usuário organizador.
3. Entre no Portal do Cliente com as credenciais do organizador e cadastre os produtos e as rifas.
4. Para PIX externo, preencha o perfil recebedor em **Conectar PIX** e autorize a conta Mercado Pago por OAuth.
5. Compartilhe o acesso à loja, por exemplo `http://localhost:3000/?tenant=minha-loja`, substituindo `minha-loja` pelo identificador cadastrado.
6. O comprador se cadastra no cliente, escolhe os números e conclui o checkout. Em `mock`, a confirmação é imediata; no fluxo externo, acompanhe o estado do pagamento.

O desconto é calculado no backend. Exemplo: três números de R$ 10,00 com desconto de 10% resultam em R$ 27,00. Números reservados ou pagos ficam indisponíveis para outros compradores; conflitos de seleção retornam HTTP `409`.

## Estrutura do projeto

```text
apprifa/
├── server.js                  # API, modelos, inicialização e regras da aplicação
├── lib/                       # Integração Mercado Pago e utilitários PIX
├── migrations/                # Alterações versionadas do banco
├── public/                    # Portais HTML, scripts e imagens
├── uploads/                   # Arquivos enviados; persistidos fora da imagem
├── tests/                     # Testes da API e do fluxo PIX
├── scripts/                   # Verificações e execução de testes
├── .codex/skills/              # Skills locais do projeto
├── .env.example               # Referência de configuração
├── Dockerfile                 # Imagem de produção
├── .dockerignore              # Exclusões do contexto de build
├── docker-compose.yml         # Desenvolvimento e profile de testes
├── docker-compose.install.yml # Instalação usando imagem previamente construída
├── package.json               # Dependências e comandos npm
├── package-lock.json          # Versões resolvidas das dependências
├── HOMOLOGACAO_PIX.md          # Roteiro de homologação
├── README.template.md         # Modelo reutilizável de documentação
└── README.md
```

## Testes e qualidade

| Verificação | Comando | Pré-requisitos / efeitos |
| --- | --- | --- |
| Utilitários PIX | `npm run test:pix` | Dependências npm; testes locais de payload e criptografia |
| CI completo | `npm run test:ci` | Node.js, Bash e Docker; build e testes com banco/rede/uploads descartáveis |
| API | `npm run test:api` | API e banco de teste; cria registros |
| API pelo Compose | `npm run test:api:isolated` | `.env.test`, Docker, Bash e curl; inicia `app-test` e `mysql-test` |
| Configuração Mercado Pago | `npm run check:mercadopago -- .env` | Arquivo de ambiente configurado |
| Integração PIX | `npm run test:pix:isolated` | Requer adaptação da disponibilidade dos testes na imagem, descrita abaixo |
| Pré-homologação | `npm run validate:mercadopago -- .env` | Inclui a integração PIX e herda sua limitação atual |
| Dockerfile | `docker build --check .` | Docker com suporte a build checks |

Não há scripts de lint, formatação ou build da aplicação declarados em `package.json`.

### Preparar o ambiente de teste

Crie `.env.test` a partir do exemplo, se ainda não existir, e configure exclusivamente dados de teste:

```bash
cp -n .env.example .env.test
```

```dotenv
DB_HOST=mysql-test
DB_PORT=3306
DB_NAME=apprifa_test
DB_USER=apprifa_test
DB_PASSWORD=apprifa_test123
PORT=3000
PAYMENT_PROVIDER=mock
SEED_DEMO_DATA=false
PLATFORM_ADMIN_EMAIL=admin@apprifa.com
PLATFORM_ADMIN_PASSWORD=admin_plataforma_teste
ADMIN_REGISTRATION_TOKEN=admin_token_forte
```

Esses valores correspondem ao Compose e aos padrões da suíte, não são credenciais de produção. Configure também um `JWT_SECRET` exclusivo de teste. A suíte da API executada no host usa `API_BASE` e as variáveis de autenticação do processo; ela não carrega `.env.test` automaticamente.

O script `test:api:isolated` direciona a API para a porta 3001. Seus containers são interrompidos e removidos ao final; o volume nomeado do banco de teste permanece. **O diretório de uploads é compartilhado com o ambiente principal**, portanto esse isolamento não abrange arquivos enviados.

### Limitação atual da integração PIX em container

O script `test-pix-isolated.sh` executa `tests/pix.integration.test.js` dentro de `app-test` e exige uma imagem já construída. A imagem de produção atual não contém `tests/`; portanto o script não funciona diretamente com ela. É necessário disponibilizar os testes em um ambiente dedicado de desenvolvimento/teste antes de usar esse comando ou `validate:mercadopago`.

Para executar a suíte completa com o Dockerfile atual, use `npm run test:ci`: esse fluxo monta os testes somente durante a execução e cria banco, rede e uploads descartáveis.

A suíte de integração verifica `DB_HOST=mysql-test` e `DB_NAME=apprifa_test` e simula chamadas Mercado Pago. Os scripts `test:mercadopago:account` e `test:mercadopago:orders` são diferentes: acessam a API externa, e o segundo pode criar uma order de teste. Consulte o roteiro de homologação antes de executá-los.

## API e integrações

A implementação dos endpoints está em [server.js](server.js). A autenticação da aplicação usa `Authorization: Bearer TOKEN`; o login da plataforma possui permissões próprias.

| Método | Endpoint | Finalidade | Acesso |
| --- | --- | --- | --- |
| GET | `/api/health` | Saúde HTTP | Público |
| POST | `/api/platform/auth/login` | Login da plataforma | Credenciais da plataforma |
| GET / POST | `/api/platform/tenants` | Listar / criar clientes | Administrador da plataforma |
| POST | `/api/auth/register` | Cadastro de usuário no cliente | Conforme regras de cadastro |
| POST | `/api/auth/login` | Login no cliente | Credenciais e identificador do cliente |
| GET / POST | `/api/products` | Listar / criar produtos | Autenticado / organizador |
| GET / POST | `/api/raffles` | Listar / criar rifas | Autenticado / organizador |
| GET | `/api/raffles/:id` | Detalhes da rifa | Autenticado |
| POST | `/api/uploads` | Enviar arquivos | Autenticado |
| POST | `/api/payments/checkout` | Criar pagamento | Autenticado |
| GET | `/api/payments/:id` | Consultar pagamento | Autenticado, conforme autorização do recurso |
| GET | `/api/my/tickets` | Tickets do comprador | Autenticado |
| GET | `/api/payments/mercadopago/connect/start` | Iniciar OAuth | Organizador |
| POST | `/api/webhooks/mercadopago` | Receber notificações | Validação do webhook |

O fluxo PIX exige `X-Idempotency-Key` de 16 a 80 caracteres alfanuméricos, `_` ou `-`. Reutilize a mesma chave ao repetir a mesma compra; usá-la com outra seleção retorna `409`.

### Serviços externos

- **Mercado Pago:** o checkout usa Payments (`/v1/payments`) com OAuth do vendedor e `application_fee`. Os testes externos de Orders não validam integralmente esse fluxo.
- **Stripe e PagBank:** existem configurações e rotas no código. Sua presença não representa homologação; o roteiro documentado concentra-se em PIX/Mercado Pago.
- **MySQL:** persiste clientes, usuários, rifas, tickets, pagamentos e estado das migrações.

Timeouts e estados inconclusivos do gateway preservam reservas. A reconciliação libera números após confirmação de falha/cancelamento; envio de uma comissão no payload não comprova seu repasse financeiro.

## Deploy e operação

O arquivo [docker-compose.install.yml](docker-compose.install.yml) consome `apprifa-app:latest`, sem fazer build. Para preparar essa imagem localmente:

```bash
docker build -t apprifa-app:1.0.0 .
docker tag apprifa-app:1.0.0 apprifa-app:latest
docker compose -f docker-compose.install.yml config
docker compose -f docker-compose.install.yml up -d
```

Use esse arquivo como uma instalação alternativa ao Compose de desenvolvimento: ambos definem os mesmos nomes de containers. Configure `DB_HOST=mysql`, o banco e os segredos em `.env` antes de iniciar.

Nessa instalação, o MySQL não publica porta no host. A aplicação é publicada por padrão em `127.0.0.1:3000`; `APP_BIND_ADDRESS` e `APP_PORT` controlam esse mapeamento. O volume do banco se chama `apprifa_mysql_data` e a rede, `apprifa_network`. O healthcheck do Compose consulta a porta interna 3000.

- **Publicação externa:** configure proxy reverso com HTTPS e as URLs do provedor. O Compose não fornece esse proxy.
- **Persistência:** preserve o volume MySQL, `uploads/` e a chave OAuth. Faça backup consistente do banco e mantenha cópia protegida da configuração.
- **Atualizações:** avalie migrações e compatibilidade antes de iniciar a nova imagem. Preserve a imagem anterior com uma tag identificável.
- **Rollback:** a versão anterior deve entender o schema e os tokens cifrados com a mesma chave. Não restaure um backup antigo sobre pagamentos posteriores sem um procedimento de reconciliação.
- **Monitoramento:** acompanhe `/api/health`, logs da aplicação, disponibilidade do banco e pagamentos pendentes.

Não remova volumes para atualizar ou corrigir uma instalação. Antes de alterar Compose, siga as instruções de [AGENTS.md](AGENTS.md), incluindo `docker compose config` e revisão da persistência.

## CI/CD

O [pipeline GitHub Actions](.github/workflows/ci-cd.yml) verifica sintaxe, executa testes isolados e auditoria npm, e publica a imagem testada no GHCR. O deploy é acionado manualmente e usa um runner na rede local para acessar o servidor por SSH.

Execute a validação completa localmente com `npm run test:ci`. A configuração do runner local, Secrets, Variables, preparação do servidor e procedimento de rollback está em [CI_CD.md](CI_CD.md).

## Solução de problemas

| Sintoma | Possível causa | Como verificar / resolver |
| --- | --- | --- |
| `DB connection failed` | Banco indisponível ou configuração divergente | Confira host, porta, credenciais e logs do MySQL; no container, use o nome do serviço |
| Upload retorna erro de permissão | Bind mount sem escrita para UID/GID 65534 | Confira propriedade e permissões de `uploads/` no host |
| Porta 3000 ou 3306 ocupada | Outra aplicação ou container usa a porta | Identifique o processo e ajuste o ambiente antes de iniciar |
| Login da plataforma recusado | Credenciais diferentes das configuradas | Confira `PLATFORM_ADMIN_EMAIL` e `PLATFORM_ADMIN_PASSWORD` |
| `tests/pix.integration.test.js` ausente | Testes não incluídos na imagem de produção | Prepare um ambiente de teste que disponibilize esses arquivos |
| OAuth ou webhook falha | URLs, credenciais ou assinatura divergentes | Execute a verificação de configuração e consulte o roteiro de homologação |
| `docker-credential-desktop.exe: exec format error` | Docker Linux configurado com helper Windows | Corrija o helper na configuração do cliente Docker; o problema ocorre antes do build da aplicação |

## Contribuição

Ao propor uma alteração, descreva o problema, o comportamento esperado e como validá-la. Preserve o gerenciador npm e o lockfile; execute os testes pertinentes em ambiente dedicado. Mudanças de banco devem considerar migrações, dados existentes e rollback.

Siga [AGENTS.md](AGENTS.md) para alterações Docker. Não inclua `.env`, tokens, dados de compradores ou arquivos de uploads em contribuições. O repositório não define um canal público de reporte privado de vulnerabilidades; combine esse canal com o responsável pela manutenção.

## Licença

Não há arquivo de licença identificado nem licença declarada em `package.json`. Consulte o responsável pelo projeto sobre os termos de uso e distribuição.

## Contato

As interfaces identificam **Bueno Tecnologia**. Um canal oficial de suporte não está definido nos arquivos do projeto.

Documentação complementar:

- [Homologação PIX e OAuth](HOMOLOGACAO_PIX.md)
- [Notas Mercado Pago](mercadopago.md)
- [Registro de progresso](PROGRESSO.md)
- [Template de README](README.template.md)
