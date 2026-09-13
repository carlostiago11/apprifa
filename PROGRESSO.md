# Progresso do AppRifa

Última atualização: 5 de setembro de 2026.

## Objetivo do projeto

O AppRifa está sendo organizado como uma plataforma multi-tenant de rifas online. Cada cliente possui seu próprio ambiente lógico, seus usuários, produtos, rifas e conta de recebimento. A plataforma possui administração global e cobra comissão sobre os pagamentos.

## Atualizações de 5 de setembro de 2026 — integração Mercado Pago

- Instância principal alterada de `PAYMENT_PROVIDER=mock` para `PAYMENT_PROVIDER=mercadopago` para homologação controlada. Conta marketplace autenticada como brasileira de teste e webhook público assinado validado com HTTP 200; nenhuma cobrança foi criada nesta ativação.
- Webhook desacoplado da ativação do checkout para permitir homologação com `PAYMENT_PROVIDER=mock`; notificações assinadas do simulador (`live_mode=false`) sem pagamento local são auditadas como ignoradas e recebem HTTP 200. Teste público assinado respondeu 200.
- Autorização do organizador ganhou progresso por etapas (0%, 10%, 30%, 65% e 100%), mensagens persistentes de sucesso/erro no retorno OAuth e diagnóstico explícito das configurações ausentes. O botão não fica mais silenciosamente desabilitado.
- A aba **Conectar PIX** do organizador agora possui cadastro do titular do recebimento (PF/PJ, nome/razão social, CPF/CNPJ, e-mail Mercado Pago, telefone e confirmação de identidade validada), persistido por tenant e obrigatório antes do OAuth. O callback confirma `user_id` e país pela API; senhas, tokens e códigos continuam fora do formulário.
- Suíte isolada do marketplace consolidada em `npm run test:pix:isolated`: aguarda a API/MySQL, usa as imagens locais e remove somente os containers de teste ao terminar, preservando o volume.
- As 10 verificações Mercado Pago passaram integralmente, incluindo checkout durável, split de 10%, webhook, expiração, conciliação, OAuth/PKCE e painel global.
- Rotas `/api/*` inexistentes agora retornam erro JSON com HTTP 404 e não são encaminhadas ao HTML da SPA.
- Adequação PIX implementada no código: nome, sobrenome e CPF/CNPJ consultados no cadastro do comprador; pagamento e tickets persistidos antes do POST externo; chave idempotente e corpo da cobrança reutilizados em retentativas.
- Expiração explícita e reconciliação periódica adicionadas. Reservas incertas são preservadas; liberação ocorre após recusa/cancelamento confirmado pelo gateway.
- Aplicação de respostas/webhooks em transação, sem regressão de pagamentos pagos; assinatura, vendedor, moeda, método, valor e referência são validados.
- Tokens OAuth passam a usar AES-256-GCM mediante chave de ambiente; renovação concorrente é serializada e tokens legados são cifrados no boot com a chave configurada.
- Interface atualiza a grade após `409`, mantém a tentativa no navegador, recupera o pagamento pendente e oferece o link retornado pelo Mercado Pago.
- Treze testes de regressão passaram no Docker isolado com provider mock. Testes locais de criptografia/payload passaram.
- Após a implementação da gestão de contas de teste, suíte específica ampliada e executada: **12 testes aprovados** (9 com MySQL isolado/gateway simulado e 3 de criptografia/payload).
- SDK Node.js Mercado Pago 3.6.0 instalado. Token local autenticou uma conta brasileira marcada `test_user`.
- Teste externo conforme documentação Orders/Pix: criação de R$ 50,00 com dados fictícios, QR Code/link retornados, mesma order na retentativa idempotente e consulta com resultado final **`processed / accredited`**. Simulação de homologação; não comprova liquidação financeira nem split.
- Scripts `test:mercadopago:account` e `test:mercadopago:orders` adicionados, com tentativa persistente e saída sem segredos. O checkout do app ainda usa Payments API; o teste externo de Orders não substitui sua homologação ponta a ponta.
- Nova aba **Mercado Pago** implementada na administração global. Ela permite cadastrar contas de teste Comprador, Vendedor e Marketplace e selecionar o cliente que receberá a conexão OAuth.
- A aba **Conectar PIX** do organizador também recebeu o cadastro de contas de homologação. As contas ficam isoladas por cliente; senha e código de verificação são cifrados e nunca retornam pela API.
- User ID e usuário de teste são exibidos para conferência. Senha e código aparecem somente como “cadastrados”. O sistema exige o usuário completo, sem o texto truncado mostrado pelo painel Mercado Pago.
- URLs configuradas para `https://app.sanesul.ms.gov.br/`; domínio confirmado apontando para o Docker deste computador. O healthcheck público respondeu corretamente.
- Chave OAuth gerada e configurada localmente. A instância principal foi reconstruída e publicada, preservando `mysql_data` e uploads; a API administrativa da nova aba respondeu HTTP 200.
- Instância principal permanece em `PAYMENT_PROVIDER=mock`. App ID, Client Secret e Webhook Secret ainda precisam ser preenchidos para habilitar OAuth, webhook e pagamentos Mercado Pago.
- Roteiro e limitações registrados em [HOMOLOGACAO_PIX.md](HOMOLOGACAO_PIX.md); `npm run check:mercadopago` verifica configuração sem revelar segredos.

## Atualizações de 4 de setembro de 2026

- Interface inicial modernizada, com nova identidade visual, fundo relacionado a rifas, menus atualizados e maior destaque para o nome **Aplicativo Rifa da Bueno Tecnologia**.
- Texto de apresentação reformulado para explicar o sistema de maneira objetiva e comercial.
- Administração global removida da página pública e transferida para `http://localhost:3000/gestao.html`.
- Gestão de clientes ampliada com listagem, edição dos dados cadastrais, alteração de senha do owner e consulta das rifas pertencentes a cada cliente.
- Gestão de usuários cadastrados adicionada à administração, com listagem e edição de dados, papel de acesso, endereço e senha.
- CPF/CNPJ e endereço completo adicionados ao cadastro e à edição de clientes e usuários.
- Geração de etiqueta de endereçamento em PDF adicionada ao lado do nome de cada ganhador, contendo dados do destinatário, remetente, rifa, colocação e número vencedor.
- Área do cliente reorganizada nas abas **Conectar PIX**, **Gerar rifa**, **Rifas abertas** e **Rifas encerradas**.
- Rifas encerradas deixaram de aparecer para compradores comuns, exceto quando o usuário autenticado é um dos ganhadores.
- A modalidade `NUMERICA_1000` foi transformada em **Rifa personalizada**: o cliente escolhe o total de números entre 1 e 1.000, sempre começando em 1.
- Validações adicionadas no frontend e no backend para impedir quantidades personalizadas fora da faixa permitida e compras acima do limite da rifa.
- Fluxo de concorrência revisado e documentado: transação, bloqueio da rifa e índice único impedem que dois compradores adquiram o mesmo número.
- `README.md` atualizado com o comportamento de compras simultâneas, reservas pendentes, resposta HTTP `409` e limitações atuais.
- Suíte ampliada para 13 cenários, incluindo gestão de clientes, gestão de usuários e rifa personalizada.
- Containers de teste executados de forma isolada; o container principal foi reconstruído e publicado sem remoção dos volumes persistentes.

## Decisões tomadas

### Perfis de acesso

Foram definidos três acessos:

1. **Comprador (`user`)**: cadastra-se no tenant, escolhe números, paga e acompanha suas cotas.
2. **Cliente (`owner`/`admin`)**: administra produtos e rifas e conecta sua conta de pagamentos.
3. **Administrador da plataforma (`platform_admin`)**: cria, lista, ativa e suspende clientes.

O cadastro público de clientes foi removido. Somente o administrador da plataforma pode criar um tenant e seu primeiro usuário `owner`.

### Tipos de rifa

Foram mantidas as três modalidades existentes:

- `BICHO_25`: números de 1 a 25 e resultado informado pelo gestor.
- `NUMERICA_100`: números de 1 a 100 e sorteio automático.
- `NUMERICA_1000`: rifa personalizada, numerada de 1 até o limite escolhido pelo cliente (entre 1 e 1000), com sorteio automático.

### Pagamentos

A decisão atual é usar **PIX dinâmico via Mercado Pago Marketplace**, e não PIX estático por chave.

Fluxo planejado e implementado:

1. O cliente autoriza sua conta Mercado Pago via OAuth.
2. O comprador seleciona números.
3. O backend cria uma cobrança PIX na conta autorizada do cliente.
4. O gateway devolve QR Code, PIX copia-e-cola e link de pagamento.
5. Os números ficam reservados enquanto a cobrança está pendente.
6. O Mercado Pago envia um webhook.
7. O backend valida a assinatura e consulta o pagamento na API.
8. Pagamentos aprovados confirmam os tickets; falhas liberam os números.

A comissão da plataforma foi definida como **10% de cada pagamento**, usando `application_fee`. Essa abordagem substitui uma cobrança separada de comissão e evita inadimplência do cliente perante a plataforma.

### Desconto por quantidade

Compras com três ou mais números recebem 10% de desconto. O cálculo oficial é feito no backend e também é exibido no resumo do frontend.

Exemplo:

```text
3 números x R$ 10,00 = R$ 30,00
Desconto de 10%      = R$ 3,00
Total do PIX         = R$ 27,00
```

A comissão de marketplace é calculada sobre o valor efetivamente cobrado após o desconto.

## Funcionalidades implementadas

### Administração da plataforma

- Página administrativa exclusiva em `/gestao.html`, sem aba ou link exposto na página pública.
- Login separado por JWT com escopo `platform_admin`.
- Cadastro de tenant e owner em uma transação.
- Listagem de clientes, responsáveis e respectivas rifas.
- Edição dos dados do cliente e do owner, incluindo CPF/CNPJ, endereço completo e senha.
- Gestão centralizada dos usuários cadastrados, com edição de dados, endereço, papel e senha.
- Ativação e suspensão de tenants.
- Painel oculto até autenticação válida.
- Logout administrativo.

### Usuários e permissões

- Cadastro e login por tenant.
- Cadastro obrigatório de telefone, CPF/CNPJ e endereço completo.
- Isolamento das consultas por `tenantId`.
- Papéis `user`, `admin` e `owner`.
- Usuário comum não pode criar produto, rifa ou informar resultado.
- Módulo de resultado do jogo do bicho aparece apenas para `admin` e `owner`.
- Somente owner pode alterar outro owner.
- Proteção contra remoção do último owner do cliente.
- Removida a criação de administrador por token compartilhado no cadastro público.

### Produtos e rifas

- Cadastro de produtos e mídias.
- Criação das três modalidades de rifa.
- Rifa personalizada com total configurável de 1 a 1.000 números.
- Separação das rifas do cliente entre abertas e encerradas.
- Rifas encerradas visíveis ao comprador somente quando ele for ganhador.
- Reserva concorrente de números com transação e índice único.
- Sorteio automático das rifas numéricas quando todas as cotas estão pagas.
- Resultado manual protegido para `BICHO_25`.
- Exibição de vencedores.
- Geração de etiqueta de endereçamento em PDF para envio do prêmio ao ganhador.

### Mercado Pago Marketplace

- Variáveis de ambiente para aplicação, OAuth, webhook e comissão.
- Início do OAuth por tenant.
- Callback OAuth com `state` assinado e validade de 15 minutos.
- Armazenamento da conta Mercado Pago associada ao tenant.
- Renovação automática do Access Token próximo ao vencimento.
- Criação de pagamento em `POST /v1/payments`.
- Uso do header `X-Idempotency-Key`.
- `payment_method_id: pix`.
- Comissão por `application_fee`.
- Captura de `qr_code`, `qr_code_base64` e `ticket_url`.
- Webhook com validação HMAC SHA-256.
- Consulta do pagamento no gateway antes da confirmação local.
- Verificação de valor e referência externa.
- Tratamento de pagamento aprovado, pendente, recusado ou cancelado.

O código legado de Stripe e PagBank ainda existe no backend para compatibilidade, mas o provider escolhido para a próxima fase é Mercado Pago.

### Interface

- Tela inicial modernizada com identidade da Bueno Tecnologia, nova descrição, fundo temático e menus atualizados.
- Nome **Aplicativo Rifa da Bueno Tecnologia** exibido com fonte maior e em negrito.
- Tela inicial pública sem acesso visual à administração global.
- Área de comprador.
- Área do cliente organizada em abas para conectar PIX, gerar rifa, consultar rifas abertas e consultar rifas encerradas.
- Área do administrador da plataforma separada em `public/gestao.html`.
- Formulários de clientes e usuários com CPF/CNPJ e endereço necessário para entrega.
- Checkout limitado a PIX.
- Resumo com números, subtotal, desconto e total.
- Polling do status do pagamento.
- QR Code e PIX copia-e-cola.
- Botão para gerar a etiqueta PDF ao lado dos vencedores.
- Remoção do `index.html` duplicado; o frontend oficial é `public/index.html`.

### Documentação do código

O `server.js` foi dividido visualmente e documentado com comentários sobre:

- configuração;
- modelos;
- relacionamentos;
- autenticação;
- gateways;
- rotas;
- checkout;
- webhooks;
- compatibilidade do banco;
- inicialização.

O `README.md` foi atualizado com arquitetura, perfis, PIX, desconto, execução, endpoints e proteção contra compras simultâneas do mesmo número.

## Docker e persistência

- Serviços principais: `app` e `mysql`.
- Serviços isolados de teste: `app-test` e `mysql-test`.
- Volume principal preservado: `mysql_data`.
- Volume de teste preservado: `mysql_test_data`.
- Uploads persistidos por bind mount em `./uploads`.
- O Compose foi validado antes das atualizações.
- Nenhum volume foi removido.
- Nunca foi executado `docker compose down -v`, `docker system prune -a` ou `docker volume prune`.
- O container principal foi reconstruído após as alterações e o healthcheck respondeu corretamente.

## Testes realizados

A suíte de integração isolada possui treze cenários e passou integralmente:

1. Healthcheck.
2. Proteção da administração global.
3. Gestão da plataforma alterando cliente, senha e listando suas rifas.
4. Gestão da plataforma listando e atualizando usuários cadastrados.
5. Cadastro e login multi-tenant.
6. Isolamento entre tenants.
7. Permissões de comprador e gestor.
8. Rifa personalizada aceitando uma faixa entre 1 e 1.000 e bloqueando números fora do limite.
9. Concorrência na compra do mesmo número.
10. Rejeição de pagamento por cartão.
11. Desconto de 10% a partir de três números.
12. Sorteio automático numérico.
13. Resultado da modalidade `BICHO_25`.

Resultado mais recente: **13 testes aprovados, nenhuma falha**.

Os testes usam `PAYMENT_PROVIDER=mock`; a integração real do Mercado Pago ainda não foi homologada ponta a ponta.

## Estado atual do ambiente

O ambiente principal continua em:

```env
PAYMENT_PROVIDER=mock
```

Isso evita chamadas reais enquanto faltam credenciais e uma URL pública. Credenciais, senhas, tokens e códigos de verificação não devem ser registrados neste documento.

## Problemas e pendências

### Bloqueadores para testar Mercado Pago real

- Obter o `MERCADOPAGO_CLIENT_SECRET` da aplicação.
- Obter o `MERCADOPAGO_WEBHOOK_SECRET` na configuração de Webhooks.
- Disponibilizar uma URL pública HTTPS para OAuth e webhook.
- Cadastrar no painel Mercado Pago exatamente as URLs de redirect e webhook.
- Confirmar que a conta e o modelo de rifas foram aprovados pelo Mercado Pago.
- Criar e conectar contas de vendedor de teste via OAuth.

### Aderência à documentação PIX

As adequações de payload, expiração, link alternativo e idempotência persistente foram implementadas em 5 de setembro. A suíte específica com MySQL passou. O exemplo externo Orders/Pix passou até a aprovação simulada; continuam pendentes webhook externo, split/OAuth e homologação ponta a ponta do checkout Payments do aplicativo. Consulte [HOMOLOGACAO_PIX.md](HOMOLOGACAO_PIX.md).

### Segurança

- Criptografia OAuth implementada; falta configurar a chave e validar a migração no ambiente alvo antes de publicar.
- JWT ainda possui fallback de desenvolvimento e deve falhar ao iniciar em produção sem segredo forte.
- JWT do usuário permanece no `localStorage`; o ideal é migrar para cookie `HttpOnly`, `Secure` e `SameSite`.
- CORS está aberto.
- Faltam rate limiting e proteção contra tentativas de login.
- Uploads precisam de limite de tamanho, allowlist real de MIME/extensão e acesso restrito a gestores.
- O frontend ainda possui pontos de `innerHTML` que devem ser sanitizados contra XSS.
- Respostas de erro não devem expor detalhes internos em produção.

### Pagamentos e consistência

- Fluxo Mercado Pago agora salva pagamento e reserva antes de chamar o gateway. Os providers legados ainda mantêm a chamada dentro da transação.
- Retentativas e reconciliação reaproveitam chave e payload persistidos. Webhook antecipado recebe `503` para nova entrega, e a reconciliação recupera a cobrança.
- Respostas duplicadas usam atualização transacional e estados sem regressão. Ainda não existe um histórico separado de eventos de webhook.
- Expiração e atualização da grade após `409` implementadas, aguardando validação específica e publicação.
- Cobranças incertas ou com dados divergentes preservam reservas e podem exigir análise manual. Estornos e disputas precisam de fluxo operacional próprio.
- Se algum número da seleção estiver ocupado, a compra inteira é rejeitada, sem confirmação parcial.

### Sorteios e conformidade

- O sorteio automático ainda usa `Math.random()` e não é auditável.
- Deve ser substituído por mecanismo criptograficamente seguro, documentado e verificável.
- É necessária validação jurídica e regulatória do modelo de rifas.
- A aceitação técnica do gateway não substitui autorização legal ou aprovação comercial do provedor.

### Banco e arquitetura

- `server.js` continua concentrando modelos, rotas e serviços em um único arquivo grande.
- Alterações de schema são realizadas no boot; devem migrar para migrations versionadas.
- O código legado Stripe/PagBank deve ser removido após a homologação definitiva do Mercado Pago.
- Índice único de provider `(tenantId, provider)` adicionado ao boot; verificar duplicidades legadas antes de publicar.
- O healthcheck atual não confirma conexão com o banco.
- MySQL está exposto na porta do host e não possui healthcheck no Compose.

## Próximo passo recomendado

Prosseguir com a configuração e homologação da integração Mercado Pago:

1. Cadastrar na nova aba os usuários completos das contas Comprador e Vendedor mostradas no painel Mercado Pago. Senhas e códigos não devem ser registrados no código ou neste documento.
2. Preencher App ID, Client Secret e Webhook Secret no arquivo `.env` local, sem enviar os valores pelo chat.
3. Cadastrar no painel Mercado Pago o retorno OAuth `https://app.sanesul.ms.gov.br/api/payments/mercadopago/connect/callback` e o webhook `https://app.sanesul.ms.gov.br/api/webhooks/mercadopago?source_news=webhooks`.
4. Reconstruir o container após preencher os segredos e conectar a conta vendedora pelo botão OAuth, selecionando o cliente correspondente.
5. Prosseguir com OAuth e webhook do checkout Payments; o cenário externo Orders/Pix e a suíte Pix/MySQL já passaram.
6. Validar cobrança, assinatura, retentativa, expiração, renovação e split de 10%, respeitando os cenários que o sandbox realmente oferece.
7. Registrar evidências e limitações no roteiro antes de publicar e habilitar o gateway na instância principal.

As adequações e a nova interface foram implementadas, testadas e publicadas no Docker local. O cenário externo Orders/Pix passou, mas **webhook externo, OAuth e split continuam pendentes**. Procedimento detalhado: [HOMOLOGACAO_PIX.md](HOMOLOGACAO_PIX.md).
