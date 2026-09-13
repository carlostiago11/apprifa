const test = require("node:test");
const assert = require("node:assert/strict");

const API_BASE = process.env.API_BASE || "http://localhost:3000";
const ADMIN_REGISTRATION_TOKEN = process.env.ADMIN_REGISTRATION_TOKEN || "admin_token_forte";
const PLATFORM_ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || "admin@apprifa.com";
const PLATFORM_ADMIN_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || "admin_plataforma_teste";

async function callApi(path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function addressPayload() {
  return {
    taxId: "12345678901",
    tenantTaxId: "12345678000199",
    ownerTaxId: "12345678901",
    addressPostalCode: "78000-000",
    addressStreet: "Rua dos Testes",
    addressNumber: "123",
    addressComplement: "Sala 1",
    addressDistrict: "Centro",
    addressCity: "Cuiaba",
    addressState: "MT",
  };
}

async function createTenantAndOwner() {
  const tenantSlug = uid("tenant").toLowerCase();
  const ownerEmail = `${uid("owner")}@mail.com`;

  const platformLogin = await callApi("/api/platform/auth/login", {
    method: "POST",
    body: { email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD },
  });
  assert.equal(platformLogin.status, 200, `Falha login plataforma: ${JSON.stringify(platformLogin.payload)}`);

  const result = await callApi("/api/platform/tenants", {
    method: "POST",
    token: platformLogin.payload.token,
    body: {
      tenantName: uid("Cliente"),
      tenantSlug,
      ownerName: uid("Owner"),
      ownerEmail,
      ownerPhone: `119${Math.floor(10000000 + Math.random() * 89999999)}`,
      ownerPassword: "12345678",
      ...addressPayload(),
    },
  });

  assert.equal(result.status, 201, `Falha tenant register: ${JSON.stringify(result.payload)}`);
  const ownerLogin = await loginUser(tenantSlug, ownerEmail);
  assert.equal(ownerLogin.status, 200, `Falha login owner: ${JSON.stringify(ownerLogin.payload)}`);
  return {
    tenantId: result.payload.tenant.id,
    tenantSlug,
    ownerToken: ownerLogin.payload.token,
    ownerEmail,
    platformToken: platformLogin.payload.token,
  };
}

async function registerUser(tenantSlug, { isAdmin = false } = {}) {
  const email = `${uid("user")}@mail.com`;
  const body = {
    tenantSlug,
    name: uid("Nome"),
    phone: `119${Math.floor(10000000 + Math.random() * 89999999)}`,
    email,
    password: "12345678",
    ...addressPayload(),
  };
  if (isAdmin) body.adminToken = ADMIN_REGISTRATION_TOKEN;

  const result = await callApi("/api/auth/register", { method: "POST", body });
  assert.equal(result.status, 201, `Falha no register: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

async function loginUser(tenantSlug, email, password = "12345678") {
  return callApi("/api/auth/login", {
    method: "POST",
    body: { tenantSlug, email, password },
  });
}

async function createProductAndRaffle(adminToken, type = "NUMERICA_100", customTotalNumbers = 250, winnerCount = 3, discountPercent = 10) {
  const product = await callApi("/api/products", {
    method: "POST",
    token: adminToken,
    body: {
      title: uid("Produto"),
      description: "Produto de teste",
      media: [],
    },
  });
  assert.equal(product.status, 201, `Falha ao criar produto: ${JSON.stringify(product.payload)}`);

  const raffle = await callApi("/api/raffles", {
    method: "POST",
    token: adminToken,
    body: {
      productId: product.payload.id,
      type,
      title: uid("Rifa"),
      description: "Rifa de teste",
      pricePerNumber: 10,
      discountPercent,
      winnerCount,
      ...(type === "NUMERICA_1000" ? { totalNumbers: customTotalNumbers } : {}),
    },
  });
  assert.equal(raffle.status, 201, `Falha ao criar rifa: ${JSON.stringify(raffle.payload)}`);

  return raffle.payload;
}

test("healthcheck responde", async () => {
  const health = await callApi("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.payload.ok, true);
});

test("administracao da plataforma exige autenticacao", async () => {
  const result = await callApi("/api/platform/tenants");
  assert.equal(result.status, 401);
});

test("gestao da plataforma altera cliente, senha e lista suas rifas", async () => {
  const { tenantId, tenantSlug, ownerToken, ownerEmail, platformToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_100");
  const updatedSlug = `${tenantSlug}-editado`;
  const updatedEmail = `editado-${ownerEmail}`;

  const update = await callApi(`/api/platform/tenants/${tenantId}`, {
    method: "PATCH",
    token: platformToken,
    body: {
      tenantName: "Cliente atualizado",
      tenantSlug: updatedSlug,
      ownerName: "Responsavel atualizado",
      ownerEmail: updatedEmail,
      ownerPhone: "65999999999",
      ownerPassword: "nova-senha-123",
      marketplaceFeePercent: 7.5,
      ...addressPayload(),
    },
  });
  assert.equal(update.status, 200, `Falha ao atualizar cliente: ${JSON.stringify(update.payload)}`);
  assert.equal(update.payload.tenant.slug, updatedSlug);
  assert.equal(update.payload.tenant.marketplaceFeePercent, 7.5);
  assert.equal(update.payload.owner.email, updatedEmail);
  assert.equal(update.payload.passwordUpdated, true);

  const login = await loginUser(updatedSlug, updatedEmail, "nova-senha-123");
  assert.equal(login.status, 200, `Falha login com nova senha: ${JSON.stringify(login.payload)}`);

  const raffles = await callApi(`/api/platform/tenants/${tenantId}/raffles`, { token: platformToken });
  assert.equal(raffles.status, 200);
  assert.ok(raffles.payload.some((item) => item.id === raffle.id));

  const clients = await callApi("/api/platform/tenants", { token: platformToken });
  assert.equal(clients.status, 200);
  const client = clients.payload.find((item) => item.id === tenantId);
  assert.equal(client.raffleCount, 1);
  assert.equal(Number(client.marketplaceFeePercent), 7.5);
});

test("gestao da plataforma lista e atualiza usuarios cadastrados", async () => {
  const { tenantSlug, platformToken } = await createTenantAndOwner();
  const registered = await registerUser(tenantSlug);
  const updatedEmail = `alterado-${registered.user.email}`;

  const users = await callApi("/api/platform/users", { token: platformToken });
  assert.equal(users.status, 200);
  const listed = users.payload.find((user) => user.id === registered.user.id);
  assert.ok(listed);
  assert.equal(listed.Tenant.slug, tenantSlug);
  assert.equal(Object.hasOwn(listed, "passwordHash"), false);

  const update = await callApi(`/api/platform/users/${registered.user.id}`, {
    method: "PATCH",
    token: platformToken,
    body: {
      name: "Usuario atualizado",
      email: updatedEmail,
      phone: "65988888888",
      role: "admin",
      password: "senha-atualizada-123",
      ...addressPayload(),
    },
  });
  assert.equal(update.status, 200, `Falha ao atualizar usuario: ${JSON.stringify(update.payload)}`);
  assert.equal(update.payload.user.role, "admin");
  assert.equal(update.payload.passwordUpdated, true);

  const login = await loginUser(tenantSlug, updatedEmail, "senha-atualizada-123");
  assert.equal(login.status, 200, `Falha login do usuario atualizado: ${JSON.stringify(login.payload)}`);
  assert.equal(login.payload.user.role, "admin");
});

test("auth multi-tenant: registro e login funcionam", async () => {
  const { tenantSlug } = await createTenantAndOwner();
  const reg = await registerUser(tenantSlug);
  assert.ok(reg.token);
  assert.equal(reg.user.role, "user");

  const login = await loginUser(tenantSlug, reg.user.email);
  assert.equal(login.status, 200);
  assert.ok(login.payload.token);
  assert.equal(login.payload.user.email, reg.user.email);
  assert.equal(login.payload.tenant.slug, tenantSlug);
});

test("isolamento tenant: usuario de outro tenant nao acessa rifa", async () => {
  const tenantA = await createTenantAndOwner();
  const tenantB = await createTenantAndOwner();

  const raffle = await createProductAndRaffle(tenantA.ownerToken, "NUMERICA_100");

  const outsider = await registerUser(tenantB.tenantSlug);
  const detail = await callApi(`/api/raffles/${raffle.id}`, {
    token: outsider.token,
  });

  assert.equal(detail.status, 404);
});

test("permissoes: usuario comum nao cria produto/rifa; owner/admin cria", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const normal = await registerUser(tenantSlug);

  const deniedProduct = await callApi("/api/products", {
    method: "POST",
    token: normal.token,
    body: { title: "X", description: "Y", media: [] },
  });
  assert.equal(deniedProduct.status, 403);

  const allowedProduct = await callApi("/api/products", {
    method: "POST",
    token: ownerToken,
    body: { title: uid("OwnerProduto"), description: "ok", media: [] },
  });
  assert.equal(allowedProduct.status, 201);
});

test("rifa personalizada aceita uma faixa entre 1 e 1000", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_1000", 347);
  assert.equal(raffle.totalNumbers, 347);

  const buyer = await registerUser(tenantSlug);
  const detail = await callApi(`/api/raffles/${raffle.id}`, { token: buyer.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.totalNumbers, 347);

  const outOfRange = await callApi("/api/payments/checkout", {
    method: "POST",
    token: buyer.token,
    body: { raffleId: raffle.id, numbers: [348], method: "pix" },
  });
  assert.equal(outOfRange.status, 400);

  const invalidRange = await callApi("/api/raffles", {
    method: "POST",
    token: ownerToken,
    body: {
      productId: raffle.productId,
      type: "NUMERICA_1000",
      title: uid("Rifa-invalida"),
      description: "Faixa invalida",
      pricePerNumber: 10,
      totalNumbers: 1001,
    },
  });
  assert.equal(invalidRange.status, 400);
});

test("checkout concorrente: mesmo numero nao pode ser vendido duas vezes", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_100");

  const buyer1 = await registerUser(tenantSlug);
  const buyer2 = await registerUser(tenantSlug);

  const body = { raffleId: raffle.id, numbers: [1], method: "pix" };

  const [r1, r2] = await Promise.all([
    callApi("/api/payments/checkout", { method: "POST", token: buyer1.token, body }),
    callApi("/api/payments/checkout", { method: "POST", token: buyer2.token, body }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409]);
});

test("primeira fase rejeita pagamento por cartao", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_100");
  const buyer = await registerUser(tenantSlug);
  const result = await callApi("/api/payments/checkout", {
    method: "POST",
    token: buyer.token,
    body: { raffleId: raffle.id, numbers: [1], method: "credito" },
  });
  assert.equal(result.status, 400);
});

test("checkout aplica 10% de desconto a partir de 3 numeros", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_100");
  const buyer = await registerUser(tenantSlug);
  const result = await callApi("/api/payments/checkout", {
    method: "POST",
    token: buyer.token,
    body: { raffleId: raffle.id, numbers: [1, 2, 3], method: "pix" },
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.subtotal, 30);
  assert.equal(result.payload.discountPercent, 10);
  assert.equal(result.payload.discountAmount, 3);
  assert.equal(result.payload.amount, 27);
});

test("checkout aplica o desconto configurado na rifa", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_100", 250, 3, 17.5);
  assert.equal(Number(raffle.discountPercent), 17.5);
  const buyer = await registerUser(tenantSlug);
  const result = await callApi("/api/payments/checkout", {
    method: "POST",
    token: buyer.token,
    body: { raffleId: raffle.id, numbers: [1, 2, 3], method: "pix" },
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.subtotal, 30);
  assert.equal(result.payload.discountPercent, 17.5);
  assert.equal(result.payload.discountAmount, 5.25);
  assert.equal(result.payload.amount, 24.75);
});

test("criacao de rifa rejeita desconto fora da faixa permitida", async () => {
  const { ownerToken } = await createTenantAndOwner();
  const product = await callApi("/api/products", {
    method: "POST",
    token: ownerToken,
    body: { title: uid("Produto"), description: "Produto de teste", media: [] },
  });
  const result = await callApi("/api/raffles", {
    method: "POST",
    token: ownerToken,
    body: {
      productId: product.payload.id,
      type: "NUMERICA_100",
      title: uid("Rifa"),
      description: "Rifa com desconto invalido",
      pricePerNumber: 10,
      discountPercent: 101,
    },
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /desconto/i);
});

test("sorteio numerico automatico: rifa 1-100 encerra ao completar cotas", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_100", 250, 5);
  assert.equal(raffle.winnerCount, 5);
  const buyer = await registerUser(tenantSlug);

  for (let start = 1; start <= 100; start += 20) {
    const numbers = [];
    for (let n = start; n < start + 20; n += 1) numbers.push(n);
    const checkout = await callApi("/api/payments/checkout", {
      method: "POST",
      token: buyer.token,
      body: { raffleId: raffle.id, numbers, method: "pix" },
    });
    assert.equal(checkout.status, 201, `Falha checkout lote ${start}: ${JSON.stringify(checkout.payload)}`);
  }

  const detail = await callApi(`/api/raffles/${raffle.id}`, { token: buyer.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.status, "ENCERRADA");
  assert.ok(Array.isArray(detail.payload.winners));
  assert.equal(detail.payload.winnerCount, 5);
  assert.equal(detail.payload.winners.length, 5);
});

test("organizador encerra rifa antecipadamente e sorteia somente numeros pagos", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_100", 250, 2);
  const buyer = await registerUser(tenantSlug);
  const checkout = await callApi("/api/payments/checkout", {
    method: "POST",
    token: buyer.token,
    body: { raffleId: raffle.id, numbers: [5, 9, 12], method: "pix" },
  });
  assert.equal(checkout.status, 201);

  const denied = await callApi(`/api/raffles/${raffle.id}/close`, { method: "POST", token: buyer.token });
  assert.equal(denied.status, 403);

  const wrongPassword = await callApi(`/api/raffles/${raffle.id}/close`, {
    method: "POST",
    token: ownerToken,
    body: { password: "senha-incorreta" },
  });
  assert.equal(wrongPassword.status, 403);
  assert.match(wrongPassword.payload.error, /senha/i);

  const closed = await callApi(`/api/raffles/${raffle.id}/close`, {
    method: "POST",
    token: ownerToken,
    body: { password: "12345678" },
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.payload));
  assert.equal(closed.payload.status, "ENCERRADA");
  assert.equal(closed.payload.drawMode, "ALEATORIO");
  assert.match(closed.payload.drawSource, /encerramento antecipado/i);
  assert.equal(closed.payload.winners.length, 2);
  assert.equal(new Set(closed.payload.winners.map((winner) => winner.number)).size, 2);
  assert.ok(closed.payload.winners.every((winner) => [5, 9, 12].includes(winner.number)));

  const checkoutAfterClose = await callApi("/api/payments/checkout", {
    method: "POST",
    token: buyer.token,
    body: { raffleId: raffle.id, numbers: [20], method: "pix" },
  });
  assert.equal(checkoutAfterClose.status, 400);
});

test("encerramento antecipado exige numeros pagos suficientes para os ganhadores", async () => {
  const { ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "NUMERICA_100", 250, 3);
  const closed = await callApi(`/api/raffles/${raffle.id}/close`, {
    method: "POST",
    token: ownerToken,
    body: { password: "12345678" },
  });
  assert.equal(closed.status, 400);
  assert.match(closed.payload.error, /pelo menos 3 numeros pagos/i);
});

test("sorteio bicho: owner/admin encerra rifa 1-25 com resultado informado", async () => {
  const { tenantSlug, ownerToken } = await createTenantAndOwner();
  const raffle = await createProductAndRaffle(ownerToken, "BICHO_25", 250, 2);
  assert.equal(raffle.winnerCount, 2);
  const buyer = await registerUser(tenantSlug);

  const numbers = [];
  for (let n = 1; n <= 25; n += 1) numbers.push(n);

  const checkout = await callApi("/api/payments/checkout", {
    method: "POST",
    token: buyer.token,
    body: { raffleId: raffle.id, numbers, method: "pix" },
  });
  assert.equal(checkout.status, 201);

  const draw = await callApi(`/api/raffles/${raffle.id}/draw/bicho-rj`, {
    method: "POST",
    token: ownerToken,
    body: { results: [1, 2], source: "Teste automatizado" },
  });

  assert.equal(draw.status, 200, `Falha no sorteio bicho: ${JSON.stringify(draw.payload)}`);
  assert.equal(draw.payload.status, "ENCERRADA");
  assert.equal(draw.payload.winners.length, 2);
  assert.match(draw.payload.winners[0].user.phone, /^\(11\) \*{5}-\d{4}$/);
  assert.doesNotMatch(draw.payload.winners[0].user.phone, /^\d{10,11}$/);

  const loser = await registerUser(tenantSlug);
  const winnerList = await callApi("/api/raffles", { token: buyer.token });
  assert.ok(winnerList.payload.some((item) => item.id === raffle.id));
  const loserList = await callApi("/api/raffles", { token: loser.token });
  assert.equal(loserList.payload.some((item) => item.id === raffle.id), false);
  const loserDetail = await callApi(`/api/raffles/${raffle.id}`, { token: loser.token });
  assert.equal(loserDetail.status, 404);
  const managerList = await callApi("/api/raffles", { token: ownerToken });
  assert.ok(managerList.payload.some((item) => item.id === raffle.id));
  assert.match(managerList.payload.find((item) => item.id === raffle.id).winners[0].user.phone, /^\(11\) \*{5}-\d{4}$/);

  const label = await fetch(`${API_BASE}/api/raffles/${raffle.id}/winners/1/shipping-label.pdf`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(label.status, 200);
  assert.match(label.headers.get("content-type") || "", /application\/pdf/);
  const pdf = Buffer.from(await label.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(pdf.length > 1000);
});
