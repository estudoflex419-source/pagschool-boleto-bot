require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

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
const PAGSCHOOL_USER = process.env.PAGSCHOOL_USER || "";
const PAGSCHOOL_PASS = process.env.PAGSCHOOL_PASS || "";
const PAGSCHOOL_HEADER_NAME = process.env.PAGSCHOOL_HEADER_NAME || "Authorization";

function authHeaders() {
  if (PAGSCHOOL_AUTH_TYPE === "basic") {
    const token = Buffer.from(`${PAGSCHOOL_USER}:${PAGSCHOOL_PASS}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  if (PAGSCHOOL_AUTH_TYPE === "header") {
    return { [PAGSCHOOL_HEADER_NAME]: PAGSCHOOL_TOKEN };
  }
  return { Authorization: `Bearer ${PAGSCHOOL_TOKEN}` };
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

/**
 * BUSCAR BOLETO NO PAGSCHOOL
 * ⚠️ Se o PagSchool usar outro caminho, você troca APENAS essa linha:
 * const url = `${PAGSCHOOL_BASE_URL}/boleto`;
 */
async function buscarBoleto({ cpf, telefone }) {
  if (!PAGSCHOOL_BASE_URL) throw new Error("PAGSCHOOL_BASE_URL não configurado");

  const url = `${PAGSCHOOL_BASE_URL}/boleto`; // <- se o PagSchool te passar outro endpoint, troca aqui

  const params = {};
  if (cpf) params.cpf = onlyDigits(cpf);
  if (telefone) params.telefone = onlyDigits(telefone);

  const { data } = await axios.get(url, {
    headers: authHeaders(),
    params,
    timeout: 20000,
  });

  const boleto =
    data?.boleto ||
    data?.link ||
    data?.url ||
    data?.pdf ||
    data?.data?.boleto ||
    data?.data?.link ||
    "";

  const linha_digitavel =
    data?.linha_digitavel ||
    data?.linhaDigitavel ||
    data?.linha ||
    data?.data?.linha_digitavel ||
    "";

  return { boleto, linha_digitavel, raw: data };
}

/**
 * HEALTH
 */
app.get(["/", "/health"], (req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

/**
 * WEBHOOK PAGSCHOOL (eventos)
 */
app.get("/webhook", (req, res) => res.status(200).send("Webhook ativo ✅"));

app.post("/webhook", (req, res) => {
  console.log("[PAGSCHOOL] Webhook recebido:", JSON.stringify(req.body));
  return res.status(200).json({ ok: true });
});

/**
 * BOLETO (manual)
 */
app.post("/boleto", async (req, res) => {
  try {
    const cpf = req.body?.cpf || "";
    const telefone = req.body?.telefone || "";

    const result = await buscarBoleto({ cpf, telefone });

    return res.json({
      ok: true,
      boleto: result.boleto,
      linha_digitavel: result.linha_digitavel,
      raw: result.raw,
    });
  } catch (err) {
    console.error("[BOLETO] Erro:", err?.response?.data || err?.message || err);
    return res.status(500).json({ ok: false, error: "Falha ao buscar boleto" });
  }
});

/**
 * FLOW (FacilitaFlow)
 * -> coloque no FacilitaFlow: https://pagschool-boleto-bot-1.onrender.com/flow
 */
function responderFlow(res, msg, extra = {}) {
  return res.status(200).json({
    ok: true,
    reply: msg,
    message: msg,
    text: msg,
    ...extra,
  });
}

app.all("/flow", async (req, res) => {
  try {
    console.log("[FLOW] method:", req.method);
    console.log("[FLOW] query:", JSON.stringify(req.query));
    console.log("[FLOW] body:", JSON.stringify(req.body));

    const payload = req.method === "GET" ? req.query : req.body;

    // tenta pegar cpf/telefone de vários formatos
    const cpf = payload?.cpf || payload?.documento || payload?.document || "";
    const telefone =
      payload?.telefone ||
      payload?.phone ||
      payload?.from ||
      payload?.contato?.telefone ||
      payload?.contact?.phone ||
      "";

    if (!cpf && !telefone) {
      return responderFlow(res, "Para eu enviar sua 2ª via, me diga seu CPF (somente números). 😊");
    }

    const result = await buscarBoleto({ cpf, telefone });

    if (!result.boleto && !result.linha_digitavel) {
      return responderFlow(
        res,
        "Não encontrei um boleto agora. Me confirme seu CPF (somente números) para eu localizar certinho. 😊"
      );
    }

    let msg = "Aqui está sua 2ª via do boleto 😊\n\n";
    if (result.linha_digitavel) msg += `Linha digitável:\n${result.linha_digitavel}\n\n`;
    if (result.boleto) msg += `Link:\n${result.boleto}`;

    return responderFlow(res, msg, {
      boleto: result.boleto,
      linha_digitavel: result.linha_digitavel,
    });
  } catch (err) {
    console.error("[FLOW] Erro:", err?.response?.data || err?.message || err);
    return responderFlow(res, "Tive um erro ao buscar seu boleto. Tente novamente em 1 minuto. 🙏");
  }
});

app.listen(PORT, () => {
  console.log(`[OK] Server rodando na porta ${PORT}`);
  console.log(`[OK] Health: /health`);
  console.log(`[OK] Boleto: POST /boleto`);
  console.log(`[OK] Webhook: POST /webhook`);
  console.log(`[OK] Flow: GET/POST /flow`);
});
