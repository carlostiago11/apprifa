const { MercadoPagoConfig } = require("mercadopago");

// Em scripts locais, carregar dotenv antes de chamar esta funcao sem argumento.
// No marketplace, passar explicitamente o token OAuth do vendedor do tenant.
function createMercadoPagoClient(accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN) {
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("Informe o token OAuth do vendedor ou configure MERCADOPAGO_ACCESS_TOKEN");
  }
  return new MercadoPagoConfig({
    accessToken: accessToken.trim(),
    options: { timeout: 15000 },
  });
}

module.exports = { createMercadoPagoClient };
