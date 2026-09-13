// Executar apenas no mysql-test; todas as chamadas ao Mercado Pago sao simuladas.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
if (process.env.DB_NAME !== 'apprifa_test' || process.env.DB_HOST !== 'mysql-test') {
  throw new Error('Use o container app-test conectado ao mysql-test');
}
process.env.PAYMENT_PROVIDER = 'mercadopago';
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.MERCADOPAGO_WEBHOOK_SECRET = 'webhook-ficticio';
process.env.MERCADOPAGO_APP_ID = 'app-ficticio';
process.env.MERCADOPAGO_CLIENT_SECRET = 'client-secret-ficticio';
process.env.MERCADOPAGO_ACCESS_TOKEN = 'marketplace-token-ficticio';
process.env.MERCADOPAGO_PUBLIC_KEY = 'public-key-ficticia';
process.env.MERCADOPAGO_REDIRECT_URI = 'https://app.example/api/payments/mercadopago/connect/callback';
process.env.MERCADOPAGO_NOTIFICATION_URL = 'https://app.example/api/webhooks/mercadopago';
const { app, sequelize, Tenant, User, Product, Raffle, Payment, Ticket, TenantPaymentProvider,
  MercadoPagoOAuthState, MercadoPagoWebhookEvent, PlatformPaymentConfiguration,
  processDurablePix, reconcilePixPayments, resolveTenantMercadoPagoProvider } = require('../server');
const originalFetch = global.fetch;
let server, base, tenant, user, raffle, provider, token;
let nextId = 9000;
let timeoutNext = false;
let unavailable = false;
let refreshCalls = 0;
let createCalls = 0;
let rejectInvalidDocumentNext = false;
const remotes = new Map();
const requests = new Map();
const creationBodies = [];
const key = () => crypto.randomUUID();

async function api(path, body, requestKey = key(), accessToken = token) {
  const response = await originalFetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'X-Idempotency-Key': requestKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = response.headers.get('content-type') || '';
  const responseBody = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, body: responseBody };
}
function checkout(numbers, requestKey, accessToken) {
  return api('/api/payments/checkout', { raffleId: raffle.id, numbers, method: 'pix' }, requestKey, accessToken);
}
async function webhook(id, valid = true, requestId = key(), ts = String(Math.floor(Date.now() / 1000)), liveMode) {
  const signature = crypto.createHmac('sha256', process.env.MERCADOPAGO_WEBHOOK_SECRET).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
  return originalFetch(`${base}/api/webhooks/mercadopago?data.id=${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${valid ? signature : '0'.repeat(64)}` },
    body: JSON.stringify({ action: 'payment.updated', data: { id }, ...(liveMode == null ? {} : { live_mode: liveMode }) }),
  });
}

test.before(async () => {
  await sequelize.authenticate();
  tenant = await Tenant.create({ name: 'Homologacao local', slug: `pix-${key()}`, marketplaceFeePercent: 8 });
  user = await User.create({ tenantId: tenant.id, name: 'Maria da Silva', email: `${key()}@test.example`, phone: '11999999999', passwordHash: 'unused', taxId: '52998224725', role: 'owner' });
  const product = await Product.create({ tenantId: tenant.id, title: 'Teste', description: 'Teste' });
  raffle = await Raffle.create({ tenantId: tenant.id, productId: product.id, type: 'NUMERICA_100', title: 'Teste', description: 'Teste', pricePerNumber: 10, totalNumbers: 100, drawMode: 'ALEATORIO' });
  provider = await TenantPaymentProvider.create({ tenantId: tenant.id, provider: 'mercadopago', accountId: '123', accessToken: 'access-ficticio', refreshToken: 'refresh-ficticio', expiresAt: new Date(Date.now() + 172800000) });
  // Deliberadamente sem nome/documento no JWT: dados precisam vir do cadastro.
  token = jwt.sign({ id: user.id, tenantId: tenant.id, role: 'owner' }, process.env.JWT_SECRET || 'dev_secret');
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('https://api.mercadopago.com/'), 'Nenhuma chamada externa inesperada');
    const parsed = new URL(url);
    if (unavailable) throw new Error('Indisponibilidade simulada');
    if (parsed.pathname === '/oauth/token') {
      const oauthBody = JSON.parse(options.body || '{}');
      if (oauthBody.grant_type === 'refresh_token') refreshCalls++;
      return Response.json({ access_token: 'novo-access', refresh_token: 'novo-refresh', expires_in: 15552000, user_id: 123, scope: 'offline_access' });
    }
    if (parsed.pathname === '/users/me') {
      const oauthSeller = options.headers?.Authorization === 'Bearer novo-access';
      return Response.json({ id: oauthSeller ? 123 : 456789, country_id: 'BR', site_id: 'MLB', tags: ['test_user'] });
    }
    if (parsed.pathname === '/v1/payments' && options.method === 'POST') {
      createCalls++;
      const body = JSON.parse(options.body);
      creationBodies.push(options.body);
      const local = await Payment.findByPk(Number(body.metadata.paymentId));
      assert.ok(local, 'Pagamento local precisa estar commitado antes da chamada externa');
      assert.equal(await Ticket.count({ where: { paymentId: local.id } }), body.metadata.numbers.split(',').length);
      assert.equal(local.idempotencyKey, options.headers['X-Idempotency-Key']);
      if (rejectInvalidDocumentNext) {
        rejectInvalidDocumentNext = false;
        return Response.json({ error: 'bad_request', cause: [{ code: 2067, description: 'Invalid user identification number' }] }, { status: 400 });
      }
      const requestKey = options.headers['X-Idempotency-Key'];
      let remote = requests.get(requestKey);
      if (!remote) {
        remote = { ...body, id: ++nextId, status: 'pending', collector_id: 123, currency_id: 'BRL',
          application_fee: body.application_fee, fee_details: [{ type: 'application_fee', amount: body.application_fee }, { type: 'mercadopago_fee', amount: 0.55 }],
          transaction_details: { net_received_amount: Number(body.transaction_amount) - Number(body.application_fee) - 0.55 },
          point_of_interaction: { transaction_data: { qr_code: 'PIX-TESTE', ticket_url: 'https://www.mercadopago.com.br/payments/test/ticket' } } };
        requests.set(requestKey, remote);
        remotes.set(String(remote.id), remote);
      }
      if (timeoutNext) { timeoutNext = false; throw new Error('Resposta perdida apos criacao remota'); }
      return Response.json(remote);
    }
    if (parsed.pathname === '/v1/payments/search') return Response.json({ results: [...remotes.values()].filter((p) => p.external_reference === parsed.searchParams.get('external_reference')) });
    const remote = remotes.get(parsed.pathname.split('/').pop());
    assert.ok(remote, 'Pagamento remoto conhecido');
    if (options.method === 'PUT') remote.status = 'cancelled';
    return Response.json(remote);
  };
});

test.after(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  // Remove somente os registros criados por esta suite; preserva banco e volumes.
  if (tenant) {
    await MercadoPagoOAuthState.destroy({ where: { tenantId: tenant.id } });
    await MercadoPagoWebhookEvent.destroy({ where: { externalPaymentId: [...remotes.keys()] } });
    await Ticket.destroy({ where: { tenantId: tenant.id } });
    await Payment.destroy({ where: { tenantId: tenant.id } });
    await Raffle.destroy({ where: { tenantId: tenant.id } });
    await Product.destroy({ where: { tenantId: tenant.id } });
    await TenantPaymentProvider.destroy({ where: { tenantId: tenant.id } });
    await User.destroy({ where: { tenantId: tenant.id } });
    await tenant.destroy();
  }
  await PlatformPaymentConfiguration.destroy({ where: { provider: 'mercadopago' } });
  await sequelize.close();
});

test('checkout duravel: desconto, identificacao, split solicitado e mesma compra em chamadas concorrentes', async () => {
  const requestKey = key();
  const results = await Promise.all([checkout([1, 2, 3], requestKey), checkout([3, 2, 1], requestKey)]);
  for (const result of results) assert.equal(result.status, 202, JSON.stringify(result));
  assert.equal(results[0].body.paymentId, results[1].body.paymentId);
  const payment = await Payment.findByPk(results[0].body.paymentId);
  assert.equal(createCalls, 1);
  assert.equal(payment.payload.gatewayRequest.payer.last_name, 'da Silva');
  assert.equal(payment.payload.gatewayRequest.payer.identification.number, user.taxId);
  assert.equal(payment.payload.gatewayRequest.application_fee, 2.16);
  assert.equal(Number(payment.amount), 27);
  assert.equal(Number(payment.marketplaceFeePercent), 8);
  assert.equal(Number(payment.marketplaceFeeAmount), 2.16);
  assert.equal(Number(payment.mercadoPagoFeeAmount), 0.55);
  assert.equal(Number(payment.sellerNetAmount), 24.29);
  assert.ok(payment.expiresAt);
  assert.equal(results[0].body.gatewayPayload.gatewayRequest, undefined);
  assert.equal((await api(`/api/payments/${payment.id}`)).body.payload.gatewayRequest, undefined);
  assert.equal((await checkout([4], requestKey)).status, 409);
  assert.equal((await checkout([1])).status, 409);
});

test('timeout apos criacao remota: retentativa usa corpo e chave originais', async () => {
  const requestKey = key();
  timeoutNext = true;
  const first = await checkout([5], requestKey);
  assert.equal(first.status, 202);
  assert.equal(first.body.externalId, null);
  const count = remotes.size;
  const second = await checkout([5], requestKey);
  assert.equal(second.body.paymentId, first.body.paymentId);
  assert.ok(second.body.externalId);
  assert.equal(remotes.size, count);
  assert.equal(creationBodies.at(-1), creationBodies.at(-2));
  assert.equal((await Payment.findByPk(first.body.paymentId)).processingAt, null);
});

test('rejeicao 2067: informa documento invalido e libera os numeros', async () => {
  rejectInvalidDocumentNext = true;
  const result = await checkout([10]);
  assert.equal(result.status, 402);
  assert.match(result.body.error, /CPF\/CNPJ.*invalido/i);
  assert.equal((await Payment.findByPk(result.body.paymentId)).status, 'falhou');
  assert.equal(await Ticket.count({ where: { paymentId: result.body.paymentId } }), 0);
});

test('webhook: assinatura invalida, valor divergente, duplicacao e evento antigo', async () => {
  const result = await checkout([6]);
  const id = result.body.externalId;
  assert.equal((await webhook(id, false)).status, 401);
  const remote = remotes.get(id);
  remote.status = 'approved';
  remote.transaction_amount = 11;
  assert.equal((await webhook(id)).status, 500);
  assert.equal((await Payment.findByPk(result.body.paymentId)).status, 'pendente');
  remote.transaction_amount = 10;
  const duplicateRequestId = key();
  const responses = await Promise.all([webhook(id, true, duplicateRequestId), webhook(id, true, duplicateRequestId)]);
  assert.ok(responses.every((response) => response.status === 200));
  remote.status = 'cancelled';
  assert.equal((await webhook(id)).status, 200);
  const paid = await Payment.findByPk(result.body.paymentId);
  assert.equal(paid.status, 'pago');
  assert.equal(paid.financialStatus, 'approved');
  assert.equal(await Ticket.count({ where: { paymentId: result.body.paymentId, status: 'confirmado' } }), 1);
  assert.equal((await webhook('999999999')).status, 503);
  const testNotification = await webhook('123456', true, key(), String(Math.floor(Date.now() / 1000)), false);
  assert.equal(testNotification.status, 200);
  assert.equal((await testNotification.json()).ignored, true);
});

test('expiracao: consulta, cancela no gateway e libera numeros atomicamente', async () => {
  const result = await checkout([7]);
  await Payment.update({ expiresAt: new Date(Date.now() - 60000) }, { where: { id: result.body.paymentId } });
  await processDurablePix(result.body.paymentId);
  assert.equal(remotes.get(result.body.externalId).status, 'cancelled');
  assert.equal((await Payment.findByPk(result.body.paymentId)).status, 'falhou');
  assert.equal(await Ticket.count({ where: { paymentId: result.body.paymentId } }), 0);
  assert.equal((await checkout([7])).status, 202);
});

test('expiracao com API indisponivel preserva reserva; pagamento ja aprovado continua pago', async () => {
  const result = await checkout([8]);
  await Payment.update({ expiresAt: new Date(Date.now() - 60000) }, { where: { id: result.body.paymentId } });
  unavailable = true;
  await processDurablePix(result.body.paymentId);
  unavailable = false;
  assert.equal((await Payment.findByPk(result.body.paymentId)).status, 'pendente');
  assert.equal(await Ticket.count({ where: { paymentId: result.body.paymentId } }), 1);
  remotes.get(result.body.externalId).status = 'approved';
  await processDurablePix(result.body.paymentId);
  assert.equal((await Payment.findByPk(result.body.paymentId)).status, 'pago');
});

test('reconciliacao recupera cobranca sem externalId depois do vencimento e sem webhook', async () => {
  timeoutNext = true;
  const result = await checkout([9]);
  const remote = [...remotes.values()].find((p) => p.metadata.paymentId === String(result.body.paymentId));
  remote.status = 'approved';
  await Payment.update({ expiresAt: new Date(Date.now() - 60000) }, { where: { id: result.body.paymentId } });
  const calls = createCalls;
  await reconcilePixPayments();
  assert.equal((await Payment.findByPk(result.body.paymentId)).status, 'pago');
  assert.equal(createCalls, calls);
});

test('OAuth: tokens cifrados no MySQL e refresh concorrente ocorre uma unica vez', async () => {
  await provider.update({ expiresAt: new Date(Date.now() - 60000) });
  const results = await Promise.all([resolveTenantMercadoPagoProvider(tenant.id), resolveTenantMercadoPagoProvider(tenant.id)]);
  assert.equal(refreshCalls, 1);
  assert.ok(results.every((row) => row.accessToken === 'novo-access'));
  const [rows] = await sequelize.query('SELECT accessToken, refreshToken FROM TenantPaymentProviders WHERE id = ?', { replacements: [provider.id] });
  assert.ok(rows[0].accessToken.startsWith('enc:v1:'));
  assert.ok(rows[0].refreshToken.startsWith('enc:v1:'));
  assert.ok(!rows[0].accessToken.includes('novo-access'));
});

test('checkout: documento ausente nao deixa pagamento nem reserva; comprador alheio nao consulta pagamento', async () => {
  await user.update({ taxId: null });
  const before = await Payment.count({ where: { tenantId: tenant.id } });
  const result = await checkout([10]);
  assert.equal(result.status, 400);
  assert.equal(await Payment.count({ where: { tenantId: tenant.id } }), before);
  await user.update({ taxId: '12345678901' });
  const payment = await Payment.findOne({ where: { tenantId: tenant.id } });
  const otherToken = jwt.sign({ id: user.id + 9999, tenantId: tenant.id, role: 'user' }, process.env.JWT_SECRET || 'dev_secret');
  assert.equal((await api(`/api/payments/${payment.id}`, null, key(), otherToken)).status, 403);
});


test('OAuth: somente organizador inicia fluxo, state e PKCE sao persistidos e state e de uso unico', async () => {
  const buyerToken = jwt.sign({ id: user.id, tenantId: tenant.id, role: 'user' }, process.env.JWT_SECRET || 'dev_secret');
  assert.equal((await api('/api/payments/mercadopago/connect/start', null, key(), buyerToken)).status, 403);
  await provider.update({ accountHolderName: null, accountHolderType: null, accountHolderTaxId: null, accountEmail: null, accountPhone: null, kycConfirmed: false });
  assert.equal((await api('/api/payments/mercadopago/connect/start')).status, 400);
  const savedProfileResponse = await originalFetch(`${base}/api/payments/mercadopago/receiving-profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ accountHolderName: 'Organizador Teste', accountHolderType: 'PF', accountHolderTaxId: '123.456.789-01', accountEmail: 'CONTA@EXAMPLE.COM', accountPhone: '(11) 99999-9999', kycConfirmed: true }),
  });
  assert.equal(savedProfileResponse.status, 200);
  const savedProfile = await savedProfileResponse.json();
  assert.equal(savedProfile.accountHolderTaxId, '12345678901');
  assert.equal(savedProfile.accountEmail, 'conta@example.com');
  const loadedProfile = await api('/api/payments/mercadopago/receiving-profile');
  assert.equal(loadedProfile.body.accountHolderName, 'Organizador Teste');
  const started = await api('/api/payments/mercadopago/connect/start');
  assert.equal(started.status, 200, JSON.stringify(started));
  const authorization = new URL(started.body.url);
  assert.equal(authorization.hostname, 'auth.mercadopago.com.br');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('code_challenge'));
  const state = authorization.searchParams.get('state');
  const stored = await MercadoPagoOAuthState.findOne({ where: { stateHash: crypto.createHash('sha256').update(state).digest('hex') } });
  assert.ok(stored);
  assert.ok(stored.getDataValue('codeVerifier').startsWith('enc:v1:'));
  const callback = await originalFetch(`${base}/api/payments/mercadopago/connect/callback?code=codigo-ficticio&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/?mercadopago=connected');
  assert.equal((await MercadoPagoOAuthState.findByPk(stored.id)).usedAt != null, true);
  const replay = await originalFetch(`${base}/api/payments/mercadopago/connect/callback?code=codigo-ficticio&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.get('location'), '/?mercadopago=error&reason=invalid_state');
});

test('administracao global consulta marketplace e comissoes, mas nao inicia OAuth de organizadores', async () => {
  await Payment.create({
    tenantId: tenant.id, userId: user.id, raffleId: raffle.id, amount: 999, method: 'pix',
    provider: 'mercadopago', status: 'pendente', financialStatus: 'created',
    marketplaceFeeAmount: 999, mercadoPagoFeeAmount: 999, sellerNetAmount: 999,
  });
  const approvedForTenant = await Payment.findAll({ where: { tenantId: tenant.id, provider: 'mercadopago', financialStatus: 'approved' } });
  const expectedTenantGross = Number(approvedForTenant.reduce((sum, payment) => sum + Number(payment.amount), 0).toFixed(2));
  const expectedTenantFee = Number(approvedForTenant.reduce((sum, payment) => sum + Number(payment.marketplaceFeeAmount || 0), 0).toFixed(2));
  const organizerDashboard = await api('/api/payments/mercadopago/financial-dashboard');
  assert.equal(organizerDashboard.status, 200);
  assert.equal(organizerDashboard.body.summary.payments, approvedForTenant.length);
  assert.equal(organizerDashboard.body.summary.grossAmount, expectedTenantGross);
  assert.equal(organizerDashboard.body.summary.platformFeeAmount, expectedTenantFee);

  const platformToken = jwt.sign({ scope: 'platform_admin' }, process.env.JWT_SECRET || 'dev_secret');
  const platformApi = (path, body) => api(`/api/platform/payments/mercadopago${path}`, body, key(), platformToken);
  const platformStatus = await platformApi('/status');
  assert.equal(platformStatus.status, 200);
  const allApproved = await Payment.findAll({ where: { provider: 'mercadopago', financialStatus: 'approved' } });
  const expectedPlatformGross = Number(allApproved.reduce((sum, payment) => sum + Number(payment.amount), 0).toFixed(2));
  const expectedPlatformFee = Number(allApproved.reduce((sum, payment) => sum + Number(payment.marketplaceFeeAmount || 0), 0).toFixed(2));
  assert.equal(platformStatus.body.reconciliation.payments, allApproved.length);
  assert.equal(platformStatus.body.reconciliation.grossAmount, expectedPlatformGross);
  assert.equal(platformStatus.body.reconciliation.marketplaceFeeAmount, expectedPlatformFee);
  assert.equal((await platformApi('/commissions')).status, 200);
  assert.equal((await api('/api/platform/payments/mercadopago/status')).status, 401);
  assert.equal((await api('/api/platform/payments/mercadopago/connect/start?tenantId=' + tenant.id, null, key(), platformToken)).status, 404);
  const verified = await platformApi('/verify', {});
  assert.equal(verified.status, 200, JSON.stringify(verified));
  assert.equal(verified.body.accountId, '***');
  const configuration = await PlatformPaymentConfiguration.findOne({ where: { provider: 'mercadopago' } });
  assert.equal(configuration.accountId, '456789');
});
