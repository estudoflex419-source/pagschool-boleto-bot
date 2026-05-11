"use strict";

require("dotenv").config();

const { PORT, META_VERIFY_TOKEN } = require("./config");
const { sendText } = require("./services/meta");
const { obterSegundaViaPorCpf } = require("./services/pagschool");
const { isParcelaOverdue } = require("./services/overdue-detector");
const store = require("./services/overdue-reminder-store");
const {
  runOverdueReminderJob,
  startOverdueReminderCron,
} = require("./jobs/overdue-reminder-job");

const { createApp, attachFinalHandlers } = require("./app/create-app");
const { createHealthRoutes } = require("./app/routes/health-routes");
const { createMetaRoutes } = require("./app/routes/meta-routes");
const metaWebhookParser = require("./meta/meta-webhook");
const { createProcessedMessageStore } = require("./stores/processed-message-store");
const conversationService = require("./domain/conversation/conversation-service");
const { createDefaultConversation } = require("./domain/conversation/conversation-schema");

const processedMessageStore = createProcessedMessageStore();

function onlyDigits(value = "") {
  return String(value).replace(/\D/g, "");
}

async function processMessage(_phone, text) {
  const cpf = onlyDigits(text);

  if (cpf.length !== 11) {
    return {
      text: "Olá! Para consultar boletos em atraso, envie seu CPF com 11 dígitos.",
    };
  }

  const secondVia = await obterSegundaViaPorCpf(cpf);

  if (isParcelaOverdue(secondVia?.parcela || {})) {
    return {
      text:
        "Identificamos boleto em atraso no seu cadastro da Escola Brasil/Estudo Flex. " +
        "Caso tenha qualquer dúvida sobre os boletos, entre em contato com nossa central: 13 981038646.",
    };
  }

  return {
    text: "Não localizamos boletos em atraso no momento.",
  };
}

const app = createApp({
  healthRoutes: createHealthRoutes(),
  metaRoutes: createMetaRoutes({
    verifyToken: META_VERIFY_TOKEN,
    processMessage,
    metaClient: { sendText },
    metaWebhookParser,
    processedMessageStore,
    conversationService,
    createDefaultConversation,
    normalizePhone: onlyDigits,
  }),
});

function debugAllowed(req) {
  const token = String(process.env.DEBUG_TOKEN || "");
  return (
    token &&
    (req.headers["x-debug-token"] === token || req.query.debugToken === token)
  );
}

app.get("/debug/overdue/status", (req, res) => {
  if (!debugAllowed(req)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "DEBUG_TOKEN inválido ou ausente.",
    });
  }

  return res.json({
    ok: true,
    enabled: String(process.env.ENABLE_OVERDUE_AUTO_BILLING || "false") === "true",
    intervalDays: Number(process.env.OVERDUE_REMINDER_INTERVAL_DAYS || 7),
    templateName: process.env.WHATSAPP_OVERDUE_TEMPLATE_NAME || null,
    templateLanguage: process.env.WHATSAPP_OVERDUE_TEMPLATE_LANGUAGE || "pt_BR",
    store: store.summary(),
  });
});

app.post("/debug/overdue/run", async (req, res) => {
  if (!debugAllowed(req)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "DEBUG_TOKEN inválido ou ausente.",
    });
  }

  try {
    const output = await runOverdueReminderJob();

    return res.json({
      ok: true,
      message: "Rotina de cobrança executada.",
      output,
    });
  } catch (error) {
    console.error("[debug/overdue/run] erro:", error);

    return res.status(500).json({
      ok: false,
      message: "Erro ao executar rotina de cobrança.",
      error: error.message,
    });
  }
});

app.get("/debug/overdue/run", async (req, res) => {
  if (!debugAllowed(req)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "DEBUG_TOKEN inválido ou ausente.",
    });
  }

  try {
    const output = await runOverdueReminderJob();

    return res.json({
      ok: true,
      message: "Rotina de cobrança executada.",
      output,
    });
  } catch (error) {
    console.error("[debug/overdue/run] erro:", error);

    return res.status(500).json({
      ok: false,
      message: "Erro ao executar rotina de cobrança.",
      error: error.message,
    });
  }
});

app.post("/webhook/pagschool", (req, res) => {
  const payload = req.body || {};
  const parcelaId = String(payload.id || payload.parcelaId || "");

  if (parcelaId) {
    store.upsert({
      parcelaId,
      lastPagSchoolStatus: payload.status || "",
      status: payload.status || "",
    });

    if (
      payload.dataPagamento ||
      Number(payload.valorPago || 0) > 0 ||
      /PAGO|QUITADO|BAIXADO/i.test(String(payload.status || ""))
    ) {
      store.closeByParcelaId(parcelaId, "PAGO_OU_ATUALIZADO_NO_PAGSCHOOL");
    }
  }

  return res.json({ ok: true });
});

if (String(process.env.ENABLE_OVERDUE_AUTO_BILLING || "false") === "true") {
  startOverdueReminderCron();
  console.log("[overdue] cobrança automática ativada.");
} else {
  console.log("[overdue] cobrança automática desativada.");
}

attachFinalHandlers(app);

app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT}`);
});
