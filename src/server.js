"use strict";

require("dotenv").config();

const express = require("express");
const { PORT, META_VERIFY_TOKEN } = require("./config");
const { sendText } = require("./services/meta");
const { obterSegundaViaPorCpf, baixarPdfParcela } = require("./services/pagschool");
const { isParcelaOverdue } = require("./services/overdue-detector");
const store = require("./services/overdue-reminder-store");
const {
  runOverdueReminderJob,
  startOverdueReminderCron
} = require("./jobs/overdue-reminder-job");
const { createApp } = require("./app/create-app");
const { createHealthRoutes } = require("./app/routes/health-routes");
const { createMetaRoutes } = require("./app/routes/meta-routes");
const metaWebhookParser = require("./meta/meta-webhook");
const { createProcessedMessageStore } = require("./stores/processed-message-store");
const conversationService = require("./domain/conversation/conversation-service");
const { createDefaultConversation } = require("./domain/conversation/conversation-schema");

const processedMessageStore = createProcessedMessageStore();

function onlyDigits(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function pickFirstFilled(...values) {
  for (const value of values) {
    if (value === 0) return "0";

    if (value !== null && value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }

  return "";
}

function formatMoneyBR(value) {
  const number = Number(value || 0);

  if (!Number.isFinite(number)) {
    return "R$ 0,00";
  }

  return number.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

function formatDateBR(value) {
  if (!value) return "";

  const raw = String(value).trim();

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    return raw;
  }

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return date.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo"
  });
}

function normalizarBoletoPortal(secondVia) {
  const aluno = secondVia?.aluno || {};
  const contrato = secondVia?.contract || secondVia?.contrato || {};
  const parcela = secondVia?.parcela || {};

  const alunoNome = pickFirstFilled(
    aluno.nomeAluno,
    aluno.nome,
    aluno.name,
    aluno.razaoSocial,
    "Aluno"
  );

  const cursoNome = pickFirstFilled(
    contrato.nomeCurso,
    contrato.curso,
    contrato.descricao,
    contrato.nome,
    parcela.nomeCurso,
    "Curso"
  );

  const parcelaId = pickFirstFilled(
    secondVia?.parcelaId,
    parcela.id,
    parcela.parcelaId
  );

  const nossoNumero = pickFirstFilled(
    secondVia?.nossoNumero,
    parcela.nossoNumero,
    parcela.numeroBoleto
  );

  const linhaDigitavel = pickFirstFilled(
    secondVia?.linhaDigitavel,
    parcela.linhaDigitavel,
    parcela.numeroBoleto,
    parcela.codigoBarras
  );

  const pdfUrl = pickFirstFilled(
    secondVia?.pdfUrl,
    parcela.pdfUrl,
    parcela.linkPDF,
    parcela.urlPdf,
    parcela.pdf
  );

  const valorRaw = pickFirstFilled(
    parcela.valor,
    parcela.valorParcela,
    parcela.valorOriginal,
    parcela.valorTotal
  );

  const vencimentoRaw = pickFirstFilled(
    parcela.vencimento,
    parcela.dataVencimento,
    parcela.dueDate
  );

  const status = pickFirstFilled(
    parcela.status,
    parcela.situacao,
    "ABERTO"
  );

  const numeroParcela = pickFirstFilled(
    parcela.numeroParcela,
    parcela.parcela,
    parcela.numero,
    ""
  );

  return {
    alunoNome,
    cursoNome,
    parcelaId,
    nossoNumero,
    linhaDigitavel,
    pdfUrl,
    valor: Number(valorRaw || 0),
    valorFormatado: formatMoneyBR(valorRaw),
    vencimento: vencimentoRaw,
    vencimentoFormatado: formatDateBR(vencimentoRaw),
    status,
    numeroParcela,
    emAtraso: isParcelaOverdue(parcela || {})
  };
}

async function processMessage(_phone, text) {
  const cpf = onlyDigits(text);

  if (cpf.length !== 11) {
    return {
      text: "Olá! Para consultar boletos em atraso, envie seu CPF com 11 dígitos."
    };
  }

  const secondVia = await obterSegundaViaPorCpf(cpf);

  return {
    text: isParcelaOverdue(secondVia?.parcela || {})
      ? "Identificamos boleto em atraso no seu cadastro da Escola Brasil/Estudo Flex. Caso tenha qualquer dúvida sobre os boletos, entre em contato com nossa central: 13 981038646."
      : "Não localizamos boletos em atraso no momento."
  };
}

function portalFinanceiroAllowed(req) {
  const token = String(process.env.PORTAL_FINANCEIRO_TOKEN || "").trim();

  if (!token) {
    return true;
  }

  const recebido = String(
    req.headers["x-portal-financeiro-token"] ||
      req.headers["authorization"] ||
      req.body?.token ||
      req.query?.token ||
      ""
  ).replace(/^Bearer\s+/i, "").trim();

  return recebido === token;
}

function normalizePdfBuffer(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer);

  try {
    return Buffer.from(data);
  } catch (_error) {
    return Buffer.alloc(0);
  }
}

function createPortalFinanceiroRoutes() {
  const router = express.Router();

  router.get("/portal/financeiro/health", (_req, res) => {
    res.json({
      ok: true,
      service: "portal-financeiro",
      status: "online"
    });
  });

  router.get(["/carne/pdf/:parcelaId/:nossoNumero", "/boleto/pdf/:parcelaId/:nossoNumero"], async (req, res) => {
    try {
      const parcelaId = onlyDigits(req.params.parcelaId || "");
      const nossoNumero = onlyDigits(req.params.nossoNumero || "");

      if (!parcelaId || !nossoNumero) {
        return res.status(400).json({
          ok: false,
          message: "Dados do PDF inválidos."
        });
      }

      const pdfResp = await baixarPdfParcela(parcelaId, nossoNumero);
      const buffer = normalizePdfBuffer(pdfResp?.data);

      if (!buffer.length) {
        return res.status(404).json({
          ok: false,
          message: "PDF não encontrado ou vazio."
        });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="carne-${parcelaId}.pdf"`);
      res.setHeader("Cache-Control", "private, max-age=60");

      return res.send(buffer);
    } catch (error) {
      console.error("[portal-financeiro] erro ao abrir PDF:", error);

      return res.status(500).json({
        ok: false,
        message: "Não foi possível abrir o PDF do carnê/boleto agora."
      });
    }
  });

  router.post("/portal/financeiro/boleto", async (req, res) => {
    try {
      if (!portalFinanceiroAllowed(req)) {
        return res.status(401).json({
          ok: false,
          code: "UNAUTHORIZED",
          message: "Acesso não autorizado."
        });
      }

      const cpf = onlyDigits(
        req.body?.cpf ||
          req.body?.documento ||
          req.body?.cpfAluno ||
          req.body?.alunoCpf ||
          ""
      );

      if (cpf.length !== 11) {
        return res.status(400).json({
          ok: false,
          code: "CPF_INVALIDO",
          message: "Informe um CPF válido com 11 dígitos."
        });
      }

      const secondVia = await obterSegundaViaPorCpf(cpf);
      const boleto = normalizarBoletoPortal(secondVia);

      if (!secondVia?.aluno) {
        return res.status(404).json({
          ok: false,
          code: "ALUNO_NAO_ENCONTRADO",
          message: "Não encontramos cadastro financeiro para este CPF."
        });
      }

      if (!secondVia?.parcela || !boleto.parcelaId) {
        return res.status(404).json({
          ok: false,
          code: "BOLETO_NAO_ENCONTRADO",
          message: "Não encontramos carnê/boleto em aberto para este aluno.",
          aluno: {
            nome: boleto.alunoNome
          }
        });
      }

      return res.json({
        ok: true,
        message: "Carnê/boleto localizado com sucesso.",
        aluno: {
          nome: boleto.alunoNome
        },
        curso: {
          nome: boleto.cursoNome
        },
        boleto: {
          parcelaId: boleto.parcelaId,
          numeroParcela: boleto.numeroParcela,
          status: boleto.status,
          emAtraso: boleto.emAtraso,
          valor: boleto.valor,
          valorFormatado: boleto.valorFormatado,
          vencimento: boleto.vencimento,
          vencimentoFormatado: boleto.vencimentoFormatado,
          linhaDigitavel: boleto.linhaDigitavel,
          nossoNumero: boleto.nossoNumero,
          pdfUrl: boleto.pdfUrl
        },
        suporte: {
          telefone: "13981038646",
          whatsappUrl: "https://wa.me/5513981038646?text=Ol%C3%A1%2C%20preciso%20de%20ajuda%20com%20meu%20financeiro."
        }
      });
    } catch (error) {
      console.error("[portal-financeiro] erro ao buscar boleto:", error);

      return res.status(500).json({
        ok: false,
        code: "ERRO_INTERNO",
        message: "Não foi possível consultar o carnê/boleto agora. Tente novamente ou fale com o suporte financeiro."
      });
    }
  });

  return router;
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
    normalizePhone: onlyDigits
  }),
  pdfRoutes: createPortalFinanceiroRoutes()
});

function debugAllowed(req) {
  const token = String(process.env.DEBUG_TOKEN || "");

  return Boolean(
    token &&
      (
        req.headers["x-debug-token"] === token ||
        req.query.debugToken === token
      )
  );
}

app.get("/debug/overdue/status", (req, res) => {
  if (!debugAllowed(req)) {
    return res.status(401).json({
      error: "unauthorized"
    });
  }

  res.json(store.summary());
});

app.post("/debug/overdue/run", async (req, res) => {
  if (!debugAllowed(req)) {
    return res.status(401).json({
      error: "unauthorized"
    });
  }

  const out = await runOverdueReminderJob();
  res.json(out);
});

app.post("/webhook/pagschool", (req, res) => {
  const payload = req.body || {};
  const parcelaId = String(payload.id || "");

  if (parcelaId) {
    store.upsert({
      parcelaId,
      lastPagSchoolStatus: payload.status || "",
      status: payload.status || ""
    });

    if (
      payload.dataPagamento ||
      Number(payload.valorPago || 0) > 0 ||
      /PAGO|QUITADO|BAIXADO/i.test(String(payload.status || ""))
    ) {
      store.closeByParcelaId(parcelaId, "PAGO_OU_ATUALIZADO_NO_PAGSCHOOL");
    }
  }

  res.json({
    ok: true
  });
});

if (String(process.env.ENABLE_OVERDUE_AUTO_BILLING || "false") === "true") {
  startOverdueReminderCron();
}

app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT}`);
});
