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

const PORT = process.env.PORT || 3000;

// BASE: https://sistema.pagschool.com.br/prod
const PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";

// Cache simples do token
let tokenCache = { token: "", exp: 0 };

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL) throw new Error("PAGSCHOOL_BASE_URL não configurado");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

// Pagschool exige Content-type application/json (doc)
function baseHeaders(jwtToken) {
  const h = { "Content-Type": "application/json" };
  if (jwtToken) h["Authorization"] = `JWT ${jwtToken}`; // doc: Authorization: JWT <token>
  return h;
}

async function getJwtToken() {
  mustHaveEnv();

  const now = Date.now();
  if (tokenCache.token && tokenCache.exp > now) return tokenCache.token;

  // POST - {{endpoint}}/api/authenticate
  const url = `${PAGSCHOOL_BASE_URL}/api/authenticate`;
  const { data } = await axios.post(
    url,
    { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    { headers: baseHeaders(), timeout: 20000 }
  );

  if (!data?.token) throw new Error("Autenticação não retornou token");

  // JWT costuma durar um tempo; cache por 50 min
  tokenCache = { token: data.token, exp: now + 50 * 60 * 1000 };
  return data.token;
}

async function apiGet(path, params = {}) {
  const token = await getJwtToken();
  const url = `${PAGSCHOOL_BASE_URL}${path}`;
  const { data } = await axios.get(url, {
    headers: baseHeaders(token),
    params,
    timeout: 20000,
  });
  return data;
}

async function apiPost(path, body = {}) {
  const token = await getJwtToken();
  const url = `${PAGSCHOOL_BASE_URL}${path}`;
  const { data } = await axios.post(url, body, {
    headers: baseHeaders(token),
    timeout: 20000,
  });
  return data;
}

async function buscarAlunoPorCpf(cpf) {
  // GET - {{endpoint}}/api/aluno/all?cpf=...
  const data = await apiGet("/api/aluno/all", { cpf: onlyDigits(cpf), limit: 1, offset: 0 });
  const aluno = Array.isArray(data?.rows) ? data.rows[0] : null;
  if (!aluno?.id) return null;
  return aluno;
}

function escolherParcelaEmAberto(contratos) {
  // pega 1ª parcela que NÃO esteja PAGO
  for (const c of contratos || []) {
    const parcelas = c?.parcelas || [];
    for (const p of parcelas) {
      const status = String(p?.status || "").toUpperCase();
      if (status && status !== "PAGO") return { contrato: c, parcela: p };
    }
  }
  return null;
}

async function gerarBoletoSePrecisa(parcelaId) {
  // POST - {{endpoint}}/api/parcelas-contrato/gerar-boleto-parcela/:parcelaId
  return apiPost(`/api/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`, {});
}

function montarLinkPdfParcela(parcelaId, nossoNumero) {
  // {{endpoint}}/api/parcelas-contrato/pdf/:parcelaId/:nossoNumero
  return `${PAGSCHOOL_BASE_URL}/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`;
}

/**
 * HEALTH
 */
app.get(["/", "/health"], (req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

/**
 * WEBHOOK PAGSCHOOL (eventos) - continua igual
 */
app.get("/webhook", (req, res) => res.status(200).send("Webhook ativo ✅"));
app.post("/webhook", (req, res) => {
  console.log("[PAGSCHOOL] Webhook recebido:", JSON.stringify(req.body));
  return res.status(200).json({ ok: true });
});

/**
 * FLOW (FacilitaFlow)
 * Configure no FacilitaFlow: https://pagschool-boleto-bot-1.onrender.com/flow
 */
function responderFlow(res, msg, extra = {}) {
  return res.status(200).json({ ok: true, reply: msg, message: msg, text: msg, ...extra });
}

app.all("/flow", async (req, res) => {
  try {
    console.log("[FLOW] method:", req.method);
    console.log("[FLOW] query:", JSON.stringify(req.query));
    console.log("[FLOW] body:", JSON.stringify(req.body));

    const payload = req.method === "GET" ? req.query : req.body;

    // o mais confiável: CPF
    const cpf = payload?.cpf || payload?.documento || payload?.document || "";

    if (!cpf) {
      return responderFlow(res, "Para eu te enviar a 2ª via, me mande seu CPF (somente números). 😊");
    }

    const aluno = await buscarAlunoPorCpf(cpf);
    if (!aluno) {
      return responderFlow(res, "Não encontrei aluno com esse CPF. Confere se digitou certinho (11 números). 🙏");
    }

    // GET - {{endpoint}}/api/contrato/by-aluno/:alunoId
    const contratos = await apiGet(`/api/contrato/by-aluno/${aluno.id}`);

    const escolhido = escolherParcelaEmAberto(contratos);
    if (!escolhido?.parcela?.id) {
      return responderFlow(res, "Não achei parcelas em aberto para esse CPF. ✅");
    }

    const parcelaId = escolhido.parcela.id;

    // Se já tiver nossoNumero, dá pra montar o PDF direto.
    // Se não tiver, gera boleto e pega nossoNumero.
    let nossoNumero = escolhido.parcela?.nossoNumero;
    let numeroBoleto = escolhido.parcela?.numeroBoleto;

    if (!nossoNumero) {
      const parcelaGerada = await gerarBoletoSePrecisa(parcelaId);
      nossoNumero = parcelaGerada?.nossoNumero;
      numeroBoleto = parcelaGerada?.numeroBoleto || numeroBoleto;
    }

    if (!nossoNumero) {
      return responderFlow(
        res,
        "Consegui localizar sua parcela, mas não consegui gerar o boleto agora. Tente novamente em 1 minuto. 🙏"
      );
    }

    const linkPdf = montarLinkPdfParcela(parcelaId, nossoNumero);

    let msg = "Aqui está sua 2ª via do boleto 😊\n\n";
    if (numeroBoleto) msg += `Linha digitável:\n${numeroBoleto}\n\n`;
    msg += `PDF:\n${linkPdf}`;

    return responderFlow(res, msg, { parcelaId, nossoNumero, pdf: linkPdf, linha_digitavel: numeroBoleto || "" });
  } catch (err) {
    console.error("[FLOW] Erro:", err?.response?.data || err?.message || err);
    return responderFlow(res, "Tive um erro ao buscar seu boleto. Tente novamente em 1 minuto. 🙏");
  }
});

app.listen(PORT, () => {
  console.log(`[OK] Server rodando na porta ${PORT}`);
  console.log(`[OK] Health: /health`);
  console.log(`[OK] Webhook: POST /webhook`);
  console.log(`[OK] Flow: GET/POST /flow`);
});
