const crypto = require("crypto");

function tokenCipher(encodedKey) {
  const key = encodedKey ? Buffer.from(encodedKey, "base64") : null;
  if (key && (key.length !== 32 || key.toString("base64") !== encodedKey)) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY deve conter 32 bytes em base64");
  }
  return {
    enabled: Boolean(key),
    encrypt(value) {
      if (!value) return value;
      if (!key) throw new Error("Configure OAUTH_TOKEN_ENCRYPTION_KEY antes de conectar uma conta");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return `enc:v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
    },
    decrypt(value) {
      if (!value || !value.startsWith("enc:")) return value;
      if (!key) throw new Error("Chave de criptografia OAuth indisponivel");
      const [prefix, version, iv, tag, encrypted] = value.split(":");
      if (prefix !== "enc" || version !== "v1" || !encrypted) throw new Error("Token OAuth invalido");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
    },
  };
}

function isValidTaxId(value) {
  const document = String(value || "").replace(/\D/g, "");
  if (![11, 14].includes(document.length) || /^(\d)\1+$/.test(document)) return false;
  if (document.length === 11) {
    const digit = (length) => {
      const sum = document.slice(0, length).split("").reduce((total, number, index) => total + Number(number) * (length + 1 - index), 0);
      const remainder = (sum * 10) % 11;
      return remainder === 10 ? 0 : remainder;
    };
    return digit(9) === Number(document[9]) && digit(10) === Number(document[10]);
  }
  const digit = (length) => {
    const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const remainder = document.slice(0, length).split("").reduce((total, number, index) => total + Number(number) * weights[index], 0) % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return digit(12) === Number(document[12]) && digit(13) === Number(document[13]);
}

function buildPixRequest({ payment, user, raffle, numbers, feePercent, notificationUrl }) {
  const name = String(user.name || "").trim().split(/\s+/);
  const document = String(user.taxId || "").replace(/\D/g, "");
  if (!isValidTaxId(document) || !name[0] || !user.email) {
    throw new Error("Atualize nome, email e CPF/CNPJ do comprador antes de pagar");
  }
  return {
    transaction_amount: Number(payment.amount),
    description: `Rifa ${raffle.id} - ${numbers.length} numero(s)`,
    payment_method_id: "pix",
    external_reference: `apprifa-${payment.tenantId}-${payment.id}`,
    application_fee: Number((Number(payment.amount) * feePercent / 100).toFixed(2)),
    date_of_expiration: new Date(payment.expiresAt).toISOString().replace("Z", "+00:00"),
    ...(notificationUrl ? { notification_url: notificationUrl } : {}),
    payer: {
      email: user.email,
      first_name: name[0],
      last_name: name.slice(1).join(" "),
      identification: { type: document.length === 11 ? "CPF" : "CNPJ", number: document },
    },
    metadata: {
      tenantId: String(payment.tenantId), raffleId: String(raffle.id),
      userId: String(user.id), paymentId: String(payment.id), numbers: numbers.join(","),
    },
  };
}

function remoteStatus(status) {
  if (status === "approved") return "pago";
  if (["rejected", "cancelled"].includes(status)) return "falhou";
  // Estados novos, estornos e disputas exigem analise; nunca liberam numeros pagos.
  return "pendente";
}

function remoteFinancials(remote) {
  const fees = Array.isArray(remote.fee_details) ? remote.fee_details : [];
  const byType = (type) => Number(fees.filter((fee) => fee.type === type).reduce((sum, fee) => sum + Number(fee.amount || 0), 0).toFixed(2));
  const hasMarketplaceFee = remote.application_fee != null || fees.some((fee) => fee.type === "application_fee");
  const marketplaceFee = !hasMarketplaceFee ? null : remote.application_fee == null ? byType("application_fee") : Number(remote.application_fee);
  const mercadoPagoFee = byType("mercadopago_fee");
  const sellerNet = remote.transaction_details?.net_received_amount;
  return {
    marketplaceFee: Number.isFinite(marketplaceFee) ? marketplaceFee : null,
    mercadoPagoFee: Number.isFinite(mercadoPagoFee) ? mercadoPagoFee : null,
    sellerNet: sellerNet == null || !Number.isFinite(Number(sellerNet)) ? null : Number(sellerNet),
  };
}

function validateRemote(payment, remote) {
  const financials = remoteFinancials(remote);
  if (!remote.id || (payment.externalId && String(remote.id) !== payment.externalId)
    || Number(remote.transaction_amount) !== Number(payment.amount)
    || remote.external_reference !== payment.payload?.externalReference
    || remote.payment_method_id !== "pix" || remote.currency_id !== "BRL"
    || String(remote.collector_id) !== String(payment.providerAccountId)) {
    throw new Error("Pagamento remoto diverge da cobranca local");
  }
  if (financials.marketplaceFee != null && Number(financials.marketplaceFee) !== Number(payment.marketplaceFeeAmount)) {
    throw new Error("Comissao marketplace diverge da cobranca local");
  }
}

function publicPayload(payload) {
  if (!payload) return null;
  const { gatewayRequest, ...safe } = payload;
  return safe;
}

module.exports = { tokenCipher, isValidTaxId, buildPixRequest, remoteStatus, remoteFinancials, validateRemote, publicPayload };
