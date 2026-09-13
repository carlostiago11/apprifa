require("dotenv").config();
const { User } = require("mercadopago");
const { createMercadoPagoClient } = require("../lib/mercadopago");

async function main() {
  const user = await new User(createMercadoPagoClient()).get();
  console.log(JSON.stringify({
    authenticated: Boolean(user.id),
    country: user.country_id || null,
    site: user.site_id || null,
    testAccount: Array.isArray(user.tags) && user.tags.includes("test_user"),
  }, null, 2));
}

main().catch((error) => {
  // Nunca imprimir o objeto do SDK: pode incluir headers e dados pessoais.
  const code = String(error.code || error.cause?.code || "unknown");
  console.error(JSON.stringify({ authenticated: false, status: Number(error.status || error.statusCode) || null,
    code: /^[A-Za-z0-9_-]{1,60}$/.test(code) ? code : "unknown" }));
  process.exitCode = 1;
});
