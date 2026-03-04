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
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * CONFIG
 */
const PORT = process.env.PORT || 3000;

const PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/$/, "");
const PAGSCHOOL_AUTH_TYPE = (process.env.PAGSCHOOL_AUTH_TYPE || "bearer").toLowerCase(); // bearer | basic | header
const PAGSCHOOL_TOKEN = process.env.PAGSCHOOL_TOKEN || "";
const PAGSCHOOL_USER = process.env.PAGSCHOOL_USER || ""; // se usar basic
const PAGSCHOOL_PASS = process.env.PAGSCHOOL_PASS || ""; // se usar basic
const PAGSCHOOL_HEADER_NAME = process.env.PAGSCHOOL_HEADER_NAME || "Authorization"; // se usar header custom
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // opcional

function authHeaders() {
  if (!PAGSCHOOL_BASE_URL) throw new Error("PAGSCHOOL_BASE_URL não configurado");

  if (PAGSCHOOL_AUTH_TYPE === "basic") {
    const token = Buffer.from(`${PAGSCHOOL_USER}:${PAGSCHOOL_PASS}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  if (PAGSCHOOL_AUTH_TYPE === "header") {
    // header custom com token
    return { [PAGSCHOOL_HEADER_NAME]: PAGSCHOOL_TOKEN };
  }

  // bearer (padrão)
  return { Authorization: `Bearer ${PAGSCHOOL_TOKEN}` };
}

function normalizePhone(s) {
  if (!s) return "";
  return String(s).replace(/\D/g, ""); // só números
}

/**
 * HELPERS
 * Aqui é onde você liga a consulta do boleto no PagSchool.
 * Como eu não sei exatamente qual endpoint o seu PagSchool usa para buscar boleto por telefone/CPF,
 * eu deixei a função preparada para você ajustar 1 linha quando o PagSchool confirmar.
 */
async function buscarBoletoNoPagSchool({ cpf, telefone }) {
  // ✅ Ajuste aqui conforme o endpoint REAL que o PagSchool te passou.
  // Exemplos comuns (NÃO GARANTIDO): /boleto, /boletos, /segunda-via, /cobrancas
  // Vou montar uma tentativa genérica usando querystring:
  const url = `${PAGSCHOOL_BASE_URL}/boleto`;

  const params = {};
  if (cpf) params.cpf = String(cpf).replace(/\D/g, "");
  if (telefone) params.telefone = normalizePhone(telefone);

  const { data } = await axios.get(url, {
    headers: authHeaders(),
    params,
    timeout: 20000,
  });

  // Esperado que venha algo com link/linha digitável
  // Vamos tentar padronizar:
  const boletoLink =
    data?.boleto ||
    data?.link ||
    data?.url ||
    data?.pdf ||
    data?.data?.boleto ||
    data?.data?.link ||
    "";

  const linhaDigitavel =
    data?.linha_digitavel ||
    data?.linhaDigitavel ||
    data?.linha ||
    data?.data?.linha_digitavel ||
    "";

  return {
    raw: data,
    boletoLink,
    linhaDigitavel,
  };
}

/**
 * HEALTH
 */
app.get(["/", "/health"], (req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

/**
 * PAGSCHOOL WEBHOOK (eventos do PagSchool)
 */
app.get("/webhook", (req, res) => {
  res.status(200).send("Webhook ativo");
});

app.post("/webhook", (req, res) => {
  // Se quiser validar assinatura/secret, dá pra implementar aqui.
  console.log("[PAGSCHOOL] Webhook recebido:", JSON.stringify(req.body));

  // Sempre responda 200 rápido
  return res.status(200).json({ ok: true });
});

/**
 * FACILITAFLOW WEBHOOK (mensagens do fluxo)
 * -> configure no FacilitaFlow: https://pagschool-boleto-bot-1.onrender.com/flow
 */
function extractFromFacilitaFlowPayload(body) {
  // Como cada plataforma manda um formato, vamos tentar achar telefone e texto em vários campos.
  const text =
    body?.message ||
    body?.text ||
    body?.mensagem ||
    body?.data?.message ||
    body?.data?.text ||
    body?.input ||
    "";

  const phone =
    body?.phone ||
    body?.telefone ||
    body?.from ||
    body?.contato?.telefone ||
    body?.contact?.phone ||
    body?.data?.phone ||
    body?.data?.from ||
    "";

  const cpf =
    body?.cpf ||
    body?.document ||
    body?.documento ||
    body?.data?.cpf ||
    "";

  return { text: String(text || ""), phone: normalizePhone(phone), cpf: String(cpf || "") };
}

function respondToFlow(res, msg, extra = {}) {
  // Resposta “tolerante”: devolve JSON e também pode ser lida como texto dependendo da plataforma.
  // Muitas plataformas usam a resposta do webhook como mensagem.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json({
    ok: true,
    reply: msg,
    text: msg,
    message: msg,
    ...extra,
  });
}

app.all("/flow", async (req, res) => {
  try {
    // Log completo para você ver o que o FacilitaFlow está mandando
    console.log("[FLOW] Method:", req.method);
    console.log("[FLOW] Headers:", JSON.stringify(req.headers));
    console.log("[FLOW] Body:", JSON.stringify(req.body));
    console.log("[FLOW] Query:", JSON.stringify(req.query));

    const payload = req.method === "GET" ? req.query : req.body;
    const { text, phone, cpf } = extractFromFacilitaFlowPayload(payload);

    // Se não veio telefone nem cpf, pede de forma simples
    if (!phone && !cpf) {
      return respondToFlow(
        res,
        "Para eu enviar sua 2ª via, me diga seu CPF (somente números). 😊"
      );
    }

    // Tenta buscar boleto no PagSchool
    const result = await buscarBoletoNoPagSchool({ cpf, telefone: phone });

    if (!result?.boletoLink && !result?.linhaDigitavel) {
      return respondToFlow(
        res,
        "Não encontrei um boleto agora. Me confirme seu CPF (somente números) para eu localizar certinho. 😊",
        { debug: { gotPhone: !!phone, gotCpf: !!cpf } }
      );
    }

    let msg = "Aqui está sua 2ª via do boleto 😊\n\n";
    if (result.linhaDigitavel) msg += `Linha digitável:\n${result.linhaDigitavel}\n\n`;
    if (result.boletoLink) msg += `Link:\n${result.boletoLink}`;

    return respondToFlow(res, msg);
  } catch (err) {
    console.error("[FLOW] Erro:", err?.response?.data || err?.message || err);
    return respondToFlow(res, "Tive um erro ao buscar seu boleto. Tente novamente em 1 minuto, por favor. 🙏");
  }
});

/**
 * ENDPOINT MANUAL /BOLETO (se você quiser chamar direto)
 */
app.post("/boleto", async (req, res) => {
  try {
    const cpf = req.body?.cpf ? String(req.body.cpf) : "";
    const telefone = req.body?.telefone ? String(req.body.telefone) : "";

    const result = await buscarBoletoNoPagSchool({ cpf, telefone });

    return res.json({
      ok: true,
      boleto: result.boletoLink,
      linha_digitavel: result.linhaDigitavel,
      raw: result.raw,
    });
  } catch (err) {
    console.error("[BOLETO] Erro:", err?.response?.data || err?.message || err);
    return res.status(500).json({ ok: false, error: "Falha ao buscar boleto" });
  }
});

app.listen(PORT, () => {
  console.log(`[OK] Server rodando na porta ${PORT}`);
  console.log(`[OK] Health: /health`);
  console.log(`[OK] Boleto: POST /boleto`);
  console.log(`[OK] PagSchool Webhook: POST /webhook`);
  console.log(`[OK] FacilitaFlow: GET/POST /flow`);
});
