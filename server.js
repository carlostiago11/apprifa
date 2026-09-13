require("dotenv").config();

// Dependencias principais: servidor HTTP, seguranca, uploads, banco e gateways.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const { Sequelize, DataTypes, Op } = require("sequelize");
const Stripe = require("stripe");
const { tokenCipher, isValidTaxId, buildPixRequest, remoteStatus, remoteFinancials, validateRemote, publicPayload } = require("./lib/pix");
const oauthCipher = tokenCipher(process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "");
const PIX_EXPIRATION_MINUTES = Number(process.env.PIX_EXPIRATION_MINUTES || 30);
const PIX_RECONCILE_INTERVAL_MS = Number(process.env.PIX_RECONCILE_INTERVAL_MS || 60000);
if (!Number.isInteger(PIX_EXPIRATION_MINUTES) || PIX_EXPIRATION_MINUTES < 30 || PIX_EXPIRATION_MINUTES > 43200) throw new Error("PIX_EXPIRATION_MINUTES deve estar entre 30 e 43200");
if (!Number.isInteger(PIX_RECONCILE_INTERVAL_MS) || PIX_RECONCILE_INTERVAL_MS < 1000) throw new Error("Intervalo de reconciliacao invalido");

// Configuracao geral da aplicacao carregada a partir do ambiente.
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";

// Configuracao global dos gateways. No fluxo multi-tenant, o Stripe Connect
// associa uma conta de recebimento diferente a cada cliente.
const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER || "mock").toLowerCase();
if (PAYMENT_PROVIDER === "mercadopago" && !oauthCipher.enabled) throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY obrigatoria para Mercado Pago");
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_CONNECT_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID || "";
const STRIPE_CONNECT_REDIRECT_URI = process.env.STRIPE_CONNECT_REDIRECT_URI || "";
const MERCADOPAGO_APP_ID = process.env.MERCADOPAGO_APP_ID || "";
const MERCADOPAGO_CLIENT_SECRET = process.env.MERCADOPAGO_CLIENT_SECRET || "";
const MERCADOPAGO_PUBLIC_KEY = process.env.MERCADOPAGO_PUBLIC_KEY || "";
const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || "";
const MERCADOPAGO_REDIRECT_URI = process.env.MERCADOPAGO_REDIRECT_URI || "";
const MERCADOPAGO_WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET || "";
const MERCADOPAGO_NOTIFICATION_URL = process.env.MERCADOPAGO_NOTIFICATION_URL || "";
const MARKETPLACE_FEE_PERCENT = Number(process.env.MARKETPLACE_FEE_PERCENT || 10);
const MERCADOPAGO_WEBHOOK_MAX_AGE_SECONDS = Number(process.env.MERCADOPAGO_WEBHOOK_MAX_AGE_SECONDS || 600);
if (!Number.isFinite(MARKETPLACE_FEE_PERCENT) || MARKETPLACE_FEE_PERCENT < 0 || MARKETPLACE_FEE_PERCENT > 100) {
  throw new Error("MARKETPLACE_FEE_PERCENT deve estar entre 0 e 100");
}
if (!Number.isInteger(MERCADOPAGO_WEBHOOK_MAX_AGE_SECONDS) || MERCADOPAGO_WEBHOOK_MAX_AGE_SECONDS < 60) {
  throw new Error("MERCADOPAGO_WEBHOOK_MAX_AGE_SECONDS deve ser pelo menos 60");
}
const PAGBANK_API_BASE = process.env.PAGBANK_API_BASE || "https://sandbox.api.pagseguro.com";
const PAGBANK_ACCESS_TOKEN = process.env.PAGBANK_ACCESS_TOKEN || "";
const PAGBANK_PUBLIC_KEY = process.env.PAGBANK_PUBLIC_KEY || "";
const PAGBANK_NOTIFICATION_URL = process.env.PAGBANK_NOTIFICATION_URL || "";
const PAGBANK_WEBHOOK_TOKEN = process.env.PAGBANK_WEBHOOK_TOKEN || "";
const PAGBANK_CUSTOMER_TAX_ID_FALLBACK = process.env.PAGBANK_CUSTOMER_TAX_ID_FALLBACK || "12345678909";

// Credenciais e regras dos acessos administrativos da plataforma e dos tenants.
const ADMIN_REGISTRATION_TOKEN = process.env.ADMIN_REGISTRATION_TOKEN || "";
const PLATFORM_ADMIN_EMAIL = String(process.env.PLATFORM_ADMIN_EMAIL || "admin@apprifa.com").toLowerCase();
const PLATFORM_ADMIN_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || "";
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const stripe = PAYMENT_PROVIDER === "stripe" && STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Middlewares HTTP. Webhooks recebem o corpo bruto porque a assinatura do
// gateway deve ser validada sobre os bytes originais da requisicao.
const app = express();
app.use(cors());
app.use((req, res, next) => {
  if (["/api/webhooks/stripe", "/api/webhooks/pagbank", "/api/webhooks/mercadopago"].includes(req.path)) return next();
  return express.json({ limit: "10mb" })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

const uploadAbsoluteDir = path.join(__dirname, UPLOAD_DIR);
if (!fs.existsSync(uploadAbsoluteDir)) {
  fs.mkdirSync(uploadAbsoluteDir, { recursive: true });
}

app.use("/uploads", express.static(uploadAbsoluteDir));
// O painel administrativo muda junto com seus scripts; evita HTML e CSS incompatíveis em caches intermediários.
app.use(["/gestao.html", "/mercadopago-marketplace.js"], (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// Conexao compartilhada com o MySQL por meio do Sequelize.
const sequelize = new Sequelize(
  process.env.DB_NAME || "apprifa",
  process.env.DB_USER || "apprifa",
  process.env.DB_PASSWORD || "apprifa123",
  {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    dialect: "mysql",
    logging: false,
  }
);

// Tenant representa cada cliente independente dentro da plataforma.
const Tenant = sequelize.define("Tenant", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING(140), allowNull: false },
  slug: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  taxId: { type: DataTypes.STRING(18), allowNull: true },
  addressPostalCode: { type: DataTypes.STRING(9), allowNull: true },
  addressStreet: { type: DataTypes.STRING(180), allowNull: true },
  addressNumber: { type: DataTypes.STRING(30), allowNull: true },
  addressComplement: { type: DataTypes.STRING(100), allowNull: true },
  addressDistrict: { type: DataTypes.STRING(100), allowNull: true },
  addressCity: { type: DataTypes.STRING(100), allowNull: true },
  addressState: { type: DataTypes.STRING(2), allowNull: true },
  marketplaceFeePercent: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    defaultValue: MARKETPLACE_FEE_PERCENT,
  },
  status: {
    type: DataTypes.ENUM("ATIVO", "SUSPENSO"),
    allowNull: false,
    defaultValue: "ATIVO",
  },
});

// Usuario comprador ou gestor vinculado obrigatoriamente a um tenant.
const User = sequelize.define("User", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING(120), allowNull: false },
  email: { type: DataTypes.STRING(180), allowNull: false },
  phone: { type: DataTypes.STRING(40), allowNull: false },
  taxId: { type: DataTypes.STRING(18), allowNull: true },
  addressPostalCode: { type: DataTypes.STRING(9), allowNull: true },
  addressStreet: { type: DataTypes.STRING(180), allowNull: true },
  addressNumber: { type: DataTypes.STRING(30), allowNull: true },
  addressComplement: { type: DataTypes.STRING(100), allowNull: true },
  addressDistrict: { type: DataTypes.STRING(100), allowNull: true },
  addressCity: { type: DataTypes.STRING(100), allowNull: true },
  addressState: { type: DataTypes.STRING(2), allowNull: true },
  role: { type: DataTypes.ENUM("user", "admin", "owner"), allowNull: false, defaultValue: "user" },
  passwordHash: { type: DataTypes.STRING(255), allowNull: false },
});

// Conta de pagamento conectada pelo cliente via Stripe Connect.
const TenantPaymentProvider = sequelize.define("TenantPaymentProvider", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  provider: { type: DataTypes.ENUM("stripe", "mercadopago"), allowNull: false },
  accountId: { type: DataTypes.STRING(120), allowNull: false },
  accessToken: { type: DataTypes.TEXT("long"), allowNull: true,
    get() { return oauthCipher.decrypt(this.getDataValue("accessToken")); },
    set(value) { this.setDataValue("accessToken", oauthCipher.encrypt(value)); },
  },
  refreshToken: { type: DataTypes.TEXT("long"), allowNull: true,
    get() { return oauthCipher.decrypt(this.getDataValue("refreshToken")); },
    set(value) { this.setDataValue("refreshToken", oauthCipher.encrypt(value)); },
  },
  scope: { type: DataTypes.TEXT, allowNull: true },
  livemode: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  expiresAt: { type: DataTypes.DATE, allowNull: true },
  accountHolderName: { type: DataTypes.STRING(180), allowNull: true },
  accountHolderType: { type: DataTypes.STRING(2), allowNull: true },
  accountHolderTaxId: { type: DataTypes.STRING(18), allowNull: true },
  accountEmail: { type: DataTypes.STRING(180), allowNull: true },
  accountPhone: { type: DataTypes.STRING(40), allowNull: true },
  kycConfirmed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  status: {
    type: DataTypes.ENUM("ATIVO", "INATIVO"),
    allowNull: false,
    defaultValue: "ATIVO",
  },
});

// Tentativa OAuth do organizador: state de uso unico e PKCE cifrado em repouso.
const MercadoPagoOAuthState = sequelize.define("MercadoPagoOAuthState", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  stateHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  codeVerifier: {
    type: DataTypes.TEXT, allowNull: false,
    get() { return oauthCipher.decrypt(this.getDataValue("codeVerifier")); },
    set(value) { this.setDataValue("codeVerifier", oauthCipher.encrypt(value)); },
  },
  expiresAt: { type: DataTypes.DATE, allowNull: false },
  usedAt: { type: DataTypes.DATE, allowNull: true },
});

// Auditoria e idempotencia dos eventos enviados pelo Mercado Pago.
const MercadoPagoWebhookEvent = sequelize.define("MercadoPagoWebhookEvent", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  eventKey: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  externalPaymentId: { type: DataTypes.STRING(120), allowNull: false },
  requestId: { type: DataTypes.STRING(160), allowNull: false },
  action: { type: DataTypes.STRING(100), allowNull: true },
  status: { type: DataTypes.ENUM("RECEBIDO", "PROCESSADO", "FALHOU", "IGNORADO"), allowNull: false },
  attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  processedAt: { type: DataTypes.DATE, allowNull: true },
  lastError: { type: DataTypes.STRING(255), allowNull: true },
});

// Identidade publica verificada da conta marketplace proprietaria da aplicacao.
const PlatformPaymentConfiguration = sequelize.define("PlatformPaymentConfiguration", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  provider: { type: DataTypes.STRING(50), allowNull: false, unique: true },
  accountId: { type: DataTypes.STRING(120), allowNull: true },
  country: { type: DataTypes.STRING(2), allowNull: true },
  site: { type: DataTypes.STRING(10), allowNull: true },
  testAccount: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  verifiedAt: { type: DataTypes.DATE, allowNull: true },
});

const SchemaMigration = sequelize.define("SchemaMigration", {
  version: { type: DataTypes.STRING(100), allowNull: false, unique: true },
});

// Produto ou premio que sera associado a uma ou mais rifas.
const Product = sequelize.define("Product", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  title: { type: DataTypes.STRING(180), allowNull: false },
  description: { type: DataTypes.TEXT("long"), allowNull: false },
  media: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
});

// Rifa com sua faixa numerica, preco, modalidade e resultado final.
const Raffle = sequelize.define("Raffle", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  type: {
    type: DataTypes.ENUM("BICHO_25", "NUMERICA_100", "NUMERICA_1000"),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM("ABERTA", "ENCERRADA"),
    allowNull: false,
    defaultValue: "ABERTA",
  },
  title: { type: DataTypes.STRING(180), allowNull: false },
  description: { type: DataTypes.TEXT("long"), allowNull: false },
  pricePerNumber: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  discountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
  totalNumbers: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  winnerCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 3 },
  drawMode: {
    type: DataTypes.ENUM("BICHO_RJ", "ALEATORIO"),
    allowNull: false,
  },
  winners: { type: DataTypes.JSON, allowNull: true },
  drawSource: { type: DataTypes.STRING(255), allowNull: true },
  drawAt: { type: DataTypes.DATE, allowNull: true },
});

// Cobranca criada no gateway para uma selecao de numeros.
const Payment = sequelize.define("Payment", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  method: {
    type: DataTypes.ENUM("pix", "credito", "debito"),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM("pendente", "pago", "falhou"),
    allowNull: false,
    defaultValue: "pendente",
  },
  provider: { type: DataTypes.STRING(50), allowNull: false, defaultValue: "mock" },
  providerAccountId: { type: DataTypes.STRING(120), allowNull: true },
  requestKey: { type: DataTypes.STRING(80), allowNull: true },
  idempotencyKey: { type: DataTypes.STRING(36), allowNull: true },
  requestFingerprint: { type: DataTypes.STRING(64), allowNull: true },
  expiresAt: { type: DataTypes.DATE, allowNull: true },
  processingAt: { type: DataTypes.DATE, allowNull: true },
  reconciledAt: { type: DataTypes.DATE, allowNull: true },
  marketplaceFeePercent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
  marketplaceFeeAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  mercadoPagoFeeAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  sellerNetAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  financialStatus: { type: DataTypes.STRING(40), allowNull: true },
  externalId: { type: DataTypes.STRING(120), allowNull: true },
  payload: { type: DataTypes.JSON, allowNull: true },
});

// Numero reservado ou confirmado para um comprador em determinada rifa.
const Ticket = sequelize.define("Ticket", {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  status: {
    type: DataTypes.ENUM("reservado", "confirmado"),
    allowNull: false,
    defaultValue: "confirmado",
  },
});

// Relacionamentos que garantem navegacao e isolamento dos dados por tenant.
Tenant.hasMany(User, { foreignKey: "tenantId" });
User.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(TenantPaymentProvider, { foreignKey: "tenantId" });
TenantPaymentProvider.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(MercadoPagoOAuthState, { foreignKey: "tenantId" });
MercadoPagoOAuthState.belongsTo(Tenant, { foreignKey: "tenantId" });

User.hasMany(MercadoPagoOAuthState, { foreignKey: "userId" });
MercadoPagoOAuthState.belongsTo(User, { foreignKey: "userId" });

Tenant.hasMany(Product, { foreignKey: "tenantId" });
Product.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(Raffle, { foreignKey: "tenantId" });
Raffle.belongsTo(Tenant, { foreignKey: "tenantId" });

Product.hasMany(Raffle, { foreignKey: "productId" });
Raffle.belongsTo(Product, { foreignKey: "productId" });

Tenant.hasMany(Payment, { foreignKey: "tenantId" });
Payment.belongsTo(Tenant, { foreignKey: "tenantId" });

User.hasMany(Payment, { foreignKey: "userId" });
Payment.belongsTo(User, { foreignKey: "userId" });

Raffle.hasMany(Payment, { foreignKey: "raffleId" });
Payment.belongsTo(Raffle, { foreignKey: "raffleId" });

Tenant.hasMany(Ticket, { foreignKey: "tenantId" });
Ticket.belongsTo(Tenant, { foreignKey: "tenantId" });

User.hasMany(Ticket, { foreignKey: "userId" });
Ticket.belongsTo(User, { foreignKey: "userId" });

Raffle.hasMany(Ticket, { foreignKey: "raffleId" });
Ticket.belongsTo(Raffle, { foreignKey: "raffleId" });

Payment.hasMany(Ticket, { foreignKey: "paymentId" });
Ticket.belongsTo(Payment, { foreignKey: "paymentId" });

Ticket.addHook("beforeValidate", (ticket) => {
  if (ticket.number < 1) throw new Error("Numero invalido");
});

// Armazenamento local das midias enviadas. O nome aleatorio evita colisoes.
const multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadAbsoluteDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    cb(null, safeName);
  },
});
const upload = multer({ storage: multerStorage });

// Converte o identificador publico do cliente para um formato uniforme e seguro.
function normalizeTenantSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeMarketplaceFeePercent(raw) {
  const value = typeof raw === "string" ? raw.trim().replace(",", ".") : raw;
  if (value === "" || value === null || value === undefined) return null;
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? Number(percent.toFixed(2))
    : null;
}

function normalizePostalCode(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : "";
}

function normalizeTaxId(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function taxIdHasValidLength(value) {
  return value.length === 11 || value.length === 14;
}

function formatTaxId(raw) {
  const value = normalizeTaxId(raw);
  if (value.length === 11) return value.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (value.length === 14) return value.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return value;
}

function normalizeAddress(raw = {}) {
  return {
    addressPostalCode: normalizePostalCode(raw.addressPostalCode),
    addressStreet: String(raw.addressStreet || "").trim(),
    addressNumber: String(raw.addressNumber || "").trim(),
    addressComplement: String(raw.addressComplement || "").trim(),
    addressDistrict: String(raw.addressDistrict || "").trim(),
    addressCity: String(raw.addressCity || "").trim(),
    addressState: String(raw.addressState || "").trim().toUpperCase(),
  };
}

function addressIsComplete(address) {
  return Boolean(
    address.addressPostalCode &&
    address.addressStreet &&
    address.addressNumber &&
    address.addressDistrict &&
    address.addressCity &&
    /^[A-Z]{2}$/.test(address.addressState)
  );
}

function addressLine(address) {
  return `${address.addressStreet}, ${address.addressNumber}`;
}

function addressComplementLine(address) {
  return [address.addressComplement, address.addressDistrict].filter(Boolean).join(" - ");
}

function addressCityLine(address) {
  return `${address.addressPostalCode}  ${address.addressCity}/${address.addressState}`;
}

// Emite o JWT de um usuario do tenant com validade de sete dias.
function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// Valida o JWT do usuario e disponibiliza usuario e tenant na requisicao.
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");
  if (!token) return res.status(401).json({ error: "Token ausente" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.tenantId = req.user.tenantId;
    return next();
  } catch (_error) {
    return res.status(401).json({ error: "Token invalido" });
  }
}

// Restringe operacoes de gestao aos perfis admin e owner do cliente.
function adminMiddleware(req, res, next) {
  if (!req.user || !["admin", "owner"].includes(req.user.role)) {
    return res.status(403).json({ error: "Apenas administradores podem executar esta acao" });
  }
  return next();
}

// Valida o token exclusivo do administrador global da plataforma.
function platformAdminMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");
  if (!token) return res.status(401).json({ error: "Token da plataforma ausente" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.scope !== "platform_admin") throw new Error("Escopo invalido");
    req.platformAdmin = payload;
    return next();
  } catch (_error) {
    return res.status(401).json({ error: "Token da plataforma invalido" });
  }
}

// Gera e valida o state temporario usado para impedir adulteracao no OAuth.
function makeConnectStateToken(tenantId) {
  return jwt.sign({ tenantId, scope: "stripe_connect" }, JWT_SECRET, { expiresIn: "15m" });
}

function parseConnectStateToken(state) {
  const payload = jwt.verify(state, JWT_SECRET);
  if (!payload || payload.scope !== "stripe_connect") {
    throw new Error("State invalido");
  }
  return payload;
}

// Retorna a quantidade fixa de numeros correspondente a cada tipo de rifa.
function rangeByType(type, customTotalNumbers) {
  if (type === "BICHO_25") return 25;
  if (type === "NUMERICA_100") return 100;
  if (type === "NUMERICA_1000") {
    const total = Number(customTotalNumbers);
    if (Number.isInteger(total) && total >= 1 && total <= 1000) return total;
    throw new Error("A rifa personalizada deve ter entre 1 e 1000 numeros");
  }
  throw new Error("Tipo de rifa invalido");
}

function maskWinnerPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length >= 10) return `(${digits.slice(0, 2)}) *****-${digits.slice(-4)}`;
  return `*****-${digits.slice(-4)}`;
}

function serializeWinners(winners) {
  if (!Array.isArray(winners)) return null;
  return winners.map((winner) => ({
    ...winner,
    user: winner?.user ? { ...winner.user, phone: maskWinnerPhone(winner.user.phone) } : null,
  }));
}

// Monta a resposta publica da rifa incluindo ocupacao e dados do produto.
function serializeRaffle(raffle, soldNumbers) {
  return {
    id: raffle.id,
    tenantId: raffle.tenantId,
    type: raffle.type,
    status: raffle.status,
    title: raffle.title,
    description: raffle.description,
    pricePerNumber: Number(raffle.pricePerNumber),
    discountPercent: Number(raffle.discountPercent),
    totalNumbers: raffle.totalNumbers,
    winnerCount: raffle.winnerCount,
    drawMode: raffle.drawMode,
    drawSource: raffle.drawSource,
    drawAt: raffle.drawAt,
    winners: serializeWinners(raffle.winners),
    product: raffle.Product,
    soldCount: soldNumbers.length,
    soldNumbers,
  };
}

async function userIsRaffleWinner(raffle, userId) {
  const winners = Array.isArray(raffle.winners) ? raffle.winners : [];
  if (winners.some((winner) => Number(winner?.user?.id) === Number(userId))) return true;
  const winningNumbers = winners.map((winner) => Number(winner?.number)).filter(Number.isInteger);
  if (!winningNumbers.length) return false;
  const winningTicket = await Ticket.findOne({
    where: {
      tenantId: raffle.tenantId,
      raffleId: raffle.id,
      userId,
      number: { [Op.in]: winningNumbers },
      status: "confirmado",
    },
    attributes: ["id"],
  });
  return Boolean(winningTicket);
}

// Seleciona vencedores distintos para as rifas numericas automaticas.
function drawRandomDistinct(values, quantity) {
  const copy = [...values];
  const result = [];
  for (let i = 0; i < quantity && copy.length > 0; i += 1) {
    const idx = crypto.randomInt(copy.length);
    result.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return result;
}

// Lista numeros confirmados ou reservados, com bloqueio transacional opcional.
async function listUnavailableNumbersByRaffleId(tenantId, raffleId, options = {}) {
  const paymentStatuses = options.paymentStatuses || ["pago", "pendente"];
  const queryOptions = {};
  if (options.transaction) {
    queryOptions.transaction = options.transaction;
    queryOptions.lock = options.transaction.LOCK.UPDATE;
  }

  const tickets = await Ticket.findAll({
    where: { tenantId, raffleId },
    include: [
      {
        model: Payment,
        where: { tenantId, status: { [Op.in]: paymentStatuses } },
        attributes: ["id", "status"],
      },
    ],
    order: [["number", "ASC"]],
    ...queryOptions,
  });

  return tickets.map((ticket) => ticket.number);
}

// Lista somente numeros cujo pagamento ja foi confirmado.
async function listConfirmedNumbersByRaffleId(tenantId, raffleId, queryOptions = {}) {
  const tickets = await Ticket.findAll({
    where: { tenantId, raffleId, status: "confirmado" },
    include: [{ model: Payment, where: { tenantId, status: "pago" }, attributes: ["id"] }],
    order: [["number", "ASC"]],
    ...queryOptions,
  });
  return tickets.map((ticket) => ticket.number);
}

// Monta as colocacoes sorteando numeros distintos entre tickets efetivamente pagos.
async function drawWinnersFromPaidTickets(tickets, tenantId, winnerCount, transaction) {
  const selected = drawRandomDistinct(tickets, winnerCount);
  const winners = [];
  for (let i = 0; i < selected.length; i += 1) {
    const ticket = selected[i];
    const owner = await User.findOne({
      where: { id: ticket.userId, tenantId },
      attributes: ["id", "name", "email", "phone"],
      transaction,
    });
    winners.push({ place: i + 1, number: ticket.number, user: owner });
  }
  return winners;
}

// Encerra e sorteia automaticamente uma rifa numerica quando todas as cotas pagaram.
async function maybeAutoDraw(tenantId, raffleId) {
  return sequelize.transaction(async (transaction) => {
  const raffle = await Raffle.findOne({ where: { id: raffleId, tenantId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!raffle || raffle.status !== "ABERTA") return raffle;

  const soldNumbers = await listConfirmedNumbersByRaffleId(tenantId, raffleId, { transaction });
  if (soldNumbers.length < raffle.totalNumbers) return raffle;

  if (raffle.type === "BICHO_25") {
    return raffle;
  }

  const selected = drawRandomDistinct(soldNumbers, raffle.winnerCount);
  const winners = [];
  for (let i = 0; i < selected.length; i += 1) {
    const ticket = await Ticket.findOne({
      where: { tenantId, raffleId, number: selected[i], status: "confirmado" },
      transaction,
      include: [{ model: Payment, where: { tenantId, status: "pago" }, attributes: ["id"] }],
    });
    if (!ticket) continue;

    const owner = await User.findOne({
      where: { id: ticket.userId, tenantId },
      attributes: ["id", "name", "email", "phone"],
      transaction,
    });
    winners.push({ place: i + 1, number: ticket.number, user: owner });
  }

  raffle.status = "ENCERRADA";
  raffle.drawAt = new Date();
  raffle.drawMode = "ALEATORIO";
  raffle.drawSource = "Sorteio automatico randomico";
  raffle.winners = winners;
  await raffle.save({ transaction });
  return raffle;
  });
}

// Verifica todas as rifas numericas abertas de um tenant.
async function maybeAutoDrawForAllOpenNumericRaffles(tenantId) {
  const openNumeric = await Raffle.findAll({
    where: {
      tenantId,
      status: "ABERTA",
      type: { [Op.in]: ["NUMERICA_100", "NUMERICA_1000"] },
    },
    attributes: ["id"],
  });

  for (const raffle of openNumeric) {
    await maybeAutoDraw(tenantId, raffle.id);
  }
}

// Localiza a conta Stripe Connect ativa que recebera o PIX daquele cliente.
async function resolveTenantStripeProvider(tenantId) {
  if (PAYMENT_PROVIDER !== "stripe" || !stripe) return null;
  return TenantPaymentProvider.findOne({
    where: { tenantId, provider: "stripe", status: "ATIVO" },
    order: [["id", "DESC"]],
  });
}

// Localiza a autorizacao Mercado Pago do vendedor e renova o token quando necessario.
async function resolveTenantMercadoPagoProvider(tenantId, accountId) {
  if (PAYMENT_PROVIDER !== "mercadopago") return null;
  return sequelize.transaction(async (transaction) => {
  const provider = await TenantPaymentProvider.findOne({
    where: { tenantId, provider: "mercadopago", status: "ATIVO", ...(accountId ? { accountId } : {}) },
    order: [["id", "DESC"]],
    transaction, lock: transaction.LOCK.UPDATE,
  });
  if (!provider || !provider.refreshToken || !provider.expiresAt) return provider;

  if (new Date(provider.expiresAt).getTime() > Date.now() + 24 * 60 * 60 * 1000) return provider;
  const token = await mercadoPagoOAuthToken({
    grant_type: "refresh_token",
    refresh_token: provider.refreshToken,
  });
  provider.accessToken = token.access_token;
  provider.refreshToken = token.refresh_token || provider.refreshToken;
  provider.expiresAt = new Date(Date.now() + Number(token.expires_in || 15552000) * 1000);
  await provider.save({ transaction });
  return provider;
  });
}

// Troca authorization_code ou refresh_token por credenciais OAuth do vendedor.
async function mercadoPagoOAuthToken(data) {
  const response = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      client_id: MERCADOPAGO_APP_ID,
      client_secret: MERCADOPAGO_CLIENT_SECRET,
      ...data,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "Falha no OAuth Mercado Pago");
  return payload;
}

// Executa chamadas autenticadas em nome da conta Mercado Pago do cliente.
async function mercadoPagoRequest(pathname, accessToken, { method = "GET", body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`https://api.mercadopago.com${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const cause = Array.isArray(payload.cause) ? payload.cause[0] : payload.cause;
    const error = new Error("Falha na API Mercado Pago (HTTP " + response.status + ")");
    error.httpStatus = response.status;
    error.gatewayCode = String(cause?.code || payload.code || "");
    throw error;
  }
  return payload;
}

function mapMercadoPagoStatus(status) {
  if (status === "approved") return "pago";
  if (["pending", "in_process", "authorized"].includes(status)) return "pendente";
  return "falhou";
}

// Normaliza os estados externos do PagBank para os estados internos do pagamento.
function mapPagBankChargeStatus(status) {
  if (["PAID"].includes(status)) return "pago";
  if (["WAITING", "AUTHORIZED", "IN_ANALYSIS"].includes(status)) return "pendente";
  return "falhou";
}

// Cliente HTTP centralizado para chamadas autenticadas ao PagBank.
async function pagBankRequest(pathname, { method = "GET", body, idempotencyKey } = {}) {
  if (!PAGBANK_ACCESS_TOKEN) {
    throw new Error("PAGBANK_ACCESS_TOKEN nao configurado no servidor");
  }

  const headers = {
    Authorization: `Bearer ${PAGBANK_ACCESS_TOKEN}`,
    Accept: "application/json",
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }
  if (idempotencyKey) {
    headers["x-idempotency-key"] = idempotencyKey;
  }

  const response = await fetch(`${PAGBANK_API_BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error_messages?.[0]?.description || payload?.message || "Erro ao comunicar com PagBank");
  }
  return payload;
}

// Constrói a ordem PagBank conforme valor, comprador e meio de pagamento.
function buildPagBankOrderPayload({
  user,
  raffle,
  numbers,
  amountInCents,
  method,
  paymentDetails,
  metadata,
}) {
  const now = Date.now();
  const customerTaxId = String(paymentDetails?.customerTaxId || PAGBANK_CUSTOMER_TAX_ID_FALLBACK || "").replace(/\D/g, "");
  if (!customerTaxId) {
    throw new Error("CPF/CNPJ do cliente e obrigatorio para PagBank");
  }

  const notificationUrls = [];
  if (PAGBANK_NOTIFICATION_URL) notificationUrls.push(PAGBANK_NOTIFICATION_URL);

  const referenceId = `rifa-${metadata.tenantId}-${raffle.id}-${now}`;
  const chargeReference = `charge-${metadata.raffleId}-${metadata.userId}-${now}`;

  const base = {
    reference_id: referenceId,
    customer: {
      name: user.name,
      email: user.email,
      tax_id: customerTaxId,
      phones: [
        {
          country: "55",
          area: "11",
          number: String(user.phone || "999999999").replace(/\D/g, "").slice(-9) || "999999999",
          type: "MOBILE",
        },
      ],
    },
    items: [
      {
        reference_id: `raffle-${raffle.id}`,
        name: raffle.title.slice(0, 120),
        quantity: 1,
        unit_amount: amountInCents,
      },
    ],
    charges: [
      {
        reference_id: chargeReference,
        description: `Compra de ${numbers.length} numeros da rifa ${raffle.id}`,
        amount: { value: amountInCents, currency: "BRL" },
        payment_method: {},
      },
    ],
  };

  if (notificationUrls.length > 0) {
    base.notification_urls = notificationUrls;
  }

  if (method === "pix") {
    base.charges[0].payment_method = {
      type: "PIX",
      pix: {
        expiration_date: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    };
    return base;
  }

  const card = paymentDetails?.card || {};
  if (!card.encrypted) {
    throw new Error("Cartao criptografado nao enviado para PagBank");
  }

  const cardBase = {
    encrypted: card.encrypted,
    exp_month: Number(card.expMonth),
    exp_year: Number(card.expYear),
    security_code: String(card.securityCode || ""),
    holder: {
      name: card.holderName || user.name,
      tax_id: String(card.holderTaxId || customerTaxId).replace(/\D/g, ""),
    },
    store: false,
  };

  if (method === "credito") {
    base.charges[0].payment_method = {
      type: "CREDIT_CARD",
      installments: Number(card.installments || 1),
      capture: true,
      card: cardBase,
    };
    return base;
  }

  const auth = card.authenticationMethod || {};
  if (!auth.eci) {
    throw new Error("authenticationMethod.eci e obrigatorio para debito no PagBank");
  }

  base.charges[0].payment_method = {
    type: "DEBIT_CARD",
    card: cardBase,
    authentication_method: {
      type: auth.type || "THREEDS",
      eci: String(auth.eci),
      ...(auth.cavv ? { cavv: auth.cavv } : {}),
      ...(auth.xid ? { xid: auth.xid } : {}),
      ...(auth.version ? { version: auth.version } : {}),
      ...(auth.dstransId ? { dstrans_id: auth.dstransId } : {}),
    },
  };

  return base;
}

// Encaminha a cobranca ao provider configurado e devolve um resultado padronizado.
// O modo mock aprova imediatamente e deve ser usado apenas em desenvolvimento.
async function processPaymentWithGateway({
  method,
  amount,
  metadata,
  paymentMethodId,
  tenantProvider,
  paymentDetails,
  user,
  raffle,
  numbers,
}) {
  if (PAYMENT_PROVIDER === "pagbank") {
    const amountInCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountInCents) || amountInCents <= 0) {
      throw new Error("Valor de pagamento invalido");
    }

    const orderPayload = buildPagBankOrderPayload({
      user,
      raffle,
      numbers,
      amountInCents,
      method,
      paymentDetails,
      metadata,
    });

    const idempotencyKey = crypto.randomUUID();
    const order = await pagBankRequest("/orders", {
      method: "POST",
      body: orderPayload,
      idempotencyKey,
    });

    const charge = Array.isArray(order.charges) && order.charges.length > 0 ? order.charges[0] : null;
    if (!charge || !charge.id) {
      throw new Error("Resposta do PagBank sem identificador de cobranca");
    }

    const paymentStatus = mapPagBankChargeStatus(charge.status);
    const qrCode = charge.qr_code || null;
    const qrLink = (charge.links || []).find((link) => link.rel === "QRCODE.PNG") || null;

    return {
      status: paymentStatus,
      provider: "pagbank",
      providerAccountId: null,
      externalId: charge.id,
      payload: {
        provider: "pagbank",
        orderId: order.id || null,
        chargeId: charge.id,
        status: charge.status,
        paymentMethodType: charge.payment_method?.type || null,
        qrCodeText: qrCode?.text || null,
        qrCodeId: qrCode?.id || null,
        qrCodeImage: qrLink?.href || null,
        rawOrder: order,
      },
    };
  }

  if (PAYMENT_PROVIDER !== "stripe" || !stripe) {
    return {
      status: "pago",
      provider: "mock",
      providerAccountId: null,
      externalId: `TX-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      payload: {
        approvedAt: new Date().toISOString(),
        provider: "mock-gateway",
      },
    };
  }

  if (!tenantProvider) {
    throw new Error("Tenant sem conta Stripe Connect ativa");
  }

  const amountInCents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountInCents) || amountInCents <= 0) {
    throw new Error("Valor de pagamento invalido");
  }

  const requestOptions = { stripeAccount: tenantProvider.accountId };

  if (method === "pix") {
    const intent = await stripe.paymentIntents.create(
      {
        amount: amountInCents,
        currency: "brl",
        payment_method_types: ["pix"],
        payment_method_data: {
          type: "pix",
          billing_details: {
            name: user.name,
            email: user.email,
            phone: user.phone,
          },
        },
        confirm: true,
        metadata,
        description: "Pagamento PIX de rifa",
      },
      requestOptions
    );

    return {
      status: "pendente",
      provider: "stripe",
      providerAccountId: tenantProvider.accountId,
      externalId: intent.id,
      payload: {
        provider: "stripe",
        mode: "pix",
        status: intent.status,
        clientSecret: intent.client_secret,
        nextAction: intent.next_action || null,
      },
    };
  }

  if (!paymentMethodId) {
    throw new Error("paymentMethodId e obrigatorio para pagamento em cartao com Stripe");
  }

  const intent = await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency: "brl",
      payment_method: paymentMethodId,
      confirm: true,
      metadata,
      description: "Pagamento de rifa",
      payment_method_types: ["card"],
    },
    requestOptions
  );

  return {
    status: intent.status === "succeeded" ? "pago" : "falhou",
    provider: "stripe",
    providerAccountId: tenantProvider.accountId,
    externalId: intent.id,
    payload: {
      provider: "stripe",
      status: intent.status,
      amountReceived: intent.amount_received,
      latestCharge: intent.latest_charge,
    },
  };
}

// --- Saude da aplicacao ----------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// --- Administracao global da plataforma ----------------------------------
// Autentica o operador que cria e controla os clientes do AppRifa.
app.post("/api/platform/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!PLATFORM_ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Administrador da plataforma nao configurado" });
  }
  const samePasswordLength = password.length === PLATFORM_ADMIN_PASSWORD.length;
  const passwordMatches = samePasswordLength && crypto.timingSafeEqual(
    Buffer.from(password),
    Buffer.from(PLATFORM_ADMIN_PASSWORD)
  );
  if (email !== PLATFORM_ADMIN_EMAIL || !passwordMatches) {
    return res.status(401).json({ error: "Credenciais invalidas" });
  }

  const token = jwt.sign(
    { email: PLATFORM_ADMIN_EMAIL, scope: "platform_admin" },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
  return res.json({ token, admin: { email: PLATFORM_ADMIN_EMAIL, role: "platform_admin" } });
});

// Lista os clientes e seus respectivos owners para o painel da plataforma.
app.get("/api/platform/tenants", platformAdminMiddleware, async (_req, res) => {
  const tenants = await Tenant.findAll({
    include: [{
      model: User,
      where: { role: "owner" },
      required: false,
      attributes: ["id", "name", "email", "phone", "taxId"],
    }],
    order: [["id", "DESC"]],
  });
  const result = await Promise.all(tenants.map(async (tenant) => ({
    ...tenant.toJSON(),
    raffleCount: await Raffle.count({ where: { tenantId: tenant.id } }),
  })));
  return res.json(result);
});

// Lista todos os usuarios cadastrados, com cliente e quantidade de numeros associados.
app.get("/api/platform/users", platformAdminMiddleware, async (_req, res) => {
  const users = await User.findAll({
    attributes: [
      "id", "tenantId", "name", "email", "phone", "taxId", "role", "createdAt", "updatedAt",
      "addressPostalCode", "addressStreet", "addressNumber", "addressComplement",
      "addressDistrict", "addressCity", "addressState",
    ],
    include: [{ model: Tenant, attributes: ["id", "name", "slug", "status"] }],
    order: [["id", "DESC"]],
  });
  const result = await Promise.all(users.map(async (user) => ({
    ...user.toJSON(),
    ticketCount: await Ticket.count({ where: { tenantId: user.tenantId, userId: user.id } }),
  })));
  return res.json(result);
});

// Atualiza os dados, perfil e senha opcional de um usuario cadastrado.
app.patch("/api/platform/users/:id", platformAdminMiddleware, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const user = await User.findByPk(req.params.id, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!user) {
      await tx.rollback();
      return res.status(404).json({ error: "Usuario nao encontrado" });
    }

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").trim();
    const taxId = normalizeTaxId(req.body.taxId);
    const role = String(req.body.role || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const address = normalizeAddress(req.body);
    if (!name || !email || !phone || !taxIdHasValidLength(taxId) || !["user", "admin", "owner"].includes(role) || !addressIsComplete(address)) {
      await tx.rollback();
      return res.status(400).json({ error: "Preencha corretamente os dados obrigatorios do usuario" });
    }
    if (password && password.length < 8) {
      await tx.rollback();
      return res.status(400).json({ error: "A nova senha deve ter ao menos 8 caracteres" });
    }

    const emailInUse = await User.findOne({
      where: { tenantId: user.tenantId, email, id: { [Op.ne]: user.id } },
      transaction: tx,
    });
    if (emailInUse) {
      await tx.rollback();
      return res.status(409).json({ error: "E-mail ja utilizado neste cliente" });
    }

    if (user.role === "owner" && role !== "owner") {
      const ownerCount = await User.count({
        where: { tenantId: user.tenantId, role: "owner" },
        transaction: tx,
      });
      if (ownerCount <= 1) {
        await tx.rollback();
        return res.status(409).json({ error: "O cliente deve manter ao menos um proprietario" });
      }
    }

    const changes = { name, email, phone, taxId, role, ...address };
    if (password) changes.passwordHash = await bcrypt.hash(password, 10);
    await user.update(changes, { transaction: tx });
    await tx.commit();

    return res.json({
      user: {
        id: user.id,
        tenantId: user.tenantId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        taxId: user.taxId,
        role: user.role,
        ...address,
      },
      passwordUpdated: Boolean(password),
    });
  } catch (error) {
    if (!tx.finished) await tx.rollback();
    return res.status(500).json({ error: "Erro ao atualizar usuario", details: error.message });
  }
});

// Exibe as rifas cadastradas por um cliente no painel administrativo global.
app.get("/api/platform/tenants/:id/raffles", platformAdminMiddleware, async (req, res) => {
  const tenant = await Tenant.findByPk(req.params.id, { attributes: ["id"] });
  if (!tenant) return res.status(404).json({ error: "Cliente nao encontrado" });

  const raffles = await Raffle.findAll({
    where: { tenantId: tenant.id },
    include: [{ model: Product, attributes: ["id", "title", "description", "media"] }],
    order: [["id", "DESC"]],
  });
  const result = await Promise.all(raffles.map(async (raffle) => {
    const soldNumbers = await listUnavailableNumbersByRaffleId(tenant.id, raffle.id);
    return serializeRaffle(raffle, soldNumbers);
  }));
  return res.json(result);
});

// Atualiza os dados do cliente e do owner, incluindo redefinicao opcional da senha.
app.patch("/api/platform/tenants/:id", platformAdminMiddleware, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const tenant = await Tenant.findByPk(req.params.id, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!tenant) {
      await tx.rollback();
      return res.status(404).json({ error: "Cliente nao encontrado" });
    }

    const owner = await User.findOne({
      where: { tenantId: tenant.id, role: "owner" },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!owner) {
      await tx.rollback();
      return res.status(404).json({ error: "Responsavel principal nao encontrado" });
    }

    const tenantName = String(req.body.tenantName || "").trim();
    const tenantSlug = normalizeTenantSlug(req.body.tenantSlug);
    const ownerName = String(req.body.ownerName || "").trim();
    const ownerEmail = String(req.body.ownerEmail || "").trim().toLowerCase();
    const ownerPhone = String(req.body.ownerPhone || "").trim();
    const tenantTaxId = normalizeTaxId(req.body.tenantTaxId);
    const ownerTaxId = normalizeTaxId(req.body.ownerTaxId);
    const ownerPassword = String(req.body.ownerPassword || "");
    const marketplaceFeePercent = normalizeMarketplaceFeePercent(
      req.body.marketplaceFeePercent ?? tenant.marketplaceFeePercent ?? MARKETPLACE_FEE_PERCENT
    );
    const address = normalizeAddress(req.body);
    if (!tenantName || !tenantSlug || !ownerName || !ownerEmail || !ownerPhone || marketplaceFeePercent === null || !taxIdHasValidLength(tenantTaxId) || !taxIdHasValidLength(ownerTaxId) || !addressIsComplete(address)) {
      await tx.rollback();
      return res.status(400).json({ error: "Preencha todos os dados obrigatorios do cliente" });
    }
    if (ownerPassword && ownerPassword.length < 8) {
      await tx.rollback();
      return res.status(400).json({ error: "A nova senha deve ter ao menos 8 caracteres" });
    }

    const slugInUse = await Tenant.findOne({
      where: { slug: tenantSlug, id: { [Op.ne]: tenant.id } },
      transaction: tx,
    });
    if (slugInUse) {
      await tx.rollback();
      return res.status(409).json({ error: "Slug de tenant ja em uso" });
    }
    const emailInUse = await User.findOne({
      where: { tenantId: tenant.id, email: ownerEmail, id: { [Op.ne]: owner.id } },
      transaction: tx,
    });
    if (emailInUse) {
      await tx.rollback();
      return res.status(409).json({ error: "E-mail ja utilizado neste cliente" });
    }

    await tenant.update({ name: tenantName, slug: tenantSlug, taxId: tenantTaxId, marketplaceFeePercent, ...address }, { transaction: tx });
    const ownerChanges = { name: ownerName, email: ownerEmail, phone: ownerPhone, taxId: ownerTaxId, ...address };
    if (ownerPassword) ownerChanges.passwordHash = await bcrypt.hash(ownerPassword, 10);
    await owner.update(ownerChanges, { transaction: tx });
    await tx.commit();

    return res.json({
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, taxId: tenant.taxId, marketplaceFeePercent: Number(tenant.marketplaceFeePercent), ...address },
      owner: { id: owner.id, name: owner.name, email: owner.email, phone: owner.phone, role: owner.role },
      passwordUpdated: Boolean(ownerPassword),
    });
  } catch (error) {
    if (!tx.finished) await tx.rollback();
    return res.status(500).json({ error: "Erro ao atualizar cliente", details: error.message });
  }
});

// Ativa ou suspende um cliente e, consequentemente, seus logins.
app.patch("/api/platform/tenants/:id/status", platformAdminMiddleware, async (req, res) => {
  const status = String(req.body.status || "").toUpperCase();
  if (!["ATIVO", "SUSPENSO"].includes(status)) {
    return res.status(400).json({ error: "Status invalido" });
  }
  const tenant = await Tenant.findByPk(req.params.id);
  if (!tenant) return res.status(404).json({ error: "Cliente nao encontrado" });
  tenant.status = status;
  await tenant.save();
  return res.json({ id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status });
});

// Cria atomicamente o tenant e o primeiro usuario owner desse cliente.
app.post("/api/platform/tenants", platformAdminMiddleware, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const { tenantName, tenantSlug, ownerName, ownerEmail, ownerPhone, ownerPassword } = req.body;
    const tenantTaxId = normalizeTaxId(req.body.tenantTaxId);
    const ownerTaxId = normalizeTaxId(req.body.ownerTaxId);
    const marketplaceFeePercent = normalizeMarketplaceFeePercent(req.body.marketplaceFeePercent ?? MARKETPLACE_FEE_PERCENT);
    const address = normalizeAddress(req.body);
    const slug = normalizeTenantSlug(tenantSlug);
    const invalidFields = [];
    if (!String(tenantName || "").trim()) invalidFields.push("empresa ou cliente");
    if (!slug) invalidFields.push("identificador da loja");
    if (!taxIdHasValidLength(tenantTaxId)) invalidFields.push("CPF/CNPJ do remetente");
    if (!address.addressPostalCode) invalidFields.push("CEP com 8 dígitos");
    if (!address.addressStreet) invalidFields.push("logradouro");
    if (!address.addressNumber) invalidFields.push("número do endereço");
    if (!address.addressDistrict) invalidFields.push("bairro");
    if (!address.addressCity) invalidFields.push("cidade");
    if (!/^[A-Z]{2}$/.test(address.addressState)) invalidFields.push("UF com 2 letras");
    if (!String(ownerName || "").trim()) invalidFields.push("nome do responsável");
    if (!String(ownerPhone || "").trim()) invalidFields.push("telefone do responsável");
    if (!taxIdHasValidLength(ownerTaxId)) invalidFields.push("CPF/CNPJ do responsável");
    if (!String(ownerEmail || "").trim()) invalidFields.push("e-mail do responsável");
    if (String(ownerPassword || "").length < 8) invalidFields.push("senha com ao menos 8 caracteres");
    if (marketplaceFeePercent === null) invalidFields.push("comissão entre 0% e 100%");
    if (invalidFields.length) {
      await tx.rollback();
      return res.status(400).json({ error: `Preencha ou corrija: ${invalidFields.join(", ")}` });
    }

    const existingTenant = await Tenant.findOne({ where: { slug }, transaction: tx, lock: tx.LOCK.UPDATE });
    if (existingTenant) {
      await tx.rollback();
      return res.status(409).json({ error: "Slug de tenant ja em uso" });
    }

    const normalizedOwnerEmail = String(ownerEmail).toLowerCase();

    const tenant = await Tenant.create(
      { name: tenantName, slug, status: "ATIVO", taxId: tenantTaxId, marketplaceFeePercent, ...address },
      { transaction: tx }
    );

    const passwordHash = await bcrypt.hash(ownerPassword, 10);
    const owner = await User.create(
      {
        tenantId: tenant.id,
        name: ownerName,
        email: normalizedOwnerEmail,
        phone: ownerPhone,
        taxId: ownerTaxId,
        role: "owner",
        passwordHash,
        ...address,
      },
      { transaction: tx }
    );

    await tx.commit();

    return res.status(201).json({
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, marketplaceFeePercent: Number(tenant.marketplaceFeePercent) },
      user: {
        id: owner.id,
        tenantId: owner.tenantId,
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
        role: owner.role,
      },
    });
  } catch (error) {
    if (!tx.finished) await tx.rollback();
    return res.status(500).json({ error: "Erro ao registrar tenant", details: error.message });
  }
});

// --- Autenticacao dos usuarios e gestores dos clientes -------------------
// Cadastra um comprador comum dentro de um tenant ativo.
app.post("/api/auth/register", async (req, res) => {
  try {
    const { tenantSlug, name, email, phone, password } = req.body;
    const taxId = normalizeTaxId(req.body.taxId);
    const address = normalizeAddress(req.body);
    if (!tenantSlug || !name || !email || !phone || !password || !taxIdHasValidLength(taxId) || !addressIsComplete(address)) {
      return res.status(400).json({ error: "Campos obrigatorios ausentes" });
    }

    const slug = normalizeTenantSlug(tenantSlug);
    const tenant = await Tenant.findOne({ where: { slug, status: "ATIVO" } });
    if (!tenant) return res.status(404).json({ error: "Tenant nao encontrado" });

    const normalizedEmail = String(email).toLowerCase();
    const existing = await User.findOne({ where: { tenantId: tenant.id, email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({ error: "Email ja cadastrado neste tenant" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      tenantId: tenant.id,
      name,
      email: normalizedEmail,
      phone,
      taxId,
      role: "user",
      passwordHash,
      ...address,
    });

    return res.status(201).json({
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      token: signToken(user),
      user: {
        id: user.id,
        tenantId: user.tenantId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao registrar", details: error.message });
  }
});

// Autentica comprador, admin ou owner usando slug, email e senha.
app.post("/api/auth/login", async (req, res) => {
  try {
    const { tenantSlug, email, password } = req.body;
    if (!tenantSlug || !email || !password) {
      return res.status(400).json({ error: "Campos obrigatorios ausentes" });
    }

    const slug = normalizeTenantSlug(tenantSlug);
    const tenant = await Tenant.findOne({ where: { slug, status: "ATIVO" } });
    if (!tenant) return res.status(404).json({ error: "Tenant nao encontrado" });

    const user = await User.findOne({ where: { tenantId: tenant.id, email: String(email).toLowerCase() } });
    if (!user) return res.status(401).json({ error: "Credenciais invalidas" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Credenciais invalidas" });

    return res.json({
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      token: signToken(user),
      user: {
        id: user.id,
        tenantId: user.tenantId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro no login", details: error.message });
  }
});

function serializeAccount(user) {
  return {
    id: user.id, tenantId: user.tenantId, name: user.name, email: user.email,
    phone: user.phone, taxId: formatTaxId(user.taxId), role: user.role,
    addressPostalCode: user.addressPostalCode || "", addressStreet: user.addressStreet || "",
    addressNumber: user.addressNumber || "", addressComplement: user.addressComplement || "",
    addressDistrict: user.addressDistrict || "", addressCity: user.addressCity || "",
    addressState: user.addressState || "",
  };
}

app.get("/api/account", authMiddleware, async (req, res) => {
  const user = await User.findOne({ where: { id: req.user.id, tenantId: req.tenantId } });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
  return res.json(serializeAccount(user));
});

app.patch("/api/account", authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ where: { id: req.user.id, tenantId: req.tenantId } });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").trim();
    const taxId = normalizeTaxId(req.body.taxId);
    const address = normalizeAddress(req.body);
    if (!name || !email || !phone || !isValidTaxId(taxId) || !addressIsComplete(address)) {
      return res.status(400).json({ error: "Preencha nome, e-mail, telefone, CPF/CNPJ válido e o endereço completo" });
    }
    const duplicate = await User.findOne({ where: { tenantId: req.tenantId, email, id: { [Op.ne]: user.id } } });
    if (duplicate) return res.status(409).json({ error: "Este e-mail já está sendo utilizado" });
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    if (currentPassword || newPassword) {
      if (!currentPassword || newPassword.length < 8) {
        return res.status(400).json({ error: "Informe a senha atual e uma nova senha com pelo menos 8 caracteres" });
      }
      if (!await bcrypt.compare(currentPassword, user.passwordHash)) {
        return res.status(401).json({ error: "Senha atual incorreta" });
      }
      user.passwordHash = await bcrypt.hash(newPassword, 10);
    }
    Object.assign(user, { name, email, phone, taxId, ...address });
    await user.save();
    return res.json({ message: "Cadastro atualizado com sucesso", user: serializeAccount(user), token: signToken(user) });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao atualizar cadastro" });
  }
});

// --- Configuracao de recebimento por cliente -----------------------------
// Informa ao frontend o provider ativo e o estado da conta conectada.
app.get("/api/payments/config", authMiddleware, async (req, res) => {
  const [tenantProvider, mercadoPagoProvider, tenant] = await Promise.all([
    resolveTenantStripeProvider(req.tenantId),
    TenantPaymentProvider.findOne({ where: { tenantId: req.tenantId, provider: "mercadopago", status: "ATIVO" }, attributes: ["accountId"] }),
    Tenant.findByPk(req.tenantId, { attributes: ["marketplaceFeePercent"] }),
  ]);
  return res.json({
    provider: PAYMENT_PROVIDER,
    supportedMethods: ["pix"],
    mercadoPagoEnabled: mercadoPagoConfiguration().oauthConfigured,
    mercadoPagoSetupMissing: mercadoPagoConfiguration().oauthMissing,
    mercadoPagoConnected: Boolean(mercadoPagoProvider),
    mercadoPagoAccountId: mercadoPagoProvider ? mercadoPagoProvider.accountId : null,
    marketplaceFeePercent: Number(tenant?.marketplaceFeePercent ?? MARKETPLACE_FEE_PERCENT),
    stripePublishableKey: STRIPE_PUBLISHABLE_KEY || null,
    stripeEnabled: PAYMENT_PROVIDER === "stripe" && Boolean(stripe) && Boolean(STRIPE_PUBLISHABLE_KEY),
    stripeConnected: Boolean(tenantProvider),
    stripeAccountId: tenantProvider ? tenantProvider.accountId : null,
    pagbankEnabled: PAYMENT_PROVIDER === "pagbank" && Boolean(PAGBANK_ACCESS_TOKEN),
    pagbankPublicKey: PAGBANK_PUBLIC_KEY || null,
  });
});

function maskIdentifier(value) {
  const text = String(value || "");
  if (!text) return null;
  if (text.length <= 6) return "***";
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function mercadoPagoConfiguration() {
  const oauthMissing = [];
  if (!MERCADOPAGO_APP_ID) oauthMissing.push("App ID");
  if (!MERCADOPAGO_CLIENT_SECRET) oauthMissing.push("Client Secret");
  if (!MERCADOPAGO_REDIRECT_URI) oauthMissing.push("URL de retorno OAuth");
  if (!oauthCipher.enabled) oauthMissing.push("chave de criptografia");
  return {
    encryptionConfigured: oauthCipher.enabled,
    applicationConfigured: Boolean(MERCADOPAGO_APP_ID && MERCADOPAGO_CLIENT_SECRET),
    platformTokenConfigured: Boolean(MERCADOPAGO_ACCESS_TOKEN),
    publicKeyConfigured: Boolean(MERCADOPAGO_PUBLIC_KEY),
    oauthConfigured: Boolean(MERCADOPAGO_APP_ID && MERCADOPAGO_CLIENT_SECRET && MERCADOPAGO_REDIRECT_URI && oauthCipher.enabled),
    oauthMissing,
    webhookConfigured: Boolean(MERCADOPAGO_WEBHOOK_SECRET && MERCADOPAGO_NOTIFICATION_URL),
    appId: maskIdentifier(MERCADOPAGO_APP_ID),
    redirectUri: MERCADOPAGO_REDIRECT_URI,
    notificationUrl: MERCADOPAGO_NOTIFICATION_URL,
    provider: PAYMENT_PROVIDER,
    marketplaceFeePercent: MARKETPLACE_FEE_PERCENT,
  };
}

async function startMercadoPagoOAuth(tenantId, userId, res) {
  if (!mercadoPagoConfiguration().oauthConfigured) return res.status(400).json({ error: "Configure App ID, Client Secret, URL de retorno e chave de criptografia no servidor" });
  const state = crypto.randomBytes(32).toString("base64url");
  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  await MercadoPagoOAuthState.create({
    tenantId, userId,
    stateHash: crypto.createHash("sha256").update(state).digest("hex"),
    codeVerifier,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  const params = new URLSearchParams({
    client_id: MERCADOPAGO_APP_ID,
    response_type: "code",
    platform_id: "mp",
    state,
    redirect_uri: MERCADOPAGO_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return res.json({ url: `https://auth.mercadopago.com.br/authorization?${params.toString()}` });
}

// Painel da conta marketplace. Nao inicia OAuth de vendedores e nunca retorna segredos.
app.get("/api/platform/payments/mercadopago/status", platformAdminMiddleware, async (_req, res) => {
  const [connectedSellers, lastWebhook, totals, marketplaceAccount] = await Promise.all([
    TenantPaymentProvider.count({ where: { provider: "mercadopago", status: "ATIVO" } }),
    MercadoPagoWebhookEvent.findOne({ order: [["createdAt", "DESC"]], attributes: ["status", "action", "processedAt", "createdAt"] }),
    Payment.findAll({ where: { provider: "mercadopago" }, attributes: ["amount", "marketplaceFeeAmount", "mercadoPagoFeeAmount", "sellerNetAmount", "financialStatus"] }),
    PlatformPaymentConfiguration.findOne({ where: { provider: "mercadopago" }, attributes: ["accountId", "country", "site", "testAccount", "verifiedAt"] }),
  ]);
  const approvedTotals = totals.filter((row) => row.financialStatus === "approved");
  const sumApproved = (field) => Number(approvedTotals.reduce((total, row) => total + Number(row[field] || 0), 0).toFixed(2));
  res.set("Cache-Control", "no-store");
  return res.json({
    ...mercadoPagoConfiguration(),
    connectedSellers,
    marketplaceAccount: marketplaceAccount ? { ...marketplaceAccount.toJSON(), accountId: maskIdentifier(marketplaceAccount.accountId) } : null,
    lastWebhook,
    reconciliation: {
      payments: approvedTotals.length,
      grossAmount: sumApproved("amount"),
      marketplaceFeeAmount: sumApproved("marketplaceFeeAmount"),
      mercadoPagoFeeAmount: sumApproved("mercadoPagoFeeAmount"),
      sellerNetAmount: sumApproved("sellerNetAmount"),
      pending: totals.filter((row) => !["approved", "rejected", "cancelled", "refunded", "charged_back"].includes(row.financialStatus)).length,
    },
  });
});

app.post("/api/platform/payments/mercadopago/verify", platformAdminMiddleware, async (_req, res) => {
  if (!MERCADOPAGO_ACCESS_TOKEN) return res.status(400).json({ error: "Access Token da conta marketplace nao configurado" });
  try {
    const account = await mercadoPagoRequest("/users/me", MERCADOPAGO_ACCESS_TOKEN);
    await PlatformPaymentConfiguration.upsert({ provider: "mercadopago", accountId: String(account.id),
      country: account.country_id || null, site: account.site_id || null,
      testAccount: Array.isArray(account.tags) && account.tags.includes("test_user"), verifiedAt: new Date() });
    return res.json({ verified: Boolean(account.id), accountId: maskIdentifier(account.id), country: account.country_id || null,
      site: account.site_id || null, testAccount: Array.isArray(account.tags) && account.tags.includes("test_user") });
  } catch (_error) {
    return res.status(502).json({ error: "Nao foi possivel validar a conta marketplace no Mercado Pago" });
  }
});

app.get("/api/platform/payments/mercadopago/commissions", platformAdminMiddleware, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = await Payment.findAll({
    where: { provider: "mercadopago" }, include: [{ model: Tenant, attributes: ["id", "name"] }],
    attributes: ["id", "externalId", "amount", "status", "marketplaceFeePercent", "marketplaceFeeAmount", "mercadoPagoFeeAmount", "sellerNetAmount", "financialStatus", "reconciledAt", "createdAt"],
    order: [["id", "DESC"]], limit,
  });
  res.set("Cache-Control", "no-store");
  return res.json(rows);
});

// NOC financeiro do organizador, sempre limitado ao tenant presente no JWT.
app.get("/api/payments/mercadopago/financial-dashboard", authMiddleware, adminMiddleware, async (req, res) => {
  const payments = await Payment.findAll({
    where: { tenantId: req.tenantId, provider: "mercadopago" },
    include: [{ model: Raffle, attributes: ["id", "title"] }],
    attributes: ["id", "externalId", "amount", "status", "marketplaceFeeAmount", "mercadoPagoFeeAmount", "sellerNetAmount", "financialStatus", "reconciledAt", "createdAt"],
    order: [["id", "DESC"]], limit: 100,
  });
  const provider = await TenantPaymentProvider.findOne({
    where: { tenantId: req.tenantId, provider: "mercadopago" },
    attributes: ["accountId", "status", "livemode"],
  });
  const approvedPayments = payments.filter((row) => row.financialStatus === "approved");
  const sumApproved = (field) => Number(approvedPayments.reduce((total, row) => total + Number(row[field] || 0), 0).toFixed(2));
  const finalStatuses = ["approved", "rejected", "cancelled", "refunded", "charged_back"];
  res.set("Cache-Control", "no-store");
  return res.json({
    account: provider ? { accountId: maskIdentifier(provider.accountId), status: provider.status, livemode: provider.livemode } : null,
    summary: {
      payments: approvedPayments.length, grossAmount: sumApproved("amount"), platformFeeAmount: sumApproved("marketplaceFeeAmount"),
      mercadoPagoFeeAmount: sumApproved("mercadoPagoFeeAmount"), sellerNetAmount: sumApproved("sellerNetAmount"),
      pending: payments.filter((row) => !finalStatuses.includes(row.financialStatus)).length,
      approved: approvedPayments.length,
    },
    lastReconciledAt: payments.find((row) => row.reconciledAt)?.reconciledAt || null,
    payments,
  });
});

app.get("/api/payments/mercadopago/connect/start", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findOne({ where: { id: req.tenantId, status: "ATIVO" } });
    const manager = await User.findOne({ where: { id: req.user.id, tenantId: req.tenantId, role: ["owner", "admin"] } });
    if (!tenant || !manager) return res.status(403).json({ error: "Cliente ou gestor sem acesso" });
    const receivingProfile = await TenantPaymentProvider.findOne({
      where: { tenantId: req.tenantId, provider: "mercadopago" },
      attributes: ["accountHolderName", "accountHolderType", "accountHolderTaxId", "accountEmail", "accountPhone", "kycConfirmed"],
    });
    if (!receivingProfile?.accountHolderName || !receivingProfile.accountHolderTaxId
      || !receivingProfile.accountEmail || !receivingProfile.accountPhone
      || !["PF", "PJ"].includes(receivingProfile.accountHolderType) || !receivingProfile.kycConfirmed) {
      return res.status(400).json({ error: "Salve as informacoes de recebimento antes de autorizar a conta" });
    }
    return startMercadoPagoOAuth(req.tenantId, req.user.id, res);
  } catch (_) { return res.status(500).json({ error: "Nao foi possivel iniciar a conexao" }); }
});

// Dados cadastrais do recebedor. Credenciais e senhas nunca passam por esta API.
app.get("/api/payments/mercadopago/receiving-profile", authMiddleware, adminMiddleware, async (req, res) => {
  const provider = await TenantPaymentProvider.findOne({
    where: { tenantId: req.tenantId, provider: "mercadopago" },
    attributes: ["accountHolderName", "accountHolderType", "accountHolderTaxId", "accountEmail", "accountPhone", "kycConfirmed", "accountId", "status", "expiresAt", "livemode", "updatedAt"],
  });
  res.set("Cache-Control", "no-store");
  return res.json(provider || {
    accountHolderName: "", accountHolderType: "", accountHolderTaxId: "", accountEmail: "", accountPhone: "",
    kycConfirmed: false, accountId: null, status: "INATIVO", expiresAt: null, livemode: false, updatedAt: null,
  });
});

app.put("/api/payments/mercadopago/receiving-profile", authMiddleware, adminMiddleware, async (req, res) => {
  const accountHolderName = String(req.body.accountHolderName || "").trim();
  const accountHolderType = String(req.body.accountHolderType || "").toUpperCase();
  const accountHolderTaxId = String(req.body.accountHolderTaxId || "").replace(/\D/g, "");
  const accountEmail = String(req.body.accountEmail || "").trim().toLowerCase();
  const accountPhone = String(req.body.accountPhone || "").replace(/\D/g, "");
  const kycConfirmed = req.body.kycConfirmed === true;
  if (accountHolderName.length < 3 || !["PF", "PJ"].includes(accountHolderType)
    || (accountHolderType === "PF" ? accountHolderTaxId.length !== 11 : accountHolderTaxId.length !== 14)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountEmail)
    || accountPhone.length < 10 || accountPhone.length > 13 || !kycConfirmed) {
    return res.status(400).json({ error: "Informe dados validos e confirme que a conta Mercado Pago esta identificada" });
  }
  const [provider] = await TenantPaymentProvider.findOrCreate({
    where: { tenantId: req.tenantId, provider: "mercadopago" },
    defaults: { accountId: `pending-${req.tenantId}`, status: "INATIVO" },
  });
  await provider.update({ accountHolderName, accountHolderType, accountHolderTaxId, accountEmail, accountPhone, kycConfirmed });
  return res.json({ accountHolderName, accountHolderType, accountHolderTaxId, accountEmail, accountPhone, kycConfirmed,
    accountId: provider.status === "ATIVO" ? provider.accountId : null, status: provider.status });
});

// Troca o codigo OAuth e persiste a conta recebedora vinculada ao tenant.
app.get("/api/payments/mercadopago/connect/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect("/?mercadopago=error&reason=authorization_denied");
  if (!code || !state) return res.redirect("/?mercadopago=error&reason=missing_parameters");
  let oauthState;
  try {
    const stateHash = crypto.createHash("sha256").update(String(state)).digest("hex");
    oauthState = await sequelize.transaction(async (transaction) => {
      const row = await MercadoPagoOAuthState.findOne({ where: { stateHash }, transaction, lock: transaction.LOCK.UPDATE });
      if (!row || row.usedAt || new Date(row.expiresAt).getTime() < Date.now()) throw new Error("State invalido, expirado ou ja utilizado");
      row.usedAt = new Date();
      await row.save({ transaction });
      return row;
    });
  } catch (_error) {
    return res.redirect("/?mercadopago=error&reason=invalid_state");
  }
  try {
    const tenant = await Tenant.findOne({ where: { id: oauthState.tenantId, status: "ATIVO" } });
    if (!tenant) return res.status(403).send("Cliente sem acesso");
    const token = await mercadoPagoOAuthToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: MERCADOPAGO_REDIRECT_URI,
      code_verifier: oauthState.codeVerifier,
    });
    const authorizedAccount = await mercadoPagoRequest("/users/me", token.access_token);
    if (!authorizedAccount.id || String(authorizedAccount.id) !== String(token.user_id)
      || (authorizedAccount.country_id && authorizedAccount.country_id !== "BR")) {
      throw new Error("Conta Mercado Pago autorizada nao corresponde a uma conta brasileira valida");
    }
    const [provider] = await TenantPaymentProvider.findOrCreate({
      where: { tenantId: oauthState.tenantId, provider: "mercadopago" },
      defaults: { accountId: String(token.user_id), status: "ATIVO" },
    });
    provider.accountId = String(token.user_id);
    provider.accessToken = token.access_token;
    provider.refreshToken = token.refresh_token || null;
    provider.scope = token.scope || null;
    provider.livemode = !(Array.isArray(authorizedAccount.tags) && authorizedAccount.tags.includes("test_user"));
    provider.expiresAt = new Date(Date.now() + Number(token.expires_in || 15552000) * 1000);
    provider.status = "ATIVO";
    await provider.save();
    return res.redirect("/?mercadopago=connected");
  } catch (oauthError) {
    console.error("Mercado Pago OAuth callback failed", {
      tenantId: oauthState.tenantId,
      message: String(oauthError?.message || "erro desconhecido").slice(0, 240),
    });
    return res.redirect("/?mercadopago=error&reason=account_validation_failed");
  }
});

// Inicia o OAuth para o cliente autorizar sua propria conta Stripe.
app.get("/api/payments/stripe/connect/start", authMiddleware, adminMiddleware, async (req, res) => {
  if (PAYMENT_PROVIDER !== "stripe" || !stripe) {
    return res.status(400).json({ error: "Provider stripe nao habilitado" });
  }
  if (!STRIPE_CONNECT_CLIENT_ID || !STRIPE_CONNECT_REDIRECT_URI) {
    return res.status(400).json({ error: "Stripe Connect nao configurado no servidor" });
  }

  const state = makeConnectStateToken(req.tenantId);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: STRIPE_CONNECT_CLIENT_ID,
    scope: "read_write",
    state,
    redirect_uri: STRIPE_CONNECT_REDIRECT_URI,
  });

  return res.json({ url: `https://connect.stripe.com/oauth/authorize?${params.toString()}` });
});

// Recebe o retorno do OAuth e vincula a conta Stripe ao tenant correto.
app.get("/api/payments/stripe/connect/callback", async (req, res) => {
  if (PAYMENT_PROVIDER !== "stripe" || !stripe) {
    return res.status(400).send("Provider stripe nao habilitado");
  }

  const { code, state, error: stripeError, error_description: stripeErrorDesc } = req.query;
  if (stripeError) {
    return res.status(400).send(`Erro Stripe Connect: ${stripeErrorDesc || stripeError}`);
  }
  if (!code || !state) {
    return res.status(400).send("Parametros obrigatorios ausentes");
  }

  let tenantId;
  try {
    tenantId = parseConnectStateToken(state).tenantId;
  } catch (error) {
    return res.status(400).send(`State invalido: ${error.message}`);
  }

  try {
    const tokenResult = await stripe.oauth.token({ grant_type: "authorization_code", code });

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) return res.status(404).send("Tenant nao encontrado");

    await TenantPaymentProvider.upsert({
      tenantId,
      provider: "stripe",
      accountId: tokenResult.stripe_user_id,
      accessToken: tokenResult.access_token || null,
      refreshToken: tokenResult.refresh_token || null,
      scope: tokenResult.scope || null,
      livemode: Boolean(tokenResult.livemode),
      status: "ATIVO",
    });

    return res.status(200).send("Stripe Connect configurado com sucesso para o tenant.");
  } catch (error) {
    return res.status(500).send(`Erro ao finalizar Stripe Connect: ${error.message}`);
  }
});

// --- Midias e produtos ----------------------------------------------------
// Armazena ate dez arquivos e devolve URLs que podem compor um produto.
app.post("/api/uploads", authMiddleware, upload.array("files", 10), async (req, res) => {
  const files = req.files || [];
  const media = files.map((f) => ({
    type: f.mimetype.startsWith("video/") ? "video" : "image",
    url: `/uploads/${f.filename}`,
    originalName: f.originalname,
  }));
  return res.status(201).json({ media });
});

// Cria um produto no tenant autenticado; compradores nao possuem acesso.
app.post("/api/products", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, description, media } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: "Titulo e descricao sao obrigatorios" });
    }

    const product = await Product.create({
      tenantId: req.tenantId,
      title,
      description,
      media: Array.isArray(media) ? media : [],
    });
    return res.status(201).json(product);
  } catch (error) {
    return res.status(500).json({ error: "Erro ao criar produto", details: error.message });
  }
});

// Lista somente os produtos pertencentes ao tenant da sessao.
app.get("/api/products", authMiddleware, async (req, res) => {
  const products = await Product.findAll({ where: { tenantId: req.tenantId }, order: [["id", "DESC"]] });
  return res.json(products);
});

// --- Rifas ---------------------------------------------------------------
// Cria uma das tres modalidades e define automaticamente sua faixa numerica.
app.post("/api/raffles", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { productId, type, title, description, pricePerNumber } = req.body;
    const winnerCount = Number(req.body.winnerCount ?? 3);
    const discountPercent = Number(req.body.discountPercent ?? 10);
    if (!productId || !type || !title || !description || !pricePerNumber) {
      return res.status(400).json({ error: "Campos obrigatorios ausentes" });
    }
    if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 5) {
      return res.status(400).json({ error: "A quantidade de ganhadores deve estar entre 1 e 5" });
    }
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      return res.status(400).json({ error: "O desconto deve estar entre 0% e 100%" });
    }

    const product = await Product.findOne({ where: { id: productId, tenantId: req.tenantId } });
    if (!product) return res.status(404).json({ error: "Produto nao encontrado" });

    let totalNumbers;
    try {
      totalNumbers = rangeByType(type, req.body.totalNumbers);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (winnerCount > totalNumbers) {
      return res.status(400).json({ error: "A quantidade de ganhadores nao pode exceder a quantidade de numeros" });
    }

    const raffle = await Raffle.create({
      tenantId: req.tenantId,
      productId,
      type,
      title,
      description,
      pricePerNumber,
      discountPercent: Number(discountPercent.toFixed(2)),
      totalNumbers,
      winnerCount,
      drawMode: type === "BICHO_25" ? "BICHO_RJ" : "ALEATORIO",
    });

    return res.status(201).json(raffle);
  } catch (error) {
    return res.status(500).json({ error: "Erro ao criar rifa", details: error.message });
  }
});

// Lista rifas do tenant e seus numeros indisponiveis.
app.get("/api/raffles", authMiddleware, async (req, res) => {
  await maybeAutoDrawForAllOpenNumericRaffles(req.tenantId);

  const raffles = await Raffle.findAll({
    where: { tenantId: req.tenantId },
    include: [Product],
    order: [["id", "DESC"]],
  });

  const isManager = ["admin", "owner"].includes(req.user.role);
  const visibleRaffles = [];
  for (const raffle of raffles) {
    if (isManager || raffle.status !== "ENCERRADA" || await userIsRaffleWinner(raffle, req.user.id)) {
      visibleRaffles.push(raffle);
    }
  }

  const soldMap = new Map();
  for (const raffle of visibleRaffles) {
    soldMap.set(raffle.id, await listUnavailableNumbersByRaffleId(req.tenantId, raffle.id));
  }

  return res.json(visibleRaffles.map((r) => serializeRaffle(r, (soldMap.get(r.id) || []).sort((a, b) => a - b))));
});

// Retorna o detalhe de uma rifa, sempre respeitando o tenant autenticado.
app.get("/api/raffles/:id", authMiddleware, async (req, res) => {
  await maybeAutoDraw(req.tenantId, req.params.id);

  const raffle = await Raffle.findOne({ where: { id: req.params.id, tenantId: req.tenantId }, include: [Product] });
  if (!raffle) return res.status(404).json({ error: "Rifa nao encontrada" });
  if (
    raffle.status === "ENCERRADA" &&
    !["admin", "owner"].includes(req.user.role) &&
    !(await userIsRaffleWinner(raffle, req.user.id))
  ) {
    return res.status(404).json({ error: "Rifa nao encontrada" });
  }

  const soldNumbers = await listUnavailableNumbersByRaffleId(req.tenantId, raffle.id);
  return res.json(serializeRaffle(raffle, soldNumbers));
});

// Solicita a verificacao do fechamento automatico de uma rifa numerica.
app.post("/api/raffles/:id/draw/auto", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!raffle) return res.status(404).json({ error: "Rifa nao encontrada" });
    if (!["NUMERICA_100", "NUMERICA_1000"].includes(raffle.type)) {
      return res.status(400).json({ error: "Endpoint valido apenas para rifas numericas" });
    }

    const updated = await maybeAutoDraw(req.tenantId, raffle.id);
    const refreshed = await Raffle.findOne({ where: { id: updated.id, tenantId: req.tenantId }, include: [Product] });
    const soldNumbers = await listUnavailableNumbersByRaffleId(req.tenantId, refreshed.id);
    return res.json(serializeRaffle(refreshed, soldNumbers));
  } catch (error) {
    return res.status(500).json({ error: "Erro ao executar sorteio automatico", details: error.message });
  }
});

// Permite ao organizador encerrar antes de vender todas as cotas. Somente
// numeros com pagamento confirmado participam do sorteio aleatorio.
app.post("/api/raffles/:id/close", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const password = String(req.body.password || "");
    if (!password) return res.status(400).json({ error: "Informe a senha do organizador para encerrar a rifa" });
    const organizer = await User.findOne({
      where: { id: req.user.id, tenantId: req.tenantId },
      attributes: ["id", "passwordHash"],
    });
    if (!organizer || !(await bcrypt.compare(password, organizer.passwordHash))) {
      return res.status(403).json({ error: "Senha do organizador incorreta" });
    }

    const raffle = await sequelize.transaction(async (transaction) => {
      const current = await Raffle.findOne({
        where: { id: req.params.id, tenantId: req.tenantId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const fail = (status, message) => { throw Object.assign(new Error(message), { httpStatus: status }); };
      if (!current) fail(404, "Rifa nao encontrada");
      if (current.status !== "ABERTA") fail(409, "A rifa ja esta encerrada");

      const pendingPayments = await Payment.findAll({
        where: { tenantId: req.tenantId, raffleId: current.id, status: "pendente" },
        attributes: ["id"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (pendingPayments.length) {
        fail(409, "Aguarde a confirmacao ou expiracao dos pagamentos PIX pendentes antes de encerrar a rifa");
      }

      const paidTickets = await Ticket.findAll({
        where: { tenantId: req.tenantId, raffleId: current.id, status: "confirmado" },
        include: [{ model: Payment, where: { tenantId: req.tenantId, status: "pago" }, attributes: ["id"] }],
        order: [["number", "ASC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (paidTickets.length < current.winnerCount) {
        fail(400, `Sao necessarios pelo menos ${current.winnerCount} numeros pagos para sortear os ganhadores`);
      }

      current.status = "ENCERRADA";
      current.drawAt = new Date();
      current.drawMode = "ALEATORIO";
      current.drawSource = "Encerramento antecipado: sorteio aleatorio entre numeros pagos";
      current.winners = await drawWinnersFromPaidTickets(
        paidTickets,
        req.tenantId,
        current.winnerCount,
        transaction
      );
      await current.save({ transaction });
      return current;
    });

    const refreshed = await Raffle.findOne({
      where: { id: raffle.id, tenantId: req.tenantId },
      include: [Product],
    });
    const soldNumbers = await listUnavailableNumbersByRaffleId(req.tenantId, raffle.id);
    return res.json(serializeRaffle(refreshed, soldNumbers));
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      error: error.httpStatus ? error.message : "Erro ao encerrar a rifa",
      ...(error.httpStatus ? {} : { details: error.message }),
    });
  }
});

// Aplica respostas e webhooks na mesma transacao. Estados finais nao retrocedem.
async function applyMercadoPagoPayment(paymentId, remote) {
  let updated;
  await sequelize.transaction(async (transaction) => {
    const payment = await Payment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
    validateRemote(payment, remote);
    const nextStatus = remoteStatus(remote.status);
    const financials = remoteFinancials(remote);
    const data = remote.point_of_interaction?.transaction_data || {};
    if (payment.status === "falhou" && nextStatus === "pago") {
      throw new Error("Aprovacao posterior a liberacao exige conciliacao manual");
    }
    payment.externalId = String(remote.id);
    const terminalAfterApproval = ["refunded", "charged_back"];
    const approvedCannotRegress = payment.status === "pago"
      && !terminalAfterApproval.includes(String(remote.status || "").toLowerCase());
    if (!approvedCannotRegress) payment.financialStatus = remote.status || payment.financialStatus;
    payment.mercadoPagoFeeAmount = financials.mercadoPagoFee;
    payment.sellerNetAmount = financials.sellerNet;
    payment.payload = {
      ...payment.payload,
      mercadoPagoStatus: remote.status,
      statusDetail: remote.status_detail,
      qrCodeText: data.qr_code || payment.payload?.qrCodeText || null,
      qrCodeImage: data.qr_code_base64 ? `data:image/png;base64,${data.qr_code_base64}` : payment.payload?.qrCodeImage || null,
      ticketUrl: data.ticket_url || payment.payload?.ticketUrl || null,
    };
    if (payment.status === "pendente") {
      payment.status = nextStatus;
      if (nextStatus === "pago") {
        await Ticket.update({ status: "confirmado" }, { where: { paymentId }, transaction });
      } else if (nextStatus === "falhou") {
        await Ticket.destroy({ where: { paymentId }, transaction });
      }
    }
    await payment.save({ transaction });
    updated = payment;
  });
  if (updated.status === "pago") await maybeAutoDraw(updated.tenantId, updated.raffleId);
  return updated;
}

async function rejectMercadoPagoPayment(paymentId, gatewayCode) {
  let updated;
  await sequelize.transaction(async (transaction) => {
    const payment = await Payment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (payment?.status === "pendente") {
      payment.status = "falhou";
      payment.financialStatus = "rejected";
      payment.payload = {
        ...payment.payload,
        gatewayErrorCode: gatewayCode,
        gatewayErrorMessage: gatewayCode === "2067"
          ? "CPF/CNPJ do comprador invalido. Atualize o cadastro e tente novamente."
          : "O Mercado Pago rejeitou os dados da cobranca.",
      };
      await Ticket.destroy({ where: { paymentId }, transaction });
      await payment.save({ transaction });
    }
    updated = payment;
  });
  return updated;
}

// Lease persistida impede que checkout e reconciliador criem a mesma cobranca simultaneamente.
async function processDurablePix(paymentId) {
  const lease = new Date(Math.floor(Date.now() / 1000) * 1000);
  const [claimed] = await Payment.update({ processingAt: lease, reconciledAt: lease }, {
    where: { id: paymentId, status: "pendente", [Op.or]: [
      { processingAt: null }, { processingAt: { [Op.lt]: new Date(Date.now() - 120000) } },
    ] },
  });
  if (!claimed) return Payment.findByPk(paymentId);
  try {
    const payment = await Payment.findByPk(paymentId);
    const provider = await resolveTenantMercadoPagoProvider(payment.tenantId, payment.providerAccountId);
    if (!provider) throw new Error("Conta vendedora indisponivel");
    let remote;
    if (payment.externalId) {
      remote = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(payment.externalId)}`, provider.accessToken);
    } else if (new Date(payment.expiresAt).getTime() > Date.now() && payment.payload?.gatewayRequest) {
      // O corpo e a chave foram gravados antes do POST. Retentativas sao identicas.
      remote = await mercadoPagoRequest("/v1/payments", provider.accessToken, {
        method: "POST", idempotencyKey: payment.idempotencyKey, body: payment.payload.gatewayRequest,
      });
    } else {
      // Nunca recria um PIX vencido, nem libera uma reserva com resultado incerto.
      const search = await mercadoPagoRequest(`/v1/payments/search?external_reference=${encodeURIComponent(payment.payload?.externalReference || "")}`, provider.accessToken);
      if (!Array.isArray(search.results) || search.results.length !== 1) throw new Error("Cobranca sem resultado conclusivo; requer verificacao");
      remote = search.results[0];
    }
    validateRemote(payment, remote);
    if (remoteStatus(remote.status) === "pendente" && payment.expiresAt && new Date(payment.expiresAt).getTime() <= Date.now()) {
      await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(remote.id)}`, provider.accessToken, {
        method: "PUT", body: { status: "cancelled" },
      });
      remote = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(remote.id)}`, provider.accessToken);
    }
    return await applyMercadoPagoPayment(paymentId, remote);
  } catch (error) {
    if (error.gatewayCode === "2067") {
      console.warn(`PIX ${paymentId}: rejeitado pelo Mercado Pago (codigo 2067); reserva liberada`);
      return rejectMercadoPagoPayment(paymentId, error.gatewayCode);
    }
    // Timeout, HTTP 5xx ou respostas divergentes preservam reserva e chave.
    console.warn(`PIX ${paymentId}: reconciliacao pendente; reserva preservada`);
    return Payment.findByPk(paymentId);
  } finally {
    await Payment.update({ processingAt: null }, { where: { id: paymentId, processingAt: lease } });
  }
}

let pixReconciliationRunning = false;
async function reconcilePixPayments() {
  if (pixReconciliationRunning) return;
  pixReconciliationRunning = true;
  try {
    const pending = await Payment.findAll({
      where: { provider: "mercadopago", status: "pendente" },
      attributes: ["id"], order: [["reconciledAt", "ASC"], ["id", "ASC"]], limit: 50,
    });
    for (const payment of pending) await processDurablePix(payment.id);
  } catch (_error) {
    console.warn("Falha na rotina de reconciliacao PIX; nova tentativa no proximo ciclo");
  } finally {
    pixReconciliationRunning = false;
  }
}

async function checkoutMercadoPago(req, res) {
  let payment;
  try {
    const { raffleId, numbers, method } = req.body;
    const requestKey = String(req.headers["x-idempotency-key"] || "");
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestKey)) {
      return res.status(400).json({ error: "Envie X-Idempotency-Key (16 a 80 caracteres) e reutilize-o nas retentativas" });
    }
    if (!Number.isInteger(Number(raffleId)) || !Array.isArray(numbers) || !numbers.length || method !== "pix") {
      return res.status(400).json({ error: "Dados invalidos; somente PIX esta disponivel" });
    }
    const dedup = [...new Set(numbers.map(Number))].sort((a, b) => a - b);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ raffleId: Number(raffleId), numbers: dedup, method })).digest("hex");
    const requestWhere = { tenantId: req.tenantId, userId: req.user.id, requestKey };
    payment = await Payment.findOne({ where: requestWhere });
    if (!payment) {
      const buyer = await User.findOne({ where: { id: req.user.id, tenantId: req.tenantId } });
      if (!buyer) return res.status(403).json({ error: "Comprador nao encontrado" });
      const provider = await resolveTenantMercadoPagoProvider(req.tenantId);
      if (!provider?.accessToken) return res.status(400).json({ error: "Cliente sem conta Mercado Pago conectada" });
      await sequelize.transaction(async (transaction) => {
        const raffle = await Raffle.findOne({
          where: { id: raffleId, tenantId: req.tenantId }, transaction, lock: transaction.LOCK.UPDATE,
        });
        const tenant = await Tenant.findByPk(req.tenantId, {
          attributes: ["marketplaceFeePercent"], transaction,
        });
        const marketplaceFeePercent = Number(tenant?.marketplaceFeePercent ?? MARKETPLACE_FEE_PERCENT);
        // Reconsulta apos adquirir o lock para duplo clique com a mesma chave.
        payment = await Payment.findOne({ where: requestWhere, transaction, lock: transaction.LOCK.UPDATE });
        if (payment) return;
        const fail = (status, message) => { throw Object.assign(new Error(message), { httpStatus: status }); };
        if (!raffle) fail(404, "Rifa nao encontrada");
        if (raffle.status !== "ABERTA") fail(400, "Rifa ja encerrada");
        if (dedup.some((n) => !Number.isInteger(n) || n < 1 || n > raffle.totalNumbers)) fail(400, "Ha numeros fora da faixa da rifa");
        const unavailable = await listUnavailableNumbersByRaffleId(req.tenantId, raffleId, {
          transaction, paymentStatuses: ["pago", "pendente"],
        });
        if (dedup.some((n) => unavailable.includes(n))) fail(409, "Alguns numeros ja foram reservados");
        const subtotal = Number(raffle.pricePerNumber) * dedup.length;
        const discountPercent = dedup.length >= 3 ? Number(raffle.discountPercent) : 0;
        const discountAmount = Number((subtotal * discountPercent / 100).toFixed(2));
        const amount = Number((subtotal - discountAmount).toFixed(2));
        payment = await Payment.create({
          ...requestWhere, raffleId: raffle.id, amount, method, provider: "mercadopago",
          providerAccountId: provider.accountId, requestFingerprint: fingerprint,
          idempotencyKey: crypto.randomUUID(), expiresAt: new Date(Date.now() + PIX_EXPIRATION_MINUTES * 60000),
          marketplaceFeePercent,
          marketplaceFeeAmount: Number((amount * marketplaceFeePercent / 100).toFixed(2)),
          financialStatus: "created",
          status: "pendente", payload: { numbers: dedup, pricing: { subtotal, discountPercent, discountAmount, total: amount } },
        }, { transaction });
        let gatewayRequest;
        try {
          gatewayRequest = buildPixRequest({ payment, user: buyer, raffle, numbers: dedup, feePercent: marketplaceFeePercent, notificationUrl: MERCADOPAGO_NOTIFICATION_URL });
        } catch (error) { fail(400, error.message); }
        payment.payload = { ...payment.payload, gatewayRequest, externalReference: gatewayRequest.external_reference, marketplaceFee: gatewayRequest.application_fee };
        await payment.save({ transaction });
        await Ticket.bulkCreate(dedup.map((number) => ({
          tenantId: req.tenantId, userId: req.user.id, raffleId: raffle.id, paymentId: payment.id, number, status: "reservado",
        })), { transaction });
      });
    }
    if (payment.requestFingerprint !== fingerprint) return res.status(409).json({ error: "Chave de idempotencia ja utilizada para outra compra" });
    payment = await processDurablePix(payment.id);
    const pricing = payment.payload.pricing;
    return res.status(payment.status === "pago" ? 201 : payment.status === "falhou" ? 402 : 202).json({
      ...(payment.status === "falhou" ? { error: payment.payload?.gatewayErrorMessage || "Pagamento nao aprovado." } : {}),
      paymentId: payment.id, externalId: payment.externalId, status: payment.status,
      method, amount: Number(payment.amount), subtotal: pricing.subtotal, discountPercent: pricing.discountPercent,
      discountAmount: pricing.discountAmount, numbers: payment.payload.numbers,
      expiresAt: payment.expiresAt, gatewayPayload: publicPayload(payment.payload),
    });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") return res.status(409).json({ error: "Conflito na reserva; consulte sua compra e atualize a grade" });
    return res.status(error.httpStatus || 500).json({ error: error.httpStatus ? error.message : "Erro no checkout; repita a tentativa com a mesma chave" });
  }
}

// --- Checkout PIX ---------------------------------------------------------
// Reserva os numeros em transacao, aplica o desconto por quantidade e cria
// uma cobranca PIX na conta conectada do cliente.
app.post("/api/payments/checkout", authMiddleware, async (req, res) => {
  if (PAYMENT_PROVIDER === "mercadopago") return checkoutMercadoPago(req, res);
  const tx = await sequelize.transaction();
  try {
    const { raffleId, numbers, method, paymentMethodId, paymentDetails } = req.body;
    if (!raffleId || !Array.isArray(numbers) || numbers.length === 0 || !method) {
      await tx.rollback();
      return res.status(400).json({ error: "Dados do checkout invalidos" });
    }

    if (method !== "pix") {
      await tx.rollback();
      return res.status(400).json({ error: "Nesta fase, somente pagamento PIX esta disponivel" });
    }

    const raffle = await Raffle.findOne({
      where: { id: raffleId, tenantId: req.tenantId },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });

    if (!raffle) {
      await tx.rollback();
      return res.status(404).json({ error: "Rifa nao encontrada" });
    }
    if (raffle.status !== "ABERTA") {
      await tx.rollback();
      return res.status(400).json({ error: "Rifa ja encerrada" });
    }

    const dedup = [...new Set(numbers.map((n) => Number(n)))];
    const outOfRange = dedup.some((n) => !Number.isInteger(n) || n < 1 || n > raffle.totalNumbers);
    if (outOfRange) {
      await tx.rollback();
      return res.status(400).json({ error: "Ha numeros fora da faixa da rifa" });
    }

    const unavailable = await listUnavailableNumbersByRaffleId(req.tenantId, raffleId, {
      transaction: tx,
      paymentStatuses: ["pago", "pendente"],
    });

    const occupied = dedup.filter((number) => unavailable.includes(number));
    if (occupied.length > 0) {
      await tx.rollback();
      return res.status(409).json({ error: "Alguns numeros ja foram vendidos", occupied });
    }

    // Regra comercial: aplica o desconto configurado na rifa a partir de tres numeros.
    const subtotal = Number(raffle.pricePerNumber) * dedup.length;
    const discountPercent = dedup.length >= 3 ? Number(raffle.discountPercent) : 0;
    const discountAmount = Number((subtotal * discountPercent / 100).toFixed(2));
    const amount = Number((subtotal - discountAmount).toFixed(2));
    const tenantProvider = PAYMENT_PROVIDER === "mercadopago"
      ? await resolveTenantMercadoPagoProvider(req.tenantId)
      : await resolveTenantStripeProvider(req.tenantId);

    const gatewayResult = await processPaymentWithGateway({
      method,
      amount,
      paymentMethodId,
      paymentDetails,
      tenantProvider,
      user: req.user,
      raffle,
      numbers: dedup,
      metadata: {
        tenantId: String(req.tenantId),
        raffleId: String(raffle.id),
        userId: String(req.user.id),
        numbers: dedup.join(","),
      },
    });

    const payment = await Payment.create(
      {
        tenantId: req.tenantId,
        userId: req.user.id,
        raffleId: raffle.id,
        amount,
        method,
        status: gatewayResult.status,
        provider: gatewayResult.provider,
        providerAccountId: gatewayResult.providerAccountId,
        externalId: gatewayResult.externalId,
        payload: {
          ...(gatewayResult.payload || {}),
          pricing: { subtotal, discountPercent, discountAmount, total: amount },
        },
      },
      { transaction: tx }
    );

    if (payment.status === "pago" || payment.status === "pendente") {
      for (const number of dedup) {
        await Ticket.create(
          {
            tenantId: req.tenantId,
            userId: req.user.id,
            raffleId: raffle.id,
            paymentId: payment.id,
            number,
            status: payment.status === "pago" ? "confirmado" : "reservado",
          },
          { transaction: tx }
        );
      }
    }

    await tx.commit();

    if (payment.status === "pago") {
      await maybeAutoDraw(req.tenantId, raffle.id);
    }

    const responseStatus = payment.status === "pago" ? 201 : payment.status === "pendente" ? 202 : 402;
    return res.status(responseStatus).json({
      paymentId: payment.id,
      externalId: payment.externalId,
      status: payment.status,
      method,
      amount,
      subtotal,
      discountPercent,
      discountAmount,
      numbers: dedup,
      gatewayPayload: payment.payload,
    });
  } catch (error) {
    if (!tx.finished) await tx.rollback();
    if (error.name === "SequelizeUniqueConstraintError") return res.status(409).json({ error: "Alguns numeros ja foram reservados" });
    return res.status(500).json({ error: "Erro no checkout" });
  }
});

// Permite consultar o pagamento ao comprador ou aos gestores do tenant.
app.get("/api/payments/:id", authMiddleware, async (req, res) => {
  const payment = await Payment.findOne({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!payment) return res.status(404).json({ error: "Pagamento nao encontrado" });
  if (!["admin", "owner"].includes(req.user.role) && payment.userId !== req.user.id) {
    return res.status(403).json({ error: "Sem permissao para visualizar este pagamento" });
  }

  return res.json({
    id: payment.id,
    status: payment.status,
    method: payment.method,
    externalId: payment.externalId,
    amount: Number(payment.amount),
    payload: publicPayload(payment.payload),
    expiresAt: payment.expiresAt,
  });
});

// Encerra a modalidade BICHO_25 com o resultado oficial informado pelo gestor.
app.post("/api/raffles/:id/draw/bicho-rj", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raffle = await Raffle.findOne({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!raffle) return res.status(404).json({ error: "Rifa nao encontrada" });
    if (raffle.type !== "BICHO_25") {
      return res.status(400).json({ error: "Endpoint valido apenas para rifa BICHO_25" });
    }

    const tickets = await Ticket.findAll({
      where: { tenantId: req.tenantId, raffleId: raffle.id, status: "confirmado" },
      include: [{ model: Payment, where: { tenantId: req.tenantId, status: "pago" }, attributes: ["id"] }],
      order: [["number", "ASC"]],
    });

    if (tickets.length < raffle.totalNumbers) {
      return res.status(400).json({
        error: "Rifa ainda nao esta completa",
        sold: tickets.length,
        required: raffle.totalNumbers,
      });
    }

    const legacyValues = [req.body.first, req.body.second, req.body.third];
    const submittedValues = Array.isArray(req.body.results) ? req.body.results : legacyValues;
    const source = String(req.body.source || "").trim();
    if (submittedValues.length !== raffle.winnerCount) {
      return res.status(400).json({ error: `Informe os ${raffle.winnerCount} resultados do jogo do bicho` });
    }
    const values = submittedValues.map(Number);
    if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 25)) {
      return res.status(400).json({ error: "Resultado do jogo do bicho deve estar entre 1 e 25" });
    }

    const winners = [];
    for (let i = 0; i < values.length; i += 1) {
      const ticket = tickets.find((t) => t.number === values[i]);
      const owner = ticket
        ? await User.findOne({
            where: { id: ticket.userId, tenantId: req.tenantId },
            attributes: ["id", "name", "email", "phone"],
          })
        : null;
      winners.push({ place: i + 1, number: values[i], user: owner });
    }

    raffle.status = "ENCERRADA";
    raffle.drawAt = new Date();
    raffle.drawMode = "BICHO_RJ";
    raffle.drawSource = source || "Jogo do bicho RJ (informado manualmente)";
    raffle.winners = winners;
    await raffle.save();

    return res.json({ raffleId: raffle.id, status: raffle.status, winners: serializeWinners(winners) });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao processar sorteio", details: error.message });
  }
});

// Gera uma etiqueta de enderecamento em PDF para o envio do premio ao ganhador.
app.get("/api/raffles/:id/winners/:place/shipping-label.pdf", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raffle = await Raffle.findOne({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: [{ model: Product, attributes: ["id", "title"] }],
    });
    if (!raffle) return res.status(404).json({ error: "Rifa nao encontrada" });
    if (raffle.status !== "ENCERRADA") {
      return res.status(409).json({ error: "A etiqueta fica disponivel somente apos o encerramento da rifa" });
    }

    const place = Number(req.params.place);
    const winners = Array.isArray(raffle.winners) ? raffle.winners : [];
    const winner = winners.find((item) => Number(item.place) === place);
    if (!winner || !winner.user) return res.status(404).json({ error: "Ganhador nao encontrado" });

    let winnerUserId = winner.user.id;
    if (!winnerUserId) {
      const ticket = await Ticket.findOne({
        where: { tenantId: req.tenantId, raffleId: raffle.id, number: winner.number },
        attributes: ["userId"],
      });
      winnerUserId = ticket?.userId;
    }
    const [recipient, tenant, senderOwner] = await Promise.all([
      winnerUserId ? User.findOne({ where: { id: winnerUserId, tenantId: req.tenantId } }) : null,
      Tenant.findByPk(req.tenantId),
      User.findOne({ where: { tenantId: req.tenantId, role: "owner" }, order: [["id", "ASC"]] }),
    ]);
    if (!recipient) return res.status(404).json({ error: "Cadastro do ganhador nao encontrado" });

    const recipientAddress = normalizeAddress(recipient);
    const senderAddress = normalizeAddress(tenant);
    const missing = [];
    if (!addressIsComplete(recipientAddress)) missing.push("endereco do ganhador");
    if (!taxIdHasValidLength(normalizeTaxId(recipient.taxId))) missing.push("CPF/CNPJ do ganhador");
    if (!addressIsComplete(senderAddress)) missing.push("endereco do cliente/remetente");
    if (!taxIdHasValidLength(normalizeTaxId(tenant.taxId))) missing.push("CPF/CNPJ do cliente/remetente");
    if (missing.length) {
      return res.status(422).json({
        error: `Complete o ${missing.join(" e o ")} antes de gerar a etiqueta`,
        missing,
      });
    }

    const safeRaffle = String(raffle.title || "rifa").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="etiqueta-${safeRaffle}-${place}-lugar.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 36, info: { Title: `Etiqueta de envio - ${raffle.title}` } });
    doc.pipe(res);

    const mm = 72 / 25.4;
    const labelWidth = 138.11 * mm;
    const labelHeight = 106.36 * mm;
    const x = (doc.page.width - labelWidth) / 2;
    const y = 38;
    const pad = 13;
    doc.save().lineWidth(1).dash(4, { space: 3 }).rect(x, y, labelWidth, labelHeight).stroke("#6b7280").undash().restore();

    doc.rect(x + 1, y + 1, labelWidth - 2, 53).fill("#f1f3f5");
    doc.fillColor("#182233").font("Helvetica-Bold").fontSize(10)
      .text("USO EXCLUSIVO DOS CORREIOS", x + pad, y + 10, { width: labelWidth - pad * 2, align: "center" });
    doc.fillColor("#5f6978").font("Helvetica").fontSize(8)
      .text("Cole aqui a etiqueta com o código identificador da encomenda", x + pad, y + 27, { width: labelWidth - pad * 2, align: "center" });

    const receiverY = y + 54;
    doc.lineWidth(.6).rect(x + 1, receiverY, labelWidth - 2, 43).stroke("#aab1bb");
    doc.fillColor("#374151").fontSize(7.5)
      .text("Recebedor: __________________________________________", x + pad, receiverY + 8)
      .text("Documento: ____________________   Data: ____ / ____ / ______", x + pad, receiverY + 24);

    const recipientY = receiverY + 44;
    doc.lineWidth(1.4).rect(x + 1, recipientY, labelWidth - 2, 117).stroke("#111827");
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(9).text("DESTINATÁRIO", x + pad, recipientY + 10);
    doc.fontSize(15).text(recipient.name, x + pad, recipientY + 27, { width: labelWidth - pad * 2 });
    doc.font("Helvetica").fontSize(10.5)
      .text(addressLine(recipientAddress), x + pad, recipientY + 50, { width: labelWidth - pad * 2 })
      .text(addressComplementLine(recipientAddress), x + pad, recipientY + 67, { width: labelWidth - pad * 2 });
    doc.font("Helvetica-Bold").fontSize(13)
      .text(addressCityLine(recipientAddress), x + pad, recipientY + 88, { width: labelWidth - pad * 2 });
    doc.font("Helvetica").fontSize(8).text(`Telefone: ${recipient.phone} · CPF/CNPJ: ${formatTaxId(recipient.taxId)}`, x + pad, recipientY + 106);

    const senderY = recipientY + 118;
    doc.lineWidth(.6).rect(x + 1, senderY, labelWidth - 2, labelHeight - (senderY - y) - 1).stroke("#aab1bb");
    doc.fillColor("#374151").font("Helvetica-Bold").fontSize(8).text("REMETENTE", x + pad, senderY + 8);
    doc.font("Helvetica").fontSize(8.5)
      .text(`${tenant.name} · CPF/CNPJ: ${formatTaxId(tenant.taxId)}`, x + pad, senderY + 21)
      .text(`${addressLine(senderAddress)} · ${addressComplementLine(senderAddress)}`, x + pad, senderY + 34, { width: labelWidth - pad * 2 })
      .text(`${addressCityLine(senderAddress)} · Telefone: ${senderOwner?.phone || "não informado"}`, x + pad, senderY + 47, { width: labelWidth - pad * 2 });

    const infoY = y + labelHeight + 32;
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(13).text("Referência interna do envio", 50, infoY);
    doc.font("Helvetica").fontSize(10).fillColor("#374151")
      .text(`Rifa: ${raffle.title}`, 50, infoY + 22)
      .text(`Prêmio: ${raffle.Product?.title || "Não informado"}`, 50, infoY + 38)
      .text(`Ganhador: ${place}º lugar · Número ${winner.number}`, 50, infoY + 54);
    doc.fontSize(8).fillColor("#6b7280")
      .text("Este documento é um rótulo de endereçamento. O código de rastreamento e a etiqueta de postagem são emitidos pelos Correios no atendimento ou na pré-postagem.", 50, infoY + 82, { width: doc.page.width - 100 });
    doc.end();
  } catch (error) {
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: "Erro ao gerar etiqueta de envio", details: error.message });
  }
});

// Lista as cotas reservadas ou confirmadas do comprador autenticado.
app.get("/api/my/tickets", authMiddleware, async (req, res) => {
  const tickets = await Ticket.findAll({
    where: { tenantId: req.tenantId, userId: req.user.id },
    include: [
      { model: Raffle, attributes: ["id", "title", "type", "status"] },
      { model: Payment, attributes: ["id", "method", "status", "externalId", "amount", "provider"] },
    ],
    order: [["id", "DESC"]],
  });
  return res.json(tickets);
});

// Altera permissoes dentro do tenant e impede a remocao do ultimo owner.
app.patch("/api/users/:id/role", authMiddleware, adminMiddleware, async (req, res) => {
  const { role } = req.body;
  if (!["user", "admin", "owner"].includes(role)) {
    return res.status(400).json({ error: "Role invalida" });
  }

  const target = await User.findOne({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!target) return res.status(404).json({ error: "Usuario nao encontrado" });
  if (req.user.role !== "owner" && (role === "owner" || target.role === "owner")) {
    return res.status(403).json({ error: "Somente o owner pode alterar o perfil de owner" });
  }
  if (target.role === "owner" && role !== "owner") {
    const owners = await User.count({ where: { tenantId: req.tenantId, role: "owner" } });
    if (owners <= 1) return res.status(409).json({ error: "O cliente precisa manter ao menos um owner" });
  }

  target.role = role;
  await target.save();

  return res.json({ id: target.id, email: target.email, role: target.role });
});

// --- Webhooks de confirmacao assincrona ----------------------------------
// Valida a assinatura Stripe e confirma ou libera os numeros da cobranca.
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send("Stripe webhook nao configurado");
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) return res.status(400).send("Assinatura Stripe ausente");

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook invalido: ${error.message}`);
  }

  try {
    if (["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled"].includes(event.type)) {
      const intent = event.data.object;
      const providerAccountId = event.account || null;

      const where = { externalId: intent.id, provider: "stripe" };
      if (providerAccountId) where.providerAccountId = providerAccountId;

      const payment = await Payment.findOne({ where });
      if (payment) {
        if (event.type === "payment_intent.succeeded") {
          payment.status = "pago";
          payment.payload = {
            ...(payment.payload || {}),
            webhookLastEvent: event.type,
            webhookReceivedAt: new Date().toISOString(),
            stripeStatus: intent.status,
          };
          await payment.save();

          await Ticket.update(
            { status: "confirmado" },
            { where: { tenantId: payment.tenantId, paymentId: payment.id } }
          );
          await maybeAutoDraw(payment.tenantId, payment.raffleId);
        } else if (payment.status !== "pago") {
          payment.status = "falhou";
          payment.payload = {
            ...(payment.payload || {}),
            webhookLastEvent: event.type,
            webhookReceivedAt: new Date().toISOString(),
            stripeStatus: intent.status,
          };
          await payment.save();

          await Ticket.destroy({ where: { tenantId: payment.tenantId, paymentId: payment.id } });
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao processar webhook", details: error.message });
  }
});

// Confirma o PIX Mercado Pago após validar a assinatura e consultar a API.
app.post("/api/webhooks/mercadopago", express.raw({ type: "application/json" }), async (req, res) => {
  // O webhook pode ser homologado enquanto o checkout principal segue em mock.
  if (!MERCADOPAGO_WEBHOOK_SECRET) {
    return res.status(503).send("Webhook Mercado Pago aguarda assinatura secreta");
  }
  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch (_error) {
    return res.status(400).send("Payload invalido");
  }
  const dataId = String(req.query["data.id"] || event.data?.id || "").toLowerCase();
  const requestId = String(req.headers["x-request-id"] || "");
  const signatureParts = Object.fromEntries(
    String(req.headers["x-signature"] || "").split(",").map((part) => part.trim().split("="))
  );
  if (!dataId || !requestId || !signatureParts.ts || !signatureParts.v1) {
    return res.status(401).send("Assinatura Mercado Pago ausente");
  }
  const timestampValue = Number(signatureParts.ts);
  const timestampSeconds = timestampValue > 1e12 ? timestampValue / 1000 : timestampValue;
  if (!Number.isFinite(timestampSeconds)
    || Math.abs(Date.now() / 1000 - timestampSeconds) > MERCADOPAGO_WEBHOOK_MAX_AGE_SECONDS) {
    return res.status(401).send("Timestamp Mercado Pago invalido ou expirado");
  }
  const manifest = `id:${dataId};request-id:${requestId};ts:${signatureParts.ts};`;
  const expected = crypto.createHmac("sha256", MERCADOPAGO_WEBHOOK_SECRET).update(manifest).digest("hex");
  const signatureValid = expected.length === signatureParts.v1.length && crypto.timingSafeEqual(
    Buffer.from(expected), Buffer.from(signatureParts.v1)
  );
  if (!signatureValid) return res.status(401).send("Assinatura Mercado Pago invalida");

  const eventKey = crypto.createHash("sha256").update(`${dataId}:${requestId}:${signatureParts.ts}`).digest("hex");
  let auditEvent;
  try {
    [auditEvent] = await MercadoPagoWebhookEvent.findOrCreate({
      where: { eventKey },
      defaults: { externalPaymentId: dataId, requestId, action: event.action || event.type || null, status: "RECEBIDO" },
    });
    if (auditEvent.status === "PROCESSADO" || auditEvent.status === "IGNORADO") {
      return res.status(200).json({ received: true, duplicate: true });
    }
    if (auditEvent.status === "FALHOU") {
      auditEvent.status = "RECEBIDO";
      auditEvent.attempts += 1;
      auditEvent.lastError = null;
      await auditEvent.save();
    }
    const payment = await Payment.findOne({ where: { provider: "mercadopago", externalId: dataId } });
    if (!payment && event.live_mode === false) {
      auditEvent.status = "IGNORADO";
      auditEvent.processedAt = new Date();
      auditEvent.lastError = "Evento de teste sem pagamento local";
      await auditEvent.save();
      return res.status(200).json({ received: true, test: true, ignored: true });
    }
    if (!payment) {
      auditEvent.status = "FALHOU";
      auditEvent.lastError = "Pagamento ainda nao localizado";
      await auditEvent.save();
      return res.status(503).json({ error: "Pagamento ainda nao localizado; tente novamente" });
    }
    const tenantProvider = await resolveTenantMercadoPagoProvider(payment.tenantId, payment.providerAccountId);
    if (!tenantProvider) throw new Error("Conta Mercado Pago do cliente nao encontrada");
    const remote = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(dataId)}`, tenantProvider.accessToken);
    if (Number(remote.transaction_amount) !== Number(payment.amount)) {
      throw new Error("Valor do pagamento diverge da cobranca local");
    }
    const expectedReference = payment.payload?.externalReference;
    if (expectedReference && remote.external_reference !== expectedReference) {
      throw new Error("Referencia externa do pagamento invalida");
    }
    await applyMercadoPagoPayment(payment.id, remote);
    auditEvent.status = "PROCESSADO";
    auditEvent.processedAt = new Date();
    await auditEvent.save();
    return res.status(200).json({ received: true });
  } catch (_webhookError) {
    if (auditEvent) {
      auditEvent.status = "FALHOU";
      auditEvent.lastError = "Falha ao consultar ou aplicar pagamento";
      await auditEvent.save().catch(() => {});
    }
    return res.status(500).json({ error: "Erro ao processar webhook Mercado Pago" });
  }
});

// Processa notificacoes PagBank quando esse provider estiver habilitado.
app.post("/api/webhooks/pagbank", express.raw({ type: "application/json" }), async (req, res) => {
  if (PAYMENT_PROVIDER !== "pagbank") {
    return res.status(400).send("Provider pagbank nao habilitado");
  }

  if (PAGBANK_WEBHOOK_TOKEN) {
    const token = req.headers["x-webhook-token"];
    if (token !== PAGBANK_WEBHOOK_TOKEN) {
      return res.status(401).send("Token de webhook invalido");
    }
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch (_error) {
    return res.status(400).send("Payload de webhook invalido");
  }

  try {
    const charge = Array.isArray(event.charges) && event.charges.length > 0 ? event.charges[0] : null;
    if (!charge || !charge.id) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const payment = await Payment.findOne({ where: { provider: "pagbank", externalId: charge.id } });
    if (!payment) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const normalizedStatus = mapPagBankChargeStatus(charge.status);
    if (normalizedStatus === "pago" && payment.status !== "pago") {
      payment.status = "pago";
      payment.payload = {
        ...(payment.payload || {}),
        webhookLastEvent: "pagbank.order.updated",
        webhookReceivedAt: new Date().toISOString(),
        pagbankStatus: charge.status,
        pagbankOrderId: event.id || null,
        rawWebhook: event,
      };
      await payment.save();

      await Ticket.update(
        { status: "confirmado" },
        { where: { tenantId: payment.tenantId, paymentId: payment.id } }
      );
      await maybeAutoDraw(payment.tenantId, payment.raffleId);
    } else if (normalizedStatus === "falhou" && payment.status !== "pago") {
      payment.status = "falhou";
      payment.payload = {
        ...(payment.payload || {}),
        webhookLastEvent: "pagbank.order.updated",
        webhookReceivedAt: new Date().toISOString(),
        pagbankStatus: charge.status,
        pagbankOrderId: event.id || null,
        rawWebhook: event,
      };
      await payment.save();
      await Ticket.destroy({ where: { tenantId: payment.tenantId, paymentId: payment.id } });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao processar webhook PagBank", details: error.message });
  }
});

// Rotas de API desconhecidas nunca devem cair no HTML da SPA.
app.all("/api/*", (_req, res) => {
  res.status(404).json({ error: "Endpoint nao encontrado" });
});

// Fallback da SPA: qualquer rota nao-API entrega o frontend principal.
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Compatibilidade e inicializacao do banco ----------------------------
// Helpers legados que completam schemas antigos sem apagar dados existentes.
async function ensureColumn(tableName, columnName, definitionSql) {
  const [result] = await sequelize.query(`SHOW COLUMNS FROM ${tableName} LIKE '${columnName}';`);
  if (!Array.isArray(result) || result.length === 0) {
    await sequelize.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql};`);
  }
}

// Cria um indice unico somente quando ele ainda nao existe.
async function ensureUniqueIndex(tableName, indexName, definitionSql) {
  const [result] = await sequelize.query(`SHOW INDEX FROM ${tableName} WHERE Key_name = '${indexName}';`);
  if (!Array.isArray(result) || result.length === 0) {
    await sequelize.query(`ALTER TABLE ${tableName} ADD UNIQUE INDEX ${indexName} ${definitionSql};`);
  }
}

// Garante compatibilidade do ENUM de papeis com o perfil owner.
async function ensureUsersRoleEnumIncludesOwner() {
  await sequelize.query(
    "ALTER TABLE Users MODIFY COLUMN role ENUM('user','admin','owner') NOT NULL DEFAULT 'user';"
  );
}

async function ensurePaymentProviderEnum() {
  await sequelize.query(
    "ALTER TABLE TenantPaymentProviders MODIFY COLUMN provider ENUM('stripe','mercadopago') NOT NULL;"
  );
}

// Permite o mesmo email em tenants diferentes, mas nao duplicado no mesmo tenant.
async function ensureUsersEmailIndexByTenant() {
  const [indexes] = await sequelize.query("SHOW INDEX FROM Users;");
  if (Array.isArray(indexes)) {
    const uniqueEmailOnly = indexes.find(
      (idx) => idx.Key_name !== "PRIMARY" && idx.Non_unique === 0 && idx.Column_name === "email" && idx.Seq_in_index === 1
    );
    if (uniqueEmailOnly) {
      const sameKeyRows = indexes.filter((idx) => idx.Key_name === uniqueEmailOnly.Key_name);
      if (sameKeyRows.length === 1) {
        await sequelize.query(`ALTER TABLE Users DROP INDEX ${uniqueEmailOnly.Key_name};`);
      }
    }
  }

  await ensureUniqueIndex("Users", "uniq_users_tenant_email", "(tenantId, email)");
}

// Migra registros antigos sem tenant para um cliente padrao.
async function ensureDefaultTenantAndBackfill() {
  const [defaultTenant] = await Tenant.findOrCreate({
    where: { slug: "tenant-padrao" },
    defaults: { name: "Tenant Padrao", status: "ATIVO" },
  });
  const defaultTenantId = defaultTenant.id;

  await User.update({ tenantId: defaultTenantId }, { where: { tenantId: null } });
  await Product.update({ tenantId: defaultTenantId }, { where: { tenantId: null } });
  await Raffle.update({ tenantId: defaultTenantId }, { where: { tenantId: null } });
  await Payment.update({ tenantId: defaultTenantId }, { where: { tenantId: null } });
  await Ticket.update({ tenantId: defaultTenantId }, { where: { tenantId: null } });

  return defaultTenantId;
}

// Cria dados demonstrativos somente quando o tenant padrao nao possui rifas.
async function seedDefaults(defaultTenantId) {
  const count = await Raffle.count({ where: { tenantId: defaultTenantId } });
  if (count > 0) return;

  const product1 = await Product.create({
    tenantId: defaultTenantId,
    title: "Moto 0km",
    description: "Moto nova com documentacao em dia.",
    media: [{ type: "image", url: "https://picsum.photos/seed/moto/800/500" }],
  });
  const product2 = await Product.create({
    tenantId: defaultTenantId,
    title: "Notebook Gamer",
    description: "Notebook gamer high-end, 16GB RAM e RTX.",
    media: [{ type: "image", url: "https://picsum.photos/seed/notebook/800/500" }],
  });
  const product3 = await Product.create({
    tenantId: defaultTenantId,
    title: "Carro Seminovo",
    description: "Carro revisado e pronto para transferir.",
    media: [{ type: "video", url: "https://samplelib.com/lib/preview/mp4/sample-5s.mp4" }],
  });

  await Raffle.bulkCreate([
    {
      tenantId: defaultTenantId,
      productId: product1.id,
      type: "BICHO_25",
      title: "Rifa Jogo do Bicho RJ",
      description:
        "Rifa de 1 a 25 numeros. Sorteio ao completar vendas e pagamentos, com resultado baseado no jogo do bicho do RJ (1o, 2o e 3o).",
      pricePerNumber: 25,
      totalNumbers: 25,
      drawMode: "BICHO_RJ",
    },
    {
      tenantId: defaultTenantId,
      productId: product2.id,
      type: "NUMERICA_100",
      title: "Rifa Numerica 1-100",
      description: "Rifa numerica de 1 a 100 com sorteio aleatorio para 1o, 2o e 3o lugar.",
      pricePerNumber: 10,
      totalNumbers: 100,
      drawMode: "ALEATORIO",
    },
    {
      tenantId: defaultTenantId,
      productId: product3.id,
      type: "NUMERICA_1000",
      title: "Rifa Numerica 1-1000",
      description: "Rifa personalizada com numeracao escolhida entre 1 e 1000 e sorteio aleatorio para 1o, 2o e 3o lugar.",
      pricePerNumber: 5,
      totalNumbers: 1000,
      drawMode: "ALEATORIO",
    },
  ]);
}

// Mantido para compatibilidade com ambientes antigos que promoviam emails fixos.
async function ensureAdminUsers() {
  if (!ADMIN_EMAILS.length) return;
  await User.update({ role: "admin" }, { where: { email: { [Op.in]: ADMIN_EMAILS } } });
}

// Migrations incrementais registradas; cada versao so e marcada apos concluir.
async function runMigrations() {
  const migrations = [
    require("./migrations/2026090501-mercadopago-marketplace"),
    require("./migrations/2026090502-mercadopago-receiving-profile"),
    require("./migrations/2026090503-mercadopago-account-requirements"),
    require("./migrations/2026090504-mercadopago-scope-length"),
    require("./migrations/2026090505-mercadopago-scope-text"),
    require("./migrations/2026090601-tenant-marketplace-fee"),
    require("./migrations/2026090602-raffle-winner-count"),
    require("./migrations/2026091201-raffle-discount-percent"),
  ];
  for (const migration of migrations) {
    const applied = await SchemaMigration.findOne({ where: { version: migration.version } });
    if (applied) continue;
    await migration.up({ queryInterface: sequelize.getQueryInterface(), sequelize });
    await SchemaMigration.create({ version: migration.version });
  }
}

// Conecta ao banco com tentativas, sincroniza o schema e inicia o servidor HTTP.
async function boot() {
  const retries = 20;
  for (let i = 1; i <= retries; i += 1) {
    try {
      await sequelize.authenticate();
      await sequelize.sync();
      await runMigrations();

      await ensureColumn("Users", "tenantId", "INT UNSIGNED NULL");
      await ensureColumn("Users", "taxId", "VARCHAR(18) NULL");
      await ensureColumn("Users", "addressPostalCode", "VARCHAR(9) NULL");
      await ensureColumn("Users", "addressStreet", "VARCHAR(180) NULL");
      await ensureColumn("Users", "addressNumber", "VARCHAR(30) NULL");
      await ensureColumn("Users", "addressComplement", "VARCHAR(100) NULL");
      await ensureColumn("Users", "addressDistrict", "VARCHAR(100) NULL");
      await ensureColumn("Users", "addressCity", "VARCHAR(100) NULL");
      await ensureColumn("Users", "addressState", "VARCHAR(2) NULL");
      await ensureColumn("Tenants", "addressPostalCode", "VARCHAR(9) NULL");
      await ensureColumn("Tenants", "taxId", "VARCHAR(18) NULL");
      await ensureColumn("Tenants", "addressStreet", "VARCHAR(180) NULL");
      await ensureColumn("Tenants", "addressNumber", "VARCHAR(30) NULL");
      await ensureColumn("Tenants", "addressComplement", "VARCHAR(100) NULL");
      await ensureColumn("Tenants", "addressDistrict", "VARCHAR(100) NULL");
      await ensureColumn("Tenants", "addressCity", "VARCHAR(100) NULL");
      await ensureColumn("Tenants", "addressState", "VARCHAR(2) NULL");
      await ensureColumn("Products", "tenantId", "INT UNSIGNED NULL");
      await ensureColumn("Raffles", "tenantId", "INT UNSIGNED NULL");
      await ensureColumn("Payments", "tenantId", "INT UNSIGNED NULL");
      await ensureColumn("Tickets", "tenantId", "INT UNSIGNED NULL");
      await ensureColumn("TenantPaymentProviders", "expiresAt", "DATETIME NULL");

      await ensureColumn("Payments", "provider", "VARCHAR(50) NOT NULL DEFAULT 'mock'");
      await ensureColumn("Payments", "providerAccountId", "VARCHAR(120) NULL");
      await ensureColumn("Payments", "requestKey", "VARCHAR(80) NULL");
      await ensureColumn("Payments", "idempotencyKey", "VARCHAR(36) NULL");
      await ensureColumn("Payments", "requestFingerprint", "VARCHAR(64) NULL");
      await ensureColumn("Payments", "expiresAt", "DATETIME NULL");
      await ensureColumn("Payments", "processingAt", "DATETIME NULL");
      await ensureColumn("Payments", "reconciledAt", "DATETIME NULL");
      await ensureUniqueIndex("Payments", "uniq_checkout_request", "(tenantId, userId, requestKey)");
      await ensureUniqueIndex("Payments", "uniq_gateway_idempotency", "(idempotencyKey)");
      await ensureColumn(
        "Tickets",
        "status",
        "ENUM('reservado','confirmado') NOT NULL DEFAULT 'confirmado'"
      );

      await ensureUniqueIndex("Tickets", "uniq_raffle_number", "(raffleId, number)");

      const defaultTenantId = await ensureDefaultTenantAndBackfill();
      await ensureUsersRoleEnumIncludesOwner();
      await ensurePaymentProviderEnum();
      await ensureUniqueIndex("TenantPaymentProviders", "uniq_tenant_provider", "(tenantId, provider)");
      await ensureUsersEmailIndexByTenant();
      if (String(process.env.SEED_DEMO_DATA || "").toLowerCase() === "true") {
        await seedDefaults(defaultTenantId);
      }

      if (oauthCipher.enabled) {
        for (const provider of await TenantPaymentProvider.findAll()) {
          for (const field of ["accessToken", "refreshToken"]) {
            const raw = provider.getDataValue(field);
            if (raw && !raw.startsWith("enc:")) provider[field] = raw;
          }
          await provider.save();
        }
      }
      if (PAYMENT_PROVIDER === "mercadopago") {
        setInterval(reconcilePixPayments, PIX_RECONCILE_INTERVAL_MS).unref();
        reconcilePixPayments();
      }
      app.listen(PORT, () => {
        console.log(`API running on port ${PORT}`);
      });
      return;
    } catch (error) {
      console.error(`DB connection failed (${i}/${retries}): ${error.message}`);
      if (i === retries) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

if (require.main === module) boot();
module.exports = {
  app, sequelize, Tenant, User, Product, Raffle, Payment, Ticket,
  TenantPaymentProvider, MercadoPagoOAuthState, MercadoPagoWebhookEvent,
  PlatformPaymentConfiguration, processDurablePix, reconcilePixPayments,
  applyMercadoPagoPayment, resolveTenantMercadoPagoProvider,
};
