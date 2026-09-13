require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const { User, Order } = require("mercadopago");
const { createMercadoPagoClient } = require("../lib/mercadopago");

// Teste externo conforme o exemplo oficial Orders/Pix, sem alterar o banco do app.
// Mantem a mesma tentativa em disco para nao duplicar orders em caso de timeout.
const statePath = path.join(__dirname, "../tmp/mercadopago-orders-homologacao.json");
async function main() {
  const client = createMercadoPagoClient();
  const user = await new User(client).get();
  assert.ok(user.tags?.includes("test_user"), "A conta precisa estar marcada como test_user");
  assert.equal(user.country_id, "BR", "A conta precisa ser brasileira");
  const accountHash = crypto.createHash("sha256").update(String(user.id)).digest("hex");
  let state;
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.accountHash, accountHash, "Tentativa existente pertence a outra conta de teste");
  } else {
    state = {
      accountHash,
      idempotencyKey: crypto.randomUUID(),
      body: {
        type: "online", processing_mode: "automatic", total_amount: "50.00",
        external_reference: `apprifa-test-${crypto.randomUUID()}`,
        payer: { email: "test_user_br@testuser.com", first_name: "APRO" },
        transactions: { payments: [{ amount: "50.00", payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: "PT30M" }] },
      },
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
  }
  function save() {
    const temporary = statePath + ".next";
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, statePath);
  }
  const orders = new Order(client);
  const create = () => orders.create({ body: state.body, requestOptions: { idempotencyKey: state.idempotencyKey } });
  if (!state.orderId) {
    const created = await create();
    assert.ok(created.id, "Resposta sem identificador de order");
    state.orderId = created.id;
    state.createdStatus = created.status;
    state.hasQrCode = Boolean(created.transactions?.payments?.[0]?.payment_method?.qr_code);
    state.hasTicketUrl = Boolean(created.transactions?.payments?.[0]?.payment_method?.ticket_url);
    save();
  }
  if (!state.idempotencyVerified) {
    const repeated = await create();
    assert.equal(repeated.id, state.orderId, "Retentativa criou outra order");
    state.idempotencyVerified = true;
    save();
  }
  const remote = await orders.get({ id: state.orderId });
  assert.equal(Number(remote.total_amount), 50);
  assert.equal(remote.external_reference, state.body.external_reference);
  assert.equal(remote.transactions?.payments?.[0]?.payment_method?.id, "pix");
  state.lastCheckedAt = new Date().toISOString();
  state.status = remote.status;
  state.statusDetail = remote.status_detail;
  state.paymentStatus = remote.transactions?.payments?.[0]?.status;
  save();
  console.log(JSON.stringify({
    testAccount: true, api: "/v1/orders", createdStatus: state.createdStatus,
    status: state.status, statusDetail: state.statusDetail, paymentStatus: state.paymentStatus,
    amountVerified: true, referenceVerified: true, idempotencyVerified: state.idempotencyVerified,
    hasQrCode: state.hasQrCode, hasTicketUrl: state.hasTicketUrl,
    webhookTested: false, marketplaceSplitTested: false,
  }, null, 2));
}

main().catch((error) => {
  const safeCode = (value) => /^[A-Za-z0-9_.-]{1,80}$/.test(String(value)) ? String(value) : "unknown";
  console.error(JSON.stringify({ success: false, status: Number(error.status || error.statusCode) || null,
    code: safeCode(error.code), causes: Array.isArray(error.cause) ? error.cause.map((item) => safeCode(item.code)) : [],
    assertion: error.code === "ERR_ASSERTION" ? error.message : undefined,
  }));
  process.exitCode = 1;
});
