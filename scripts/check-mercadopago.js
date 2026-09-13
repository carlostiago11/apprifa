// Verifica configuracao local sem exibir credenciais ou chamar o gateway.
const fs = require("fs");
const { parse } = require("dotenv");
const { tokenCipher } = require("../lib/pix");
const filename = process.argv[2] || ".env";
if (!fs.existsSync(filename)) {
  console.error("Arquivo de ambiente nao encontrado.");
  process.exit(1);
}
const config = parse(fs.readFileSync(filename));
let missing = 0;
function check(name, valid) {
  console.log(`${valid ? "OK" : "PENDENTE"}: ${name}`);
  if (!valid) missing++;
}
for (const name of ["MERCADOPAGO_APP_ID", "MERCADOPAGO_CLIENT_SECRET", "MERCADOPAGO_WEBHOOK_SECRET"]) {
  check(name, Boolean(config[name]?.trim()));
}
let keyValid = false;
try { keyValid = tokenCipher(config.OAUTH_TOKEN_ENCRYPTION_KEY || "").enabled; } catch (_) {}
check("OAUTH_TOKEN_ENCRYPTION_KEY (32 bytes em base64)", keyValid);
for (const [name, pathname] of [
  ["MERCADOPAGO_REDIRECT_URI", "/api/payments/mercadopago/connect/callback"],
  ["MERCADOPAGO_NOTIFICATION_URL", "/api/webhooks/mercadopago"],
]) {
  let valid = false;
  try {
    const url = new URL(config[name]);
    valid = url.protocol === "https:" && url.pathname === pathname && !url.username && !url.password
      && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch (_) {}
  check(`${name} (HTTPS e caminho esperado)`, valid);
}
check("MARKETPLACE_FEE_PERCENT = 10", Number(config.MARKETPLACE_FEE_PERCENT || 10) === 10);
console.log("Esta verificacao nao confirma acesso publico, credenciais validas, aprovacao comercial ou homologacao.");
console.log("O provider nao foi alterado. Habilite Mercado Pago somente no ambiente isolado durante a homologacao.");
process.exitCode = missing ? 1 : 0;
