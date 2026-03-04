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
 * ENV (Render)
 * PAGSCHOOL_BASE_URL=https://sistema.pagschool.com.br/prod
 * PAGSCHOOL_EMAIL=seu_email
 * PAGSCHOOL_PASSWORD=sua_senha
 * PAGSCHOOL_AUTH_TYPE=bearer
 */
const PORT = process.env.PORT || 3000;

const PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";
const PAGSCHOOL_AUTH_TYPE = (process.env.PAGSCHOOL_AUTH_TYPE || "bearer").toLowerCase();

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL)
    throw new Error("PAGSCHOOL_BASE_URL não configurado (ex: https://sistema.pagschool.com.br/prod)");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

// Cache simples do token
let tokenCache = { token: "", codigoEscola: "", exp: 0 };

const api = axios.create({ timeout: 20000 });

// Monta header de auth
function authHeaders(token) {
  if (!token) return {};
  if (PAGSCHOOL_AUTH_TYPE === "bearer") return { Authorization: `Bearer ${token}` };
  return { Authorization: token };
}

async function authenticate() {
  mustHaveEnv();

  const now = Date.now();
  if (tokenCache.token && tokenCache.exp > now) {
    return { token: tokenCache.token, codigoEscola: tokenCache.codigoEscola, cached: true };
  }

  const url = `${PAGSCHOOL_BASE_URL}/api/authenticate`;
  const payload = { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD };

  const resp = await api.post(url, payload);
  const data = resp.data || {};

  // ✅ LOG PRA DESCOBRIR O CAMPO DO codigoEscola
  console.log("[PAGSCHOOL AUTH RAW RESPONSE]", JSON.stringify(data));

  const token =
    data.token ||
    data.accessToken ||
    data.access_token ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.data?.access_token;

  // ✅ Tentativas extras pra pegar codigoEscola com nomes diferentes
  const codigoEscola =
    data.codigoEscola ||
    data.codigo_escola ||
    data.codigo ||
    data.schoolCode ||
    data.codigoCliente ||
    data?.data?.codigoEscola ||
    data?.data?.codigo_escola ||
    data?.data?.codigo ||
    data?.data?.schoolCode ||
    data?.user?.codigoEscola ||
    data?.user?.codigo ||
    data?.usuario?.codigoEscola ||
    data?.usuario?.codigo;

  if (!token) {
    throw new Error(`Authenticate OK, mas não achei o token na resposta. Resposta: ${JSON.stringify(data)}`);
  }

  tokenCache = {
    token,
    codigoEscola: codigoEscola ? String(codigoEscola) : "",
    exp: now + 15 * 60 * 1000, // 15 min
  };

  return { token, codigoEscola: tokenCache.codigoEscola, cached: false };
}

/**
 * ROTAS BASE
 */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", uptime: process.uptime() });
});

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * WEBHOOK (PagSchool -> você)
 * Cadastre essa URL no suporte da i9:
 * https://SEU-SERVICO.onrender.com/webhook
 */
app.post("/webhook", (req, res) => {
  console.log("[WEBHOOK] recebido:", JSON.stringify(req.body || {}));
  return res.status(200).json({ received: true });
});

/**
 * AUTH (POST - correto)
 */
app.post("/pagschool/auth", async (req, res) => {
  try {
    const auth = await authenticate();
    return res.json({ ok: true, ...auth });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[AUTH ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({
      ok: false,
      error: err.message,
      details: err?.response?.data ?? null,
    });
  }
});

/**
 * AUTH (GET - pra testar no navegador)
 */
app.get("/pagschool/auth", async (req, res) => {
  try {
    const auth = await authenticate();
    return res.json({ ok: true, ...auth });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[AUTH ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({
      ok: false,
      error: err.message,
      details: err?.response?.data ?? null,
    });
  }
});

/**
 * CRIAR ALUNO
 * POST /pagschool/aluno/new
 */
app.post("/pagschool/aluno/new", async (req, res) => {
  try {
    const { token } = await authenticate();
    const url = `${PAGSCHOOL_BASE_URL}/api/aluno/new`;

    const body = req.body || {};
    if (body.cpf) body.cpf = onlyDigits(body.cpf);
    if (body.telefoneCelular) body.telefoneCelular = onlyDigits(body.telefoneCelular);
    if (body.telefoneCelularResponsavel) body.telefoneCelularResponsavel = onlyDigits(body.telefoneCelularResponsavel);
    if (body.cpfResponsavel) body.cpfResponsavel = onlyDigits(body.cpfResponsavel);
    if (body.cep) body.cep = onlyDigits(body.cep);

    const resp = await api.post(url, body, { headers: authHeaders(token) });
    return res.json({ ok: true, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[ALUNO ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({
      ok: false,
      error: err.message,
      details: err?.response?.data ?? null,
    });
  }
});

/**
 * CRIAR CONTRATO
 * POST /pagschool/contrato/create
 */
app.post("/pagschool/contrato/create", async (req, res) => {
  try {
    const { token } = await authenticate();
    const url = `${PAGSCHOOL_BASE_URL}/api/contrato/create`;

    const resp = await api.post(url, req.body || {}, { headers: authHeaders(token) });
    return res.json({ ok: true, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[CONTRATO ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({
      ok: false,
      error: err.message,
      details: err?.response?.data ?? null,
    });
  }
});

/**
 * CONTA VIRTUAL (INFO)
 * GET /pagschool/conta-virtual/account-info
 */
app.get("/pagschool/conta-virtual/account-info", async (req, res) => {
  try {
    const { token, codigoEscola } = await authenticate();

    if (!codigoEscola) {
      return res.status(400).json({
        ok: false,
        error:
          "codigoEscola veio vazio na autenticação. Veja os logs: [PAGSCHOOL AUTH RAW RESPONSE] para identificar o campo correto.",
      });
    }

    const url = `${PAGSCHOOL_BASE_URL}/api/conta-virtual/account-info/${encodeURIComponent(codigoEscola)}`;
    const resp = await api.get(url, { headers: authHeaders(token) });

    return res.json({ ok: true, codigoEscola, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[CONTA VIRTUAL ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({
      ok: false,
      error: err.message,
      details: err?.response?.data ?? null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
  console.log(`PAGSCHOOL_BASE_URL = ${PAGSCHOOL_BASE_URL}`);
  console.log("🚀 BUILD_MARKER = GET_AUTH_ENABLED_v3");
});
