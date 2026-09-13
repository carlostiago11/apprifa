# Integração Mercado Pago — homologação PIX

Atualizado em 5 de setembro de 2026.

## Situação

- Ambiente principal está em `PAYMENT_PROVIDER=mercadopago` para homologação controlada. A conta marketplace autenticou como brasileira de teste e o webhook público assinado respondeu HTTP 200; ainda falta concluir OAuth do organizador e uma compra PIX ponta a ponta.
- Adequações implementadas: dados do comprador consultados no cadastro, pagamento e reserva persistidos antes da chamada externa, chave e corpo reutilizados, expiração, reconciliação, criptografia OAuth e tratamento de conflito na interface.
- Regressão: **13 testes aprovados** no Docker isolado com provider mock.
- Pré-homologação automatizada executada com `npm run validate:mercadopago -- .env`: configuração aprovada, **4 testes locais** e **10 testes de integração isolada** aprovados; nenhum pagamento externo foi criado.
- Testes locais de criptografia e payload executados sem falhas.
- Suíte específica executada após retomada autorizada: **11 testes aprovados**, sendo 8 de integração com MySQL isolado e gateway simulado e 3 de criptografia/payload.
- Teste externo **Orders/Pix realizado** com o SDK Node.js 3.6.0 e o Access Token configurado localmente. Autenticação confirmou conta brasileira marcada `test_user`. Criação retornou QR Code/link; retentativa confirmou o mesmo ID; consulta confirmou R$ 50,00, referência e evolução de `action_required / waiting_transfer` para `processed / accredited`. Trata-se de simulação do provedor, sem liquidação financeira real.
- Webhook externo, OAuth e split marketplace **não homologados**. Faltam App ID, Client Secret, Webhook Secret, chave OAuth e URLs públicas HTTPS.
- Verificação somente leitura da conta marketplace executada: autenticação válida, país `BR`, site `MLB` e conta de teste confirmada. O próximo passo externo é OAuth do organizador e webhook em URL de teste HTTPS.

## Roteiro do organizador — criar conta e autorizar o AppRifa

Este roteiro é para o organizador que receberá os pagamentos das próprias rifas.
O organizador não deve criar uma aplicação de integração, copiar Access Token ou
informar Client Secret no AppRifa. A aplicação OAuth, o webhook e a conta
marketplace pertencem à plataforma AppRifa.

### Antes de começar

- Tenha um documento válido e os dados do titular da conta.
- Use um e-mail e telefone aos quais você tenha acesso.
- Para homologação, use a conta de vendedor de teste fornecida pela plataforma.
- Para operação real, confirme que a conta Mercado Pago é brasileira e está no
  mesmo titular informado ao AppRifa.
- Não envie senha, código de verificação, Access Token ou Refresh Token para a
  equipe nem os registre em planilhas ou chamados.

### 1. Criar a conta Mercado Pago

1. Acesse o site ou aplicativo oficial do Mercado Pago: [mercadopago.com.br](https://www.mercadopago.com.br/).
2. Escolha **Criar conta** e cadastre o e-mail e telefone do titular.
3. Confirme o e-mail e o telefone pelos canais oficiais do Mercado Pago.
4. Complete o cadastro com nome completo, data de nascimento e CPF ou CNPJ,
	conforme o tipo de titular.
5. Conclua a validação de identidade solicitada pelo Mercado Pago. A conta deve
	estar habilitada para receber pagamentos.
6. Ative a segurança recomendada, incluindo senha exclusiva e verificação em duas
	etapas quando disponível.

Não é necessário cadastrar uma chave PIX para esta integração. O AppRifa cria um
PIX dinâmico para cada compra usando a conta Mercado Pago autorizada.

### 2. Preparar os dados no AppRifa

1. Entre no AppRifa com o usuário `owner` ou administrador do seu cliente.
2. Abra a aba **Conectar PIX**.
3. Informe o tipo de titular: **Pessoa Física** ou **Pessoa Jurídica**.
4. Preencha nome ou razão social, CPF/CNPJ, e-mail e telefone exatamente como
	aparecem na conta Mercado Pago.
5. Confirme que a identidade da conta Mercado Pago foi validada.
6. Clique em **Conectar conta Mercado Pago**.

Esses dados ajudam o AppRifa a conferir se a conta autorizada pertence ao
organizador correto. Eles não substituem a autorização OAuth.

### 3. Autorizar por OAuth

1. Após clicar em conectar, o AppRifa abrirá a página oficial de autorização do
	Mercado Pago.
2. Entre na conta Mercado Pago que receberá os pagamentos.
3. Confira que a autorização está sendo feita para o AppRifa e leia as permissões
	apresentadas.
4. Clique em **Autorizar** ou **Permitir**.
5. Aguarde o retorno automático ao AppRifa. Não feche a janela durante o retorno.
6. Na aba **Conectar PIX**, confirme a mensagem **Conta Mercado Pago autorizada
	e validada com sucesso**.

Durante esse processo, o Mercado Pago envia um código temporário ao AppRifa. O
backend troca esse código pelos tokens OAuth, consulta a conta autorizada e
armazena os tokens cifrados vinculados somente ao cliente correto.

### 4. Confirmar a conexão

Considere a configuração concluída somente quando:

- o painel mostrar a conta como conectada;
- o nome/titular exibido corresponder à conta autorizada;
- a plataforma confirmar que o vendedor de teste está pronto para homologação;
- uma compra PIX de teste for criada sem erro, quando essa etapa estiver liberada.

O primeiro pagamento de homologação deve usar uma rifa de teste, um comprador de
teste e o valor definido pela plataforma. Não use dados de compradores reais para
esse ensaio.

### Se a autorização falhar

- Volte ao AppRifa pelo botão ou endereço oficial, sem reutilizar códigos OAuth.
- Confira se o CPF/CNPJ, e-mail e telefone informados correspondem ao titular da
  conta Mercado Pago.
- Verifique se você está conectado à conta de vendedor correta, especialmente se
  houver mais de uma conta no navegador.
- Não tente preencher Access Token, Refresh Token ou Client Secret manualmente.
- Envie à plataforma apenas a mensagem de erro, o horário aproximado e o cliente
  AppRifa afetado; nunca envie senha, token, código de autorização ou QR Code.
- Se o erro indicar configuração do aplicativo, URL de retorno ou credenciais,
  a correção deve ser feita pela plataforma, não pelo organizador.

### Dados solicitados ao organizador

Na aba **Conectar PIX**, o organizador informa tipo de titular (PF/PJ), nome ou razão social, CPF/CNPJ, e-mail e telefone da conta Mercado Pago, além de confirmar que a identidade da conta está validada. Depois, autoriza o AppRifa na página oficial do Mercado Pago.

O `user_id`, Access Token, Refresh Token, escopos e validade não são digitados no formulário: são obtidos pelo backend no OAuth, conferidos em `/users/me` e armazenados com os tokens cifrados. Não é solicitada chave PIX, pois o PIX dinâmico é criado diretamente na conta Mercado Pago autorizada.

## 1. Aplicação e contas

### Aplicação de homologação selecionada

Para este teste, a aplicação da conta administradora é:

```text
Nome: apprifavendedor
App ID: 8365507066784221
Owner ID: 9126761
```

O MCP confirmou que a aplicação existe e possui credenciais de teste. As
credenciais de produção ainda não estão ativadas; conclua a configuração no
[painel da aplicação Mercado Pago](https://www.mercadopago.com.br/developers/panel/app/8365507066784221)
antes de tentar OAuth com uma conta produtiva. O Access Token de teste deve
permanecer somente no ambiente local protegido e nunca ser publicado ou
registrado neste documento.

Na aplicação do marketplace em **Suas integrações**, configurar a integração compatível com Split de Pagamentos 1:1 e OAuth. Confirmar com o Mercado Pago a aprovação da conta e do modelo comercial antes de pagamentos reais.

### Aplicação de produção selecionada

A aplicação de produção da conta administradora é:

```text
Nome: appbueno
App ID: 737662249703716
Owner ID: 9126761
```

O MCP confirmou que a aplicação possui credenciais de produção. Antes de ativá-la
no servidor, rotacione qualquer Client Secret, Access Token, Public Key ou Webhook
Secret que tenha sido colado em chat, terminal, documentação ou outro local fora
do cofre de segredos. O arquivo `.env` atual ainda aponta para a aplicação antiga
e possui duas definições de `MERCADOPAGO_ACCESS_TOKEN`; mantenha somente uma
definição, com a credencial nova armazenada fora do repositório.

Depois da rotação, configure no ambiente de produção, sem registrar os valores
neste documento:

- `MERCADOPAGO_APP_ID=737662249703716`
- Client Secret correspondente à aplicação `appbueno`.
- Access Token da conta marketplace correspondente à aplicação `appbueno`.
- Public Key correspondente ao ambiente usado pelo checkout.
- Webhook Secret criado para a aplicação `appbueno`.

Confirme também no painel do Mercado Pago as URLs exatas de OAuth e webhook antes
de reiniciar o serviço. A validação deve ser feita com `npm run check:mercadopago
-- .env`, seguida de uma consulta somente leitura da conta marketplace. Não use a
credencial de teste em produção.

Preparar contas brasileiras de teste de integrador, vendedor e comprador. Registrar aqui somente a conclusão das etapas, nunca senhas, tokens, códigos OAuth ou códigos de verificação.

O projeto usa `POST /v1/payments` e `application_fee`. A documentação atual também apresenta `/v1/orders`; os exemplos e simuladores de Orders não comprovam o comportamento desta integração Payments. Confirmar os cenários de Pix disponíveis para a aplicação e as contas utilizadas. Não considerar um QR Code de teste como comprovante de liquidação ou de split efetivo.

Fontes oficiais: [Split 1:1](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/integrate-marketplace), [configuração OAuth](https://www.mercadopago.com.br/developers/en/docs/split-payments/split-1-1/integration-configuration/create-configuration), [contas de teste](https://www.mercadopago.com.br/developers/pt/docs/split-payments/additional-content/your-integrations/test/accounts), [Pix via Payments](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/pix).

## 2. HTTPS e segredos

Definir um domínio HTTPS estável ou túnel apontando para uma instância isolada. Cadastrar exatamente:

```text
Redirect OAuth: https://DOMINIO/api/payments/mercadopago/connect/callback
Webhook:        https://DOMINIO/api/webhooks/mercadopago?source_news=webhooks
```

Preencher em arquivo de ambiente local ignorado pelo Git:

```dotenv
MERCADOPAGO_APP_ID=
MERCADOPAGO_CLIENT_SECRET=
MERCADOPAGO_WEBHOOK_SECRET=
MERCADOPAGO_REDIRECT_URI=https://DOMINIO/api/payments/mercadopago/connect/callback
MERCADOPAGO_NOTIFICATION_URL=https://DOMINIO/api/webhooks/mercadopago?source_news=webhooks
OAUTH_TOKEN_ENCRYPTION_KEY=
MARKETPLACE_FEE_PERCENT=10
PIX_EXPIRATION_MINUTES=30
PIX_RECONCILE_INTERVAL_MS=60000
```

A chave OAuth deve conter 32 bytes aleatórios codificados em base64, gerados localmente, com cópia de segurança protegida. A aplicação usa AES-256-GCM e cifra tokens legados ao iniciar com a chave configurada. Não substituir ou perder essa chave: tokens já cifrados dependem dela. Backups antigos podem conter tokens em texto claro.

Executar a verificação sem exibir valores secretos:

```bash
npm run check:mercadopago -- .env
```

Manter a instância principal em mock. Para exercitar OAuth e a API real, a **instância isolada de homologação** precisa usar `PAYMENT_PROVIDER=mercadopago`, banco próprio e as credenciais apropriadas de teste. Isso não habilita automaticamente um sandbox: o contexto depende das contas e credenciais utilizadas.

## 3. Validação técnica local concluída

Antes de qualquer chamada real, executar a pré-homologação completa em um ambiente
isolado:

```bash
npm run validate:mercadopago -- .env
```

O comando valida as credenciais e URLs sem exibir valores, executa os testes locais
de payload/criptografia e roda a integração PIX em `mysql-test`. Ele não cria
pagamentos externos. Se o ambiente principal estiver em `PAYMENT_PROVIDER=mock`,
isso não o altera.

Com a imagem atualizada e `app-test`/`mysql-test` já iniciados:

```bash
docker compose --profile test exec -T app-test node --test tests/pix.test.js tests/pix.integration.test.js
```

A suíte protege contra uso do banco principal e verifica criação durável, concorrência, timeout após criação remota, webhook inválido/duplicado, divergência de valor, expiração, recuperação sem webhook e renovação OAuth concorrente. Ela não faz chamadas reais ao Mercado Pago e não comprova repasse financeiro.

## Teste externo reproduzível — Orders

```bash
npm run test:mercadopago:account
npm run test:mercadopago:orders
```

O segundo comando só prossegue para uma conta brasileira marcada `test_user`. Usa o cenário oficial com pagador fictício `test_user_br@testuser.com`, `first_name=APRO`, R$ 50,00 e expiração `PT30M`. Persiste a tentativa em `tmp/mercadopago-orders-homologacao.json`, ignorado pelo Git e pelo Docker. Reexecuções reutilizam a tentativa e consultam a mesma order. Não apagar esse estado para resolver timeout, pois ele preserva a chave idempotente.

O resultado apresentado omite token, dados da conta e conteúdo do QR Code. O script não altera o banco de rifas, não conecta vendedores e não valida o webhook do aplicativo. A documentação fornecida usa `/v1/orders`; o checkout do aplicativo permanece em `/v1/payments`. Uma migração precisaria adaptar payload, estados, referência dos pagamentos, webhook de Orders e comissão; não basta trocar a URL.

Fonte do cenário executado: [Realizar compra de teste com Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix).

## 4. Roteiro externo

1. Entrar como owner no Portal do Cliente e usar **Conectar PIX**. Autorizar com o vendedor de teste e verificar o retorno à aplicação e a conta vinculada.
2. Criar uma rifa de teste com preço de R$ 10,00 e selecionar três números. Conferir cobrança de R$ 27,00 e `application_fee` solicitada de R$ 2,70.
3. Conferir nome, sobrenome, CPF/CNPJ, expiração, QR Code, copia-e-cola e link retornados pela API.
4. Repetir a mesma tentativa com `X-Idempotency-Key` original. Conferir um pagamento local, uma cobrança remota e as mesmas reservas.
5. Exercitar os cenários permitidos pelo provedor: pendente, aprovado, recusado/cancelado, notificações duplicadas e consulta após perda de notificação.
6. Verificar assinatura do webhook e pagamento consultado na API: referência, valor, moeda, método e vendedor devem corresponder ao registro local.
7. Conferir comissão nos dados/relatórios das contas de vendedor e integrador. Enviar `application_fee` não comprova que o split foi efetivamente liquidado.
8. Validar renovação OAuth e persistência após reinício. Simular falhas de rede somente na instância isolada.
9. Registrar evidências sem dados pessoais nem segredos. Se o sandbox não oferecer liquidação Pix/split, registrar essa limitação e combinar a validação restante com o provedor.

## Reservas e recuperação

O checkout exige `X-Idempotency-Key` de 16 a 80 caracteres alfanuméricos, `_` ou `-`. Repetir a mesma seleção com a mesma chave; reutilização com outra seleção retorna `409`. A chave do gateway e o corpo da requisição ficam persistidos separadamente.

A reconciliação consulta pagamentos pendentes em lotes de 50. Após o vencimento, consulta/cancela no gateway e libera números apenas após recusa ou cancelamento confirmado. Timeout, resposta divergente, status desconhecido ou cobrança não localizada preservam reservas para nova consulta/análise. Pagamentos aprovados não retrocedem nem liberam números por notificações antigas. Estornos e disputas ainda exigem tratamento operacional próprio.

## Publicação e rollback

Publicar apenas depois de concluir a validação técnica e as etapas externas aplicáveis. Antes, preservar backup do banco, imagem anterior e chave OAuth. O schema recebe colunas e índices adicionais; duplicidades legadas de conta por tenant/provider precisam ser resolvidas antes do índice único, sem exclusões automáticas.

Após cifrar tokens, a versão antiga não consegue lê-los. O rollback deve preservar suporte à criptografia e à mesma chave; voltar somente a imagem antiga não é suficiente. Não restaurar um banco desatualizado por cima de pagamentos criados depois do backup. Nenhum procedimento exige remoção de volumes.
