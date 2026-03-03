require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));

/**
 * CONFIG
 */
const PORT = process.env.PORT || 3000;

const PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/$/, "");
const PAGSCHOOL_AUTH_TYPE = (process.env.PAGSCHOOL_AUTH_TYPE || "bearer").toLowerCase(); // bearer | basic | header
const PAGSCHOOL_TOKEN = process.env.PAGSCHOOL_TOKEN || "";
const PAGSCHOOL_USER = process.env.PAGSCHOOL_USER || "";
const PAGSCHOOL_PASS = process.env.PAGSCHOOL_PASS || "";
const PAGSCHOOL_HEADER_NAME = process.env.PAGSCHOOL_HEADER_NAME || "Authorization"; // se "header"
const PAGSCHOOL_HEADER_VALUE = process.env.PAGSCHOOL_HEADER_VALUE || ""; // se "header"

const PAGSCHOOL_FIND_CONTRACT_PATH = process.env.PAGSCHOOL_FIND_CONTRACT_PATH || "/contratos/buscar"; 
// Ex: /prod/api/contratos/buscar  (VOCÊ VAI AJUSTAR)
const PAGSCHOOL_GET_BOLETO_PATH = process.env.PAGSCHOOL_GET_BOLETO_PATH || "/boleto/segunda-via"; 
// Ex: /prod/api/boleto/segunda-via (VOCÊ VAI AJUSTAR)

const WEBHOOK_SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET || ""; 
// opcional: você pode passar pro PagSchool e exigir que venha num header, ou validar assinatura se eles tiverem

/**
 * HTTP CLIENT (PagSchool)
 */
function buildAuthHeaders() {
  // Monta headers conforme tipo de autenticação
  if (PAGSCHOOL_AUTH_TYPE === "bearer") {
    return PAGSCHOOL_TOKEN
      ? { Authorization: `Bearer ${PAGSCHOOL_TOKEN}` }
      : {};
  }

  if (PAGSCHOOL_AUTH_TYPE === "basic") {
    if (!PAGSCHOOL_USER || !PAGSCHOOL_PASS) return {};
    const base64 = Buffer.from(`${PAGSCHOOL_USER}:${PAGSCHOOL_PASS}`).toString("base64");
    return { Authorization: `Basic ${base64}` };
  }

  if (PAGSCHOOL_AUTH_TYPE === "header") {
    if (!PAGSCHOOL_HEADER_NAME || !PAGSCHOOL_HEADER_VALUE) return {};
    return { [PAGSCHOOL_HEADER_NAME]: PAGSCHOOL_HEADER_VALUE };
  }

  return {};
}

function assertConfigForBoleto() {
  if (!PAGSCHOOL_BASE_URL) {
    throw new Error("PAGSCHOOL_BASE_URL não configurada.");
  }
}

/**
 * Utilitários
 */
function onlyDigits(str) {
  return String(str || "").replace(/\D/g, "");
}

function maskCpf(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.***.***-${d.slice(9, 11)}`;
}

/**
 * "Banco" simples em memória (pra não depender de banco agora).
 * Se quiser depois, eu adapto pra Postgres/Supabase.
 */
const memoryDb = {
  webhooks: [],
  lastBoletoByCpf: new Map() // cpf -> ultimo boleto retornado
};

/**
 * Healthcheck
 */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

/**
 * Endpoint para sua IA: buscar 2ª via do boleto por CPF+Telefone
 * Body JSON:
 * {
 *   "cpf": "123.456.789-00",
 *   "telefone": "5511999999999"
 * }
 */
app.post("/boleto", async (req, res) => {
  try {
    assertConfigForBoleto();

    const cpf = onlyDigits(req.body?.cpf);
    const telefone = onlyDigits(req.body?.telefone);

    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ ok: false, error: "CPF inválido. Envie 11 dígitos." });
    }
    if (!telefone || telefone.length < 10) {
      return res.status(400).json({ ok: false, error: "Telefone inválido. Envie DDD+Número." });
    }

    // 1) Encontrar contrato (ou aluno) usando CPF+Telefone
    // ⚠️ Ajuste conforme a API REAL do PagSchool.
    // Aqui eu deixei um padrão genérico "buscar contrato".
    const findContractUrl = `${PAGSCHOOL_BASE_URL}${PAGSCHOOL_FIND_CONTRACT_PATH}`;

    const headers = {
      "Content-Type": "application/json",
      ...buildAuthHeaders()
    };

    // payload genérico
    const findPayload = { cpf, telefone };

    const contractResp = await axios.post(findContractUrl, findPayload, { headers, timeout: 15000 });

    // Você vai ajustar esta parte quando souber o formato real:
    // Tentamos "contrato_id" em várias formas comuns:
    const data1 = contractResp.data || {};
    const contratoId =
      data1?.contrato_id ||
      data1?.contratoId ||
      data1?.data?.contrato_id ||
      data1?.data?.contratoId ||
      data1?.contratos?.[0]?.id ||
      data1?.contratos?.[0]?.contrato_id ||
      data1?.result?.[0]?.contrato_id;

    if (!contratoId) {
      return res.status(404).json({
        ok: false,
        error: "Contrato não encontrado para esse CPF/Telefone. (Ajuste o mapeamento conforme retorno do PagSchool.)",
        debug_hint: "Verifique o JSON retornado pelo PagSchool no endpoint de busca."
      });
    }

    // 2) Buscar 2ª via do boleto pelo contrato_id
    const boletoUrl = `${PAGSCHOOL_BASE_URL}${PAGSCHOOL_GET_BOLETO_PATH}`;

    const boletoPayload = { contrato_id: contratoId };

    const boletoResp = await axios.post(boletoUrl, boletoPayload, { headers, timeout: 15000 });
    const b = boletoResp.data || {};

    // Mapear campos comuns (ajuste quando souber o retorno real)
    const retorno = {
      ok: true,
      cpf_mask: maskCpf(cpf),
      telefone,
      contrato_id: contratoId,

      // campos do boleto:
      nossoNumero: b?.nossoNumero || b?.nosso_numero || b?.data?.nossoNumero || null,
      numeroBoleto: b?.numeroBoleto || b?.numero_boleto || b?.data?.numeroBoleto || null,
      vencimento: b?.vencimento || b?.data?.vencimento || null,
      valor: b?.valor || b?.data?.valor || null,

      linhaDigitavel:
        b?.linhaDigitavel || b?.linha_digitavel || b?.data?.linhaDigitavel || b?.data?.linha_digitavel || null,

      codigoBarras:
        b?.codigoBarras || b?.codigo_barras || b?.data?.codigoBarras || b?.data?.codigo_barras || null,

      linkPdf:
        b?.linkPdf || b?.pdf || b?.urlPdf || b?.url_pdf || b?.data?.linkPdf || b?.data?.pdf || null,

      status: b?.status || b?.data?.status || "emitido"
    };

    // se não veio nada importante, devolve com aviso
    const hasUseful =
      retorno.linhaDigitavel || retorno.codigoBarras || retorno.linkPdf || retorno.numeroBoleto || retorno.nossoNumero;

    if (!hasUseful) {
      return res.status(200).json({
        ok: true,
        warning: "Boleto encontrado, mas o mapeamento de campos pode não bater com o retorno real do PagSchool.",
        raw: b,
        mapped: retorno
      });
    }

    // salvar cache simples
    memoryDb.lastBoletoByCpf.set(cpf, retorno);

    return res.json(retorno);
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Erro desconhecido";
    return res.status(500).json({
      ok: false,
      error: "Falha ao buscar boleto no PagSchool.",
      details: msg
    });
  }
});

/**
 * Webhook do PagSchool (PagSchool -> seu servidor)
 * Eles mandam algo parecido com:
 * {
 *   "id": 1242236,
 *   "valor": 35,
 *   "valorPago": 20,
 *   "numeroBoleto": "...",
 *   "vencimento": "2024-04-05",
 *   "dataPagamento": "2024-04-05",
 *   "nossoNumero": "...",
 *   "contrato_id": 60011
 * }
 */
app.post("/webhook", (req, res) => {
  try {
    // Se você combinar um segredo com o PagSchool, dá pra exigir:
    // header: x-webhook-secret: SEU_SEGREDO
    if (WEBHOOK_SHARED_SECRET) {
      const got = req.headers["x-webhook-secret"];
      if (got !== WEBHOOK_SHARED_SECRET) {
        return res.status(401).json({ ok: false, error: "Webhook não autorizado (secret inválido)." });
      }
    }

    const payload = req.body || {};
    memoryDb.webhooks.push({ at: new Date().toISOString(), payload });

    // Aqui você pode:
    // - atualizar banco
    // - disparar mensagem no WhatsApp
    // - avisar sua plataforma de IA
    // Eu deixei pronto e simples.

    return res.status(200).json({ ok: true, received: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao processar webhook." });
  }
});

/**
 * Admin simples: ver últimos webhooks recebidos
 * (Proteja com uma senha se for deixar em produção!)
 */
app.get("/webhook/logs", (req, res) => {
  return res.json({ ok: true, total: memoryDb.webhooks.length, last: memoryDb.webhooks.slice(-20) });
});

app.listen(PORT, () => {
  console.log(`[OK] Server rodando na porta ${PORT}`);
  console.log(`[OK] Health: /health`);
  console.log(`[OK] Boleto: POST /boleto`);
  console.log(`[OK] Webhook: POST /webhook`);
});
