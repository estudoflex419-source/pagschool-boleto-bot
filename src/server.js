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

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getPublicBase(req) {
  const host = String(req.get("host") || "").trim();
  if (!host) return "";
  return `https://${host}`;
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

async function carregarPdfBuffer(parcelaId, nossoNumero) {
  const pdfResp = await baixarPdfParcela(parcelaId, nossoNumero);
  const buffer = normalizePdfBuffer(pdfResp?.data);

  if (!buffer.length) {
    throw new Error("PDF não encontrado ou vazio.");
  }

  return buffer;
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

  router.get("/portal/financeiro/abrir-pdf/:parcelaId/:nossoNumero", async (req, res) => {
    try {
      const parcelaId = onlyDigits(req.params.parcelaId || "");
      const nossoNumero = onlyDigits(req.params.nossoNumero || "");

      if (!parcelaId || !nossoNumero) {
        return res.status(400).send("Dados do PDF inválidos.");
      }

      const base = getPublicBase(req);
      const downloadUrl = `${base}/portal/financeiro/download-pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(nossoNumero)}`;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");

      return res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Baixar carnê</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Arial, Helvetica, sans-serif;
      background: linear-gradient(135deg, #eff6ff, #dbeafe);
      color: #0f172a;
      padding: 24px;
    }
    .card {
      width: min(100%, 520px);
      background: #ffffff;
      border: 1px solid #dbe5f3;
      border-radius: 28px;
      padding: 30px;
      text-align: center;
      box-shadow: 0 24px 70px rgba(15, 23, 42, .13);
    }
    .icon {
      width: 74px;
      height: 74px;
      border-radius: 24px;
      display: grid;
      place-items: center;
      margin: 0 auto 16px;
      background: linear-gradient(135deg, #0b2854, #2563eb);
      color: white;
      font-size: 34px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      letter-spacing: -1px;
      color: #06152f;
    }
    p {
      margin: 0 0 20px;
      color: #64748b;
      line-height: 1.5;
      font-size: 14px;
    }
    .download-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 54px;
      border: 0;
      border-radius: 18px;
      background: linear-gradient(135deg, #0b2854, #2563eb);
      color: white;
      text-decoration: none;
      font-weight: 950;
      font-size: 16px;
      cursor: pointer;
      box-shadow: 0 16px 32px rgba(37, 99, 235, .24);
    }
    .direct-link {
      display: block;
      margin-top: 14px;
      color: #2563eb;
      font-weight: 800;
      word-break: break-word;
      font-size: 13px;
    }
    small {
      display: block;
      margin-top: 14px;
      color: #64748b;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📄</div>
    <h1>Carnê encontrado</h1>
    <p>O arquivo está pronto. Clique no botão abaixo para baixar o PDF do carnê.</p>
    <form action="${htmlEscape(downloadUrl)}" method="get">
      <button class="download-btn" type="submit">Baixar PDF do carnê</button>
    </form>
    <a class="direct-link" href="${htmlEscape(downloadUrl)}" target="_self">Se o botão não funcionar, clique neste link direto</a>
    <small>Após baixar, confira o arquivo na pasta Downloads do computador ou celular.</small>
  </div>
</body>
</html>`);
    } catch (error) {
      console.error("[portal-financeiro] erro ao abrir página do PDF:", error);
      return res.status(500).send("Não foi possível preparar o PDF agora.");
    }
  });

  router.get("/portal/financeiro/download-pdf/:parcelaId/:nossoNumero", async (req, res) => {
    try {
      const parcelaId = onlyDigits(req.params.parcelaId || "");
      const nossoNumero = onlyDigits(req.params.nossoNumero || "");

      if (!parcelaId || !nossoNumero) {
        return res.status(400).json({
          ok: false,
          message: "Dados do PDF inválidos."
        });
      }

      const buffer = await carregarPdfBuffer(parcelaId, nossoNumero);

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="carne-${parcelaId}.pdf"`);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Access-Control-Allow-Origin", "*");

      return res.send(buffer);
    } catch (error) {
      console.error("[portal-financeiro] erro ao baixar PDF:", error);

      return res.status(500).json({
        ok: false,
        message: "Não foi possível baixar o PDF do carnê/boleto agora."
      });
    }
  });

  router.get(["/carne/pdf/:parcelaId/:nossoNumero", "/boleto/pdf/:parcelaId/:nossoNumero"], async (req, res) => {
    const parcelaId = onlyDigits(req.params.parcelaId || "");
    const nossoNumero = onlyDigits(req.params.nossoNumero || "");

    if (!parcelaId || !nossoNumero) {
      return res.status(400).json({
        ok: false,
        message: "Dados do PDF inválidos."
      });
    }

    return res.redirect(302, `/portal/financeiro/abrir-pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(nossoNumero)}`);
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
      const base = getPublicBase(req);
      const pdfUrlSeguro = boleto.parcelaId && boleto.nossoNumero
        ? `${base}/portal/financeiro/download-pdf/${encodeURIComponent(boleto.parcelaId)}/${encodeURIComponent(boleto.nossoNumero)}`
        : boleto.pdfUrl;

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
          pdfUrl: pdfUrlSeguro
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