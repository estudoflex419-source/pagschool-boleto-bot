"use strict";

require("dotenv").config();

const { PORT, META_VERIFY_TOKEN } = require("./config");
const { sendText, sendDocumentBuffer } = require("./services/meta");
const { obterSegundaViaPorCpf } = require("./services/pagschool");

const { createApp } = require("./app/create-app");
const { createHealthRoutes } = require("./app/routes/health-routes");
const { createMetaRoutes } = require("./app/routes/meta-routes");
const { createPdfRoutes } = require("./app/routes/pdf-routes");
const metaWebhookParser = require("./meta/meta-webhook");
const { createProcessedMessageStore } = require("./stores/processed-message-store");
const conversationService = require("./domain/conversation/conversation-service");
const { createDefaultConversation } = require("./domain/conversation/conversation-schema");

const CONTACT_PHONE = "13 981038646";
const OVERDUE_MESSAGE = `Identificamos boleto em atraso no seu cadastro. Caso tenha qualquer dúvida sobre os boletos, entre em contato com nossa central ${CONTACT_PHONE}.`;

function onlyDigits(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function extractCpfFromText(text = "") {
  const digits = onlyDigits(text);
  return digits.length === 11 ? digits : "";
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) {
    const [, dd, mm, yyyy] = br;
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasOverdueInvoice(secondVia = {}) {
  const status = String(secondVia?.parcela?.status || "").toUpperCase();
  if (["ATRASADO", "VENCIDO", "EM_ATRASO"].includes(status)) return true;

  const dueDate = parseDate(secondVia?.parcela?.vencimento);
  if (!dueDate) return false;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return dueDate.getTime() < now.getTime() && status !== "PAGO";
}

function reply(text) {
  return { text };
}

async function processMessage(_phone, text) {
  const cpf = extractCpfFromText(text);

  if (!cpf) {
    return reply("Olá! Para consultar boletos em atraso, envie seu CPF com 11 dígitos.");
  }

  const secondVia = await obterSegundaViaPorCpf(cpf);

  if (hasOverdueInvoice(secondVia)) {
    return reply(OVERDUE_MESSAGE);
  }

  return reply("Não localizamos boletos em atraso no momento.");
}

const processedMessageStore = createProcessedMessageStore();
const healthRoutes = createHealthRoutes();
const pdfRoutes = createPdfRoutes();

const metaRoutes = createMetaRoutes({
  verifyToken: META_VERIFY_TOKEN,
  processMessage,
  metaClient: { sendText, sendDocumentBuffer },
  metaWebhookParser,
  processedMessageStore,
  conversationService,
  createDefaultConversation,
  normalizePhone: onlyDigits,
});

const app = createApp({ healthRoutes, metaRoutes, pdfRoutes });

app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT}`);
});
